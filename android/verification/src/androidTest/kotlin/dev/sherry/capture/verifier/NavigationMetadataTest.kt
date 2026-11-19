package dev.sherry.capture.verifier

import android.app.UiAutomation
import android.app.KeyguardManager
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.os.Bundle
import android.util.AtomicFile
import android.view.accessibility.AccessibilityNodeInfo
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in, separate-process metadata trace. Never accesses Sherry's store or changes its controls. */
class NavigationMetadataTest {
    @Test fun recordControlledNavigation() {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val args=InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("sherry.trace")=="true")
        val run=args.getString("sherry.run") ?: error("A controlled test run label is required")
        val policy=TraceRedaction(run)
        val context=instrumentation.targetContext
        assertEquals("dev.sherry.capture.verifier",context.packageName)
        val automation=instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        automation.serviceInfo=automation.serviceInfo.apply {
            eventTypes=android.view.accessibility.AccessibilityEvent.TYPES_ALL_MASK
            flags=flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            packageNames=arrayOf("com.openai.chatgpt")
            notificationTimeout=50
        }
        val output=AtomicFile(File(context.filesDir,"navigation-trace.json"))
        val stop=File(context.filesDir,"trace-stop").also { it.delete() }
        val events=mutableListOf<JSONObject>()
        val snapshots=ArrayDeque<JSONObject>()
        val provider="com.openai.chatgpt"
        val version=context.packageManager.getPackageInfo(provider,0).versionName.orEmpty()
        val start=SystemClock.elapsedRealtime()
        fun pid():String=ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand("pidof dev.sherry.capture"))
            .bufferedReader().use { it.readText().trim().takeIf { text->text.matches(Regex("[0-9 ]{1,60}")) }.orEmpty() }
        val beforePid=pid()
        var samples=0;var targetSamples=0;var lastSignature=""
        var snapshotBytes=0
        val sizes=ArrayDeque<Int>()
        var commandSequence=0
        var controlledChat=false
        var titleEditing=false
        var preparedPrompt=false
        fun executeCommand() {
            if(args.getString("sherry.control")!="true")return
            val file=File(context.filesDir,"trace-command.json")
            if(!file.exists()||file.length()>4096)return
            val command=runCatching{JSONObject(file.readText())}.getOrNull() ?: return
            val sequence=command.optInt("sequence")
            if(sequence<=commandSequence||command.optString("run")!=run)return
            commandSequence=sequence
            val action=command.optString("action");val label=command.optString("label")
            val result=JSONObject().put("sequence",sequence).put("action",action)
            try {
                check(!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked){"locked"}
                val root=automation.rootInActiveWindow ?: error("No source window")
                try {
                    check(root.packageName?.toString()==provider){"Wrong source"}
                    val found=mutableListOf<AccessibilityNodeInfo>();var visited=0
                    fun find(n:AccessibilityNodeInfo,predicate:(AccessibilityNodeInfo)->Boolean) {
                        if(++visited>1600)return
                        if(n.isVisibleToUser&&predicate(n)){
                            @Suppress("DEPRECATION") found.add(AccessibilityNodeInfo.obtain(n))
                        }
                        if(!n.isEditable&&!n.isPassword)for(i in 0 until n.childCount.coerceAtMost(100)){
                            val c=n.getChild(i) ?: continue
                            try{find(c,predicate)}finally{@Suppress("DEPRECATION") c.recycle()}
                        }
                    }
                    try {
                        when(action) {
                            "set_prompt","set_title"->{
                                check(label.length==1&&label in "ABCDE")
                                if(action=="set_title")check(controlledChat&&titleEditing)
                                if(action=="set_prompt") {
                                    var checked=0
                                    fun has(n:AccessibilityNodeInfo,p:(AccessibilityNodeInfo)->Boolean):Boolean {
                                        if(++checked>1600)return false
                                        if(n.isVisibleToUser&&p(n))return true
                                        if(n.isEditable||n.isPassword)return false
                                        for(i in 0 until n.childCount.coerceAtMost(100)) {
                                            val c=n.getChild(i) ?: continue
                                            try{if(has(c,p))return true}finally{@Suppress("DEPRECATION") c.recycle()}
                                        };return false
                                    }
                                    val ownPrompt=has(root){n->"ABCDE".any{n.text?.toString()==policy.prompt(it.toString())}}
                                    checked=0
                                    val conversation=has(root){it.contentDescription?.toString() in setOf("Read aloud","Reply to ChatGPT","Stop","Stop generating")}
                                    check(if(controlledChat)ownPrompt else !conversation){"Controlled chat or empty home required"}
                                }
                                find(root){it.isEditable&&!it.isPassword}
                                check(found.size==1){"Need one editor"}
                                val editor=found.single()
                                val value=if(action=="set_prompt")policy.prompt(label)else policy.title(label)
                                if(action=="set_prompt")check(editor.text.isNullOrBlank()||editor.text.toString()==value){"Existing draft preserved"}
                                check(editor.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,Bundle().apply{
                                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value)
                                }))
                                if(action=="set_prompt")preparedPrompt=true
                            }
                            "tap_description","tap_text"->{
                                val descriptions=setOf("New chat","Menu","Edit Menu","Send Message","Send")
                                val renameLabels=setOf("Rename","Rename chat","Rename conversation")
                                val saveLabels=setOf("Save","Save changes","Done")
                                val textLabels=renameLabels+saveLabels+setOf("Cancel")+"ABCDE".map{policy.title(it.toString())}
                                check(if(action=="tap_description")label in descriptions else label in textLabels)
                                if(label in renameLabels)check(controlledChat)
                                if(label in saveLabels+"Cancel")check(controlledChat&&titleEditing)
                                if(label=="New chat"){
                                    find(root){it.isEditable&&!it.isPassword&&!it.text.isNullOrBlank()}
                                    check(found.isEmpty()){"Existing draft preserved"};visited=0
                                }
                                if(label in setOf("Send Message","Send")){
                                    check(preparedPrompt){"Only a prepared controlled prompt can be sent"}
                                    find(root){it.isEditable&&!it.isPassword&&"ABCDE".any{c->it.text?.toString()==policy.prompt(c.toString())}}
                                    check(found.size==1){"Only the controlled prompt can be sent"}
                                    found.forEach{@Suppress("DEPRECATION") it.recycle()};found.clear();visited=0
                                }
                                find(root){if(action=="tap_description")it.contentDescription?.toString()==label else it.text?.toString()==label}
                                result.put("matchingControls",found.size)
                                check(found.size==1){"Need one exact control"}
                                val rect=Rect().also(found.single()::getBoundsInScreen)
                                check(rect.width()>0&&rect.height()>0)
                                // The label is a non-clickable child in the real trace.
                                // Invoke its nearest bounded clickable ancestor's semantic action.
                                @Suppress("DEPRECATION") var target:AccessibilityNodeInfo?=AccessibilityNodeInfo.obtain(found.single())
                                var clicked=false;var depth=0
                                try {
                                    while(target!=null&&depth++<8) {
                                        val current=target!!;val bounds=Rect().also(current::getBoundsInScreen)
                                        if(current.packageName?.toString()!=provider||current.isEditable||current.isPassword)break
                                        if(current.isClickable&&current.isVisibleToUser&&bounds.contains(rect)&&
                                            bounds.width()<=rect.width()*4&&bounds.height()<=rect.height()*4) {
                                            clicked=current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                                            if(clicked)result.put("interaction","accessibility_action")
                                            break
                                        }
                                        val parent=current.parent
                                        @Suppress("DEPRECATION") current.recycle();target=parent
                                    }
                                }finally{@Suppress("DEPRECATION") target?.recycle()}
                                if(!clicked) {
                                    val time=SystemClock.uptimeMillis()
                                    val down=MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,rect.exactCenterX(),rect.exactCenterY(),0)
                                    try{down.source=InputDevice.SOURCE_TOUCHSCREEN;check(automation.injectInputEvent(down,true))}finally{down.recycle()}
                                    SystemClock.sleep(80)
                                    val up=MotionEvent.obtain(time,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,rect.exactCenterX(),rect.exactCenterY(),0)
                                    try{up.source=InputDevice.SOURCE_TOUCHSCREEN;check(automation.injectInputEvent(up,true))}finally{up.recycle()}
                                    result.put("interaction","timed_tap")
                                }
                                if(label=="New chat"){controlledChat=false;preparedPrompt=false}
                                if(label in setOf("Send Message","Send")){controlledChat=true;preparedPrompt=false}
                                if(action=="tap_text"&&label in "ABCDE".map{policy.title(it.toString())})controlledChat=true
                                if(label in renameLabels)titleEditing=true
                                if(label in saveLabels+"Cancel")titleEditing=false
                            }
                            else->error("Unsupported command")
                        }
                        result.put("ok",true)
                    }finally{found.forEach{@Suppress("DEPRECATION") it.recycle()}}
                }finally{@Suppress("DEPRECATION") root.recycle()}
            }catch(e:Exception){
                val safeReasons=setOf("locked","Wrong source","Need one editor","Controlled chat or empty home required",
                    "Existing draft preserved","Only a prepared controlled prompt can be sent","Only the controlled prompt can be sent","Need one exact control")
                result.put("ok",false).put("errorType",e.javaClass.simpleName)
                    .put("errorCode",e.message?.takeIf{it in safeReasons}?:"guard_or_action_failed")
            }
            val out=AtomicFile(File(context.filesDir,"trace-command-result.json"));val stream=out.startWrite()
            try{stream.write(result.toString().toByteArray());out.finishWrite(stream)}catch(e:Exception){out.failWrite(stream);throw e}
        }
        fun metadata(n:AccessibilityNodeInfo):JSONObject {
            val privateField=n.isEditable||n.isPassword||n.className?.toString()=="android.widget.EditText"
            val b=Rect().also(n::getBoundsInScreen)
            val text=if(privateField)"" else n.text?.toString().orEmpty()
            val description=if(privateField)"" else n.contentDescription?.toString().orEmpty()
            val out=JSONObject().put("packageName",n.packageName?.toString()).put("className",n.className?.toString())
                .put("text",policy.text(text,privateField)).put("description",policy.text(description,privateField))
                .put("textHash",policy.identifier(text,privateField)).put("descriptionHash",policy.identifier(description,privateField))
                .put("textLength",text.length).put("viewIdHash",policy.identifier(n.viewIdResourceName,privateField))
                .put("uniqueIdHash",if(Build.VERSION.SDK_INT>=33)policy.identifier(n.uniqueId,privateField)else null)
                .put("visible",n.isVisibleToUser).put("clickable",n.isClickable).put("editable",privateField)
                .put("password",n.isPassword).put("selected",n.isSelected).put("checkable",n.isCheckable)
                .put("checked",n.isChecked).put("scrollable",n.isScrollable).put("windowId",n.windowId)
                .put("left",b.left).put("top",b.top).put("right",b.right).put("bottom",b.bottom)
            if(!privateField) {
                val extras=JSONArray()
                n.extras.keySet().sorted().take(20).forEach { key->
                    @Suppress("DEPRECATION") val value=n.extras.get(key)
                    extras.put(JSONObject().put("key","[redacted]")
                        .put("keyHash",policy.identifier(key)).put("type",value?.javaClass?.name)
                        .put("valueHash",if(value is String||value is CharSequence||value is Number||value is Boolean)policy.identifier(value.toString())else null))
                }
                out.put("extras",extras)
                n.collectionItemInfo?.let { out.put("row",it.rowIndex).put("column",it.columnIndex) }
            }
            return out
        }
        automation.setOnAccessibilityEventListener { event->
            if(event.packageName?.toString()==provider) {
                val source=event.source
                val privateSource=source?.let{it.isEditable||it.isPassword||it.className?.toString()=="android.widget.EditText"} ?: false
                val data=try { JSONObject().put("elapsedMs",SystemClock.elapsedRealtime()-start).put("type",event.eventType)
                    .put("description",policy.text(event.contentDescription?.toString().orEmpty(),privateSource))
                    .put("descriptionHash",policy.identifier(event.contentDescription?.toString(),privateSource))
                    .put("source",source?.let(::metadata)) } finally { @Suppress("DEPRECATION") source?.recycle() }
                synchronized(events){events.add(data);if(events.size>400)events.removeAt(0)}
            }
        }
        fun persist() {
            val data=JSONObject().put("run",run).put("provider",provider).put("appVersion",version)
                .put("testHost",context.packageName).put("doesNotSuppressServices",true)
                .put("capturePidBefore",beforePid).put("capturePidNow",pid()).put("samples",samples).put("targetSamples",targetSamples)
                .put("snapshots",JSONArray(snapshots.toList())).put("events",synchronized(events){JSONArray(events.toList())})
            val bytes=data.toString().toByteArray(Charsets.UTF_8)
            require(bytes.size<=8_000_000){"Trace output limit reached"}
            val stream=output.startWrite()
            try{stream.write(bytes);output.finishWrite(stream)}catch(e:Exception){output.failWrite(stream);throw e}
        }
        val duration=(args.getString("sherry.seconds")?.toLongOrNull() ?: 90).coerceIn(10,180)*1000
        try {
            while(SystemClock.elapsedRealtime()-start<duration&&!stop.exists()) {
                executeCommand()
                samples++
                val root=automation.rootInActiveWindow
                try {
                    if(root?.packageName?.toString()==provider) {
                        targetSamples++;var count=0;var complete=true
                        val deadline=SystemClock.elapsedRealtime()+2000
                        fun walk(n:AccessibilityNodeInfo,depth:Int):JSONObject {
                            if(++count>1600||depth>96||SystemClock.elapsedRealtime()>deadline){complete=false;return JSONObject().put("limit",true)}
                            val data=metadata(n);val children=JSONArray()
                            if(!n.isEditable&&!n.isPassword&&n.className?.toString()!="android.widget.EditText") {
                                if(n.childCount>100)complete=false
                                for(i in 0 until n.childCount.coerceAtMost(100)) {
                                    if(!complete)break
                                    val child=n.getChild(i) ?: continue
                                    try{children.put(walk(child,depth+1))}finally{@Suppress("DEPRECATION") child.recycle()}
                                }
                            }
                            return data.put("children",children)
                        }
                        val tree=walk(root,0)
                        val signature=policy.identifier(tree.toString()).orEmpty()
                        if(signature!=lastSignature){
                            lastSignature=signature
                            val snapshot=JSONObject().put("elapsedMs",SystemClock.elapsedRealtime()-start).put("nodes",count).put("complete",complete).put("root",tree)
                            snapshots.addLast(snapshot)
                            val bytes=snapshot.toString().toByteArray(Charsets.UTF_8).size
                            sizes.addLast(bytes);snapshotBytes+=bytes
                            while(snapshots.size>32||snapshotBytes>6_000_000){snapshots.removeFirst();snapshotBytes-=sizes.removeFirst()}
                            persist()
                        }
                    }
                }finally{@Suppress("DEPRECATION") root?.recycle()}
                SystemClock.sleep(350)
            }
            persist()
            assertTrue("Open the controlled test provider during the trace",targetSamples>0)
        }finally{automation.setOnAccessibilityEventListener(null);stop.delete()}
    }
}
