package dev.sherry.capture

import android.app.Application
import android.content.ContextWrapper
import dev.sherry.capture.core.*
import java.io.File
import java.util.UUID
import javax.crypto.KeyGenerator
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34],application=Application::class)
class AutomaticCaptureEngineTest {
    private val at="2026-10-27T17:00:00Z"
    private val version="1.2026.293"
    private val key=KeyGenerator.getInstance("AES").apply{init(256)}.generateKey()
    private fun context():ContextWrapper {
        val base=RuntimeEnvironment.getApplication();val dir=File(base.noBackupFilesDir,"engine-${UUID.randomUUID()}").apply{mkdirs()}
        return object:ContextWrapper(base){override fun getNoBackupFilesDir():File=dir}
    }
    private fun fixture(home:Boolean=false,name:String?=null):ScreenNode {
        val suffix=if(home)"-home"else "-pixel"
        val json=CaptureJson.parseToJsonElement(File("../core/src/test/resources/fixtures/"+(name?:"chatgpt-$version$suffix-redacted")+".json").readText()).jsonObject
        fun node(v:JsonObject):ScreenNode {
            fun s(k:String)=v[k]?.jsonPrimitive?.contentOrNull.orEmpty()
            fun b(k:String)=v[k]?.jsonPrimitive?.booleanOrNull?:false
            fun n(k:String)=v[k]?.jsonPrimitive?.intOrNull?:0
            return ScreenNode(packageName=s("packageName"),className=s("className"),text=s("text"),description=s("description"),
                clickable=b("clickable"),editable=b("editable"),password=b("password"),visible=b("visible"),scrollable=b("scrollable"),
                selected=b("selected"),checked=b("checked"),left=n("left"),top=n("top"),right=n("right"),bottom=n("bottom"),
                children=v.getValue("children").jsonArray.map{node(it.jsonObject)})
        };return node(json)
    }
    private fun map(n:ScreenNode,f:(ScreenNode)->ScreenNode):ScreenNode=f(n.copy(children=n.children.map{map(it,f)}))
    private fun pair(label:String):ScreenNode=map(fixture()){n->
        when(n.text){
            "Sherry Android layout check A. Reply with exactly: amber notebook."->n.copy(text="Invented engine question $label")
            "amber notebook."->n.copy(text="Invented engine answer $label")
            else->n
        }
    }
    private fun rows(root:ScreenNode)=root.descendants().single { node->node.children.count { row->
        row.descendants().any{it.text.startsWith("Invented engine ")}
    }==2 }.children
    private fun window(vararg sourceRows:ScreenNode):ScreenNode {
        val root=pair("A")
        return map(root){node->if(node.children.count{row->row.descendants().any{it.text.startsWith("Invented engine ")}}==2)
            node.copy(children=sourceRows.toList())else node}
    }
    private fun withStop(root:ScreenNode):ScreenNode {
        val actual=fixture(name="chatgpt-$version-thinking-redacted")
        val composer=actual.descendants().filter{n->n.descendants().any{it.editable}&&n.descendants().any{it.description=="Stop"}}
            .minBy{(it.right-it.left).toLong()*(it.bottom-it.top)}
        val target=root.descendants().filter{n->n.descendants().any{it.editable}&&n.descendants().any{it.description=="Reply to ChatGPT"}}
            .minBy{(it.right-it.left).toLong()*(it.bottom-it.top)}
        return map(root){if(it==target)composer else it}
    }
    private fun ready(store:CaptureStore) {store.proof(Provider.CHATGPT,true);store.captureEnabled(true)}
    private fun settled(engine:AutomaticCaptureEngine,root:ScreenNode,ms:Long):AutomaticCaptureStep {
        engine.observe(root,version,ms,at);return engine.observe(root,version,ms+800,at)
    }
    @Test fun oneValidPostedUserReadIsDurableEvenIfTheOwnerImmediatelyLeavesChatGPT() {
        val ctx=context();val store=CaptureStore(ctx,key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        engine.observe(fixture(name="chatgpt-$version-thinking-redacted"),version,100,at)
        engine.observe(null,version,120,at)
        val restored=CaptureStore(ctx,key)
        assertEquals(1,restored.state.value.pendingNativeObservations.size)
        val retained=restored.state.value.pendingNativeObservations.single()
        assertTrue(retained.awaitingReply);assertEquals(listOf("user"),retained.messages.map{it.role})
        assertEquals("Sherry reliability oct28nav01 A. Reply with exactly: amber notebook.",retained.messages.single().text)
        assertTrue(restored.state.value.captures.isEmpty())
        restored.reconcileRetainedObservations();assertTrue(restored.state.value.captures.isEmpty())
    }
    @Test fun matchingFinishedReadsSaveWithinTwoHundredMillisecondsBeforeAQuickExitWithoutDuplicates() {
        val ctx=context();val store=CaptureStore(ctx,key);ready(store);val engine=AutomaticCaptureEngine(store)
        val done=fixture(name="chatgpt-$version-complete-reply-redacted")
        engine.observe(fixture(true),version,0,at)
        assertEquals(0,engine.observe(done,version,100,at).added)
        assertTrue(store.state.value.captures.isEmpty())
        assertEquals(0,engine.observe(done,version,200,at).added)
        assertEquals(2,engine.observe(done,version,300,at).added)
        val ids=store.state.value.captures.map{it.id}
        engine.observe(null,version,310,at)
        val restored=CaptureStore(ctx,key);val resumed=AutomaticCaptureEngine(restored)
        resumed.observe(done,version,500,at)
        assertEquals(0,resumed.observe(done,version,700,at).added)
        assertEquals(ids,restored.state.value.captures.map{it.id});assertEquals(1,restored.state.value.nativeSessions.size)
    }
    @Test fun fastConfirmationRestartsAfterStreamingAndNeverSavesThePartialAssistantReply() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        val prefix=fixture(name="chatgpt-$version-thinking-redacted")
        val partial=fixture(name="chatgpt-$version-streamed-reply-redacted")
        val done=fixture(name="chatgpt-$version-complete-reply-redacted")
        engine.observe(fixture(true),version,0,at)
        engine.observe(prefix,version,100,at);engine.observe(partial,version,200,at)
        assertTrue(store.state.value.captures.isEmpty())
        assertTrue(store.state.value.pendingNativeObservations.all{it.messages.all{m->m.role=="user"}})
        engine.observe(done,version,300,at)
        engine.observe(partial,version,400,at)
        engine.observe(done,version,500,at)
        assertEquals(0,engine.observe(done,version,600,at).added)
        assertEquals(2,engine.observe(done,version,700,at).added)
        assertEquals(listOf("user","assistant"),store.state.value.captures.map{it.event.role})
        assertEquals("amber notebook.",store.state.value.captures.last().event.text)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
    }

    @Test fun actualHistoryMenuStartsOneVisitAndReturnsToTheCorrectKnownChat() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val first=store.state.value.automaticContext!!.sessionId
        val firstIds=store.state.value.captures.map{it.id}
        engine.observe(fixture(true),version,3000,at);settled(engine,pair("B"),4000)
        val second=store.state.value.automaticContext!!.sessionId
        assertNotEquals(first,second)
        val menu=fixture(name="chatgpt-$version-history-menu-redacted")
        engine.observe(menu,version,6000,at)
        val visit=store.state.value.automaticContext!!
        assertEquals(NativeNavigation.HISTORY,visit.navigation);assertNull(visit.sessionId)
        engine.observe(menu,version,7000,at)
        assertEquals(visit.id,store.state.value.automaticContext!!.id)
        assertEquals(0,settled(engine,pair("A"),8000).added)
        assertEquals(first,store.state.value.automaticContext!!.sessionId)
        assertEquals(firstIds,store.state.value.captures.take(2).map{it.id})
        val continued=window(rows(pair("A")).last(),*rows(pair("C")).toTypedArray())
        assertEquals(2,settled(engine,continued,10000).added)
        assertEquals(first,store.state.value.currentNativeSessionId)
        assertEquals(2,store.state.value.nativeSessions.size)
        assertEquals(4,store.state.value.nativeSessions.single{it.id==first}.turns.size)
        assertEquals(2,store.state.value.nativeSessions.single{it.id==second}.turns.size)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        // Opening and dismissing the menu does not duplicate the same conversation.
        engine.observe(menu,version,12000,at)
        assertNotEquals(visit.id,store.state.value.automaticContext!!.id)
        assertEquals(0,settled(engine,pair("C"),13000).added)
        assertEquals(first,store.state.value.automaticContext!!.sessionId)
        assertEquals(6,store.state.value.captures.size);assertTrue(store.state.value.paused)
    }
    @Test fun historyReturnWithUnknownOrAmbiguousTextRetainsReadsWithoutMixingOrInventingChats() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        engine.observe(fixture(true),version,3000,at);settled(engine,pair("A"),4000)
        val before=store.state.value.nativeSessions
        val menu=fixture(name="chatgpt-$version-history-menu-redacted")
        engine.observe(menu,version,6000,at)
        assertTrue(settled(engine,pair("A"),7000).pending)
        assertNull(store.state.value.automaticContext!!.sessionId)
        engine.observe(menu,version,9000,at)
        assertTrue(settled(engine,pair("B"),10000).pending)
        assertEquals(before,store.state.value.nativeSessions)
        assertEquals(4,store.state.value.captures.size)
        assertEquals(2,store.state.value.pendingNativeObservations.size)
    }
    @Test fun aRetainedHistoryVisitSurvivesAnEncryptedStoreRestartBeforeTheChatLoads() {
        val ctx=context();var store=CaptureStore(ctx,key);ready(store);var engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val first=store.state.value.automaticContext!!.sessionId
        engine.observe(fixture(true),version,3000,at);settled(engine,pair("B"),4000)
        val ids=store.state.value.captures.map{it.id}
        engine.observe(fixture(name="chatgpt-$version-history-menu-redacted"),version,6000,at)
        store=CaptureStore(ctx,key);engine=AutomaticCaptureEngine(store)
        assertEquals(0,settled(engine,pair("A"),7000).added)
        assertEquals(first,store.state.value.automaticContext!!.sessionId)
        assertEquals(ids,store.state.value.captures.map{it.id})
        assertEquals(2,store.state.value.nativeSessions.size)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty());assertTrue(store.state.value.paused)
    }

    @Test fun menuLabelsInMessageTextAndUntrustedMenuFramesCannotResetConversationIdentity() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val before=store.state.value.automaticContext
        val menu=fixture(name="chatgpt-$version-history-menu-redacted")
        val hiddenSearch=map(menu){if(it.description=="Search")it.copy(visible=false)else it}
        val privateSearch=map(menu){if(it.description=="Search")it.copy(editable=true)else it}
        val missingChats=map(menu){if(it.text=="Chats")it.copy(text="")else it}
        for(frame in listOf(hiddenSearch,privateSearch,missingChats)) {
            settled(engine,frame,3000)
            assertEquals(before,store.state.value.automaticContext)
        }
        engine.observe(menu,version,5000,at,complete=false)
        assertEquals(before,store.state.value.automaticContext)
        engine.observe(menu,"",6000,at)
        assertEquals(before,store.state.value.automaticContext)
        engine.observe(menu.copy(packageName="other.app"),version,7000,at)
        assertEquals(before,store.state.value.automaticContext)
        val transcript=map(pair("A")){if(it.text=="Invented engine answer A")it.copy(text="Chats\nSearch\nNew chat")else it}
        settled(engine,transcript,8000)
        assertEquals(before,store.state.value.automaticContext)
    }

    @Test fun firstPostedUserIsRetainedBeforeReplyAndCompletesAfterLeavingAndEncryptedRestart() {
        val ctx=context();var store=CaptureStore(ctx,key);ready(store);var engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        settled(engine,fixture(name="chatgpt-$version-thinking-redacted"),1000)
        assertEquals(1,store.state.value.pendingNativeObservations.size)
        assertEquals("user",store.state.value.pendingNativeObservations.single().messages.single().role)
        assertTrue(store.state.value.captures.isEmpty())
        store.reconcileRetainedObservations()
        assertTrue(store.state.value.captures.isEmpty())
        engine.observe(null,version,2500,at)
        store=CaptureStore(ctx,key);engine=AutomaticCaptureEngine(store)
        assertEquals(2,settled(engine,fixture(name="chatgpt-$version-complete-reply-redacted"),3000).added)
        assertEquals(listOf("user","assistant"),store.state.value.captures.map{it.event.role})
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        assertEquals(0,settled(engine,fixture(name="chatgpt-$version-complete-reply-redacted"),5000).added)
    }

    @Test fun firstUserRetentionKeepsItsObservedTimeAndWorkspaceThroughDisconnect() {
        val ctx=context();val store=CaptureStore(ctx,key)
        val workspace="7c895c18-05e4-4f96-9148-37ad93b2a789"
        store.saveSignedIn(Connection(workspace,"invented-token"));ready(store)
        val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        val first="2026-10-28T13:00:00Z";val later="2026-10-28T13:00:04Z"
        val prefix=fixture(name="chatgpt-$version-thinking-redacted")
        engine.observe(prefix,version,1000,first);engine.observe(prefix,version,1800,first)
        store.disconnect();store.captureEnabled(true)
        val resumed=AutomaticCaptureEngine(store);val complete=fixture(name="chatgpt-$version-complete-reply-redacted")
        resumed.observe(complete,version,3000,later);resumed.observe(complete,version,3800,later)
        assertEquals(first,store.state.value.captures[0].event.capturedAt)
        assertEquals(later,store.state.value.captures[1].event.capturedAt)
        assertTrue(store.state.value.captures.all{CaptureJson.decodeFromString<CaptureBatch>(it.payload!!).workspaceId==workspace})
        assertTrue(store.state.value.pendingNativeObservations.isEmpty());assertTrue(store.state.value.paused)
    }
    @Test fun actualComposerAnimationDoesNotInterruptPostedUserRetention() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        engine.observe(fixture(name="chatgpt-$version-thinking-redacted"),version,4637,at)
        engine.observe(fixture(name="chatgpt-$version-composer-transition-redacted"),version,5601,at)
        assertEquals(1,store.state.value.pendingNativeObservations.size)
        assertEquals("user",store.state.value.pendingNativeObservations.single().messages.single().role)
        assertTrue(store.state.value.captures.isEmpty())
    }
    @Test fun actualEmptyHomeStartsANewVisitOnceAndPreservesTwentyWaitingMessages() {
        val ctx=context();val store=CaptureStore(ctx,key);repeat(20){store.add(CaptureFactory.share(Provider.CHATGPT,"Old waiting $it","Test"))}
        val old=store.state.value.captures;ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        val first=store.state.value.automaticContext!!.id
        engine.observe(fixture(true),version,1000,at)
        assertEquals(first,store.state.value.automaticContext!!.id)
        assertEquals(2,settled(engine,pair("A"),2000).added)
        engine.observe(fixture(true),version,4000,at)
        assertNotEquals(first,store.state.value.automaticContext!!.id)
        assertEquals(2,settled(engine,pair("B"),5000).added)
        assertEquals(old,store.state.value.captures.take(20));assertEquals(24,store.state.value.captures.size)
        assertEquals(2,store.state.value.nativeSessions.size);assertTrue(store.state.value.paused)
    }
    @Test fun eightThenTenTurnsSurviveStreamingAndAnEncryptedRestartWithoutManualSave() {
        val ctx=context();var store=CaptureStore(ctx,key);ready(store);var engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);assertEquals(2,settled(engine,pair("A"),1000).added)
        var ms=3000L
        for((old,next)in listOf("A" to "B","B" to "C","C" to "D")) {
            val source=window(rows(pair(old)).last(),*rows(pair(next)).toTypedArray())
            val streaming=withStop(source)
            engine.observe(streaming,version,ms,at)
            assertEquals(2,settled(engine,source,ms+1000).added);ms+=3000
        }
        assertEquals(8,store.state.value.captures.size)
        val ids=store.state.value.captures.map{it.id}
        store=CaptureStore(ctx,key);engine=AutomaticCaptureEngine(store)
        assertEquals(0,settled(engine,pair("D"),ms).added)
        val last=window(rows(pair("D")).last(),*rows(pair("E")).toTypedArray())
        assertEquals(2,settled(engine,last,ms+2000).added)
        assertEquals(ids,store.state.value.captures.take(8).map{it.id})
        assertEquals(10,store.state.value.captures.size);assertEquals(1,store.state.value.nativeSessions.size)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        assertEquals(0,settled(engine,last,ms+4000).added)
    }
    @Test fun aPreviouslyVerifiedFullTailCanAnchorEvenWhenItsViewMovesPartlyOffscreen() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val source=window(rows(pair("A")).last(),*rows(pair("B")).toTypedArray())
        val edge=map(source){if(it.text=="Invented engine answer A")it.copy(top=-100)else it}
        assertEquals("possibly_clipped",ChatGptParser.parse(edge,version).messages.first().completeness)
        assertEquals(2,settled(engine,edge,3000).added)
        assertEquals(4,store.state.value.captures.size)
    }
    @Test fun aNewClippedReplyIsNotPromotedByTheVerifiedTailRule() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val source=window(rows(pair("A")).last(),*rows(pair("B")).toTypedArray())
        val edge=map(source){if(it.text=="Invented engine answer B")it.copy(top=-100)else it}
        assertEquals(1,settled(engine,edge,3000).added)
        assertFalse(store.state.value.captures.any{it.event.text=="Invented engine answer B"})
        assertEquals(1,settled(engine,source,5000).added)
        assertEquals(4,store.state.value.captures.size)
    }
    @Test fun scrollingBackThroughKnownMessagesDoesNotMistakeAMiddleTurnForTheSavedTail() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        val all=window(*rows(pair("A")).toTypedArray(),*rows(pair("B")).toTypedArray(),*rows(pair("C")).toTypedArray())
        assertEquals(4,settled(engine,all,3000).added)
        settled(engine,pair("B"),5000)
        val older=window(*rows(pair("A")).toTypedArray(),*rows(pair("B")).toTypedArray())
        val step=settled(engine,older,7000)
        assertFalse(step.pending)
        assertEquals(0,step.added)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
    }
    @Test fun severalReadsDuringAFullQueueAreRecoveredInOrderAfterChatGPTCloses() {
        val store=CaptureStore(context(),key)
        repeat(100){store.add(CaptureFactory.share(Provider.CHATGPT,"Old waiting $it","Test"))}
        ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        var ms=3000L
        for((old,next)in listOf("A" to "B","B" to "C","C" to "D")) {
            settled(engine,window(rows(pair(old)).last(),*rows(pair(next)).toTypedArray()),ms);ms+=2000
        }
        store.captureEnabled(false)
        repeat(8){store.committed(store.state.value.captures.first().id)}
        assertEquals(8,store.reconcileRetainedObservations())
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        assertEquals(8,store.state.value.nativeSessions.single().turns.size)
        assertEquals(listOf("A","B","C","D").flatMap{listOf("Invented engine question $it","Invented engine answer $it")},
            store.state.value.captures.takeLast(8).map{it.event.text})
    }
    @Test fun partialQueueDrainKeepsTheMostRecentRetainedReadAsItsContinuityAnchor() {
        val store=CaptureStore(context(),key)
        repeat(100){store.add(CaptureFactory.share(Provider.CHATGPT,"Old waiting $it","Test"))}
        ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        settled(engine,window(rows(pair("A")).last(),*rows(pair("B")).toTypedArray()),3000)
        repeat(2){store.committed(store.state.value.captures.first().id)}
        assertEquals(2,store.reconcileRetainedObservations())
        settled(engine,window(rows(pair("B")).last(),*rows(pair("C")).toTypedArray()),5000)
        store.captureEnabled(false)
        repeat(4){store.committed(store.state.value.captures.first().id)}
        assertEquals(4,store.reconcileRetainedObservations())
        assertEquals(6,store.state.value.nativeSessions.single().turns.size)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
    }
    @Test fun interruptedReadsRecoverOnTheNextSettledSourceRead() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at);settled(engine,pair("A"),1000)
        engine.readFailed()
        val root=window(*rows(pair("A")).toTypedArray(),*rows(pair("B")).toTypedArray())
        assertEquals(2,settled(engine,root,3000).added)
        assertEquals(4,store.state.value.captures.size)
    }
    @Test fun aConversationChangeDuringSourceReadingDoesNotSaveTheEarlierScreenIntoTheNewVisit() {
        val store=CaptureStore(context(),key);ready(store);val engine=AutomaticCaptureEngine(store)
        engine.observe(fixture(true),version,0,at)
        val old=store.state.value.automaticContext!!.id
        store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        engine.observe(pair("A"),version,1000,at,expectedContextId=old)
        engine.observe(pair("A"),version,2000,at,expectedContextId=old)
        assertTrue(store.state.value.captures.isEmpty())
    }
    @Test fun anOffControlNeverCreatesAVisitOrSavesMessages() {
        val store=CaptureStore(context(),key);store.proof(Provider.CHATGPT,true)
        val engine=AutomaticCaptureEngine(store)
        settled(engine,fixture(true),0);settled(engine,pair("A"),1000)
        settled(engine,fixture(name="chatgpt-$version-history-menu-redacted"),3000)
        assertNull(store.state.value.automaticContext);assertTrue(store.state.value.captures.isEmpty())
    }
    @Test fun theTemporaryModeEntryButtonIsNotMistakenForAnActiveTemporaryConversation() {
        val home=fixture(true)
        assertTrue(ChatGptScreenSignals.isEmptyHome(home,true))
        assertFalse(ChatGptScreenSignals.isEmptyHome(map(home){if(it.description=="Temporary chat")it.copy(selected=true)else it},true))
        assertFalse(ChatGptScreenSignals.isEmptyHome(home,false))
        assertFalse(ChatGptScreenSignals.isEmptyHome(home.copy(packageName="other.app"),true))
        assertFalse(ChatGptScreenSignals.isEmptyHome(pair("A"),true))
    }
}
