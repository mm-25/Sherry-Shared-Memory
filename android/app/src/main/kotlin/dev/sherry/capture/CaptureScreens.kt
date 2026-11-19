package dev.sherry.capture

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.sherry.capture.core.Provider

@Composable internal fun CaptureScreen(model:CaptureViewModel,state:CaptureState,permission:Boolean,onPermission:()->Unit) {
    val enabled=state.captureEnabled
    val status by CaptureAccessibilityService.automaticCaptureStatus.collectAsStateWithLifecycle()
    val needsReview=enabled&&status.startsWith("Capture needs review")
    ScreenTitle("Capture on this phone","Choose what Sherry saves from your AI chats.")
    SherryCard(if(enabled)SherryColors.UserBubble else Color.White) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(3.dp)) {
                Text(if(enabled)"Capture is on" else "Capture is paused",fontSize=18.sp,fontWeight=FontWeight.SemiBold)
                SmallCopy(if(enabled&&Provider.CHATGPT !in state.proofProviders)"Choose an app below to begin." else if(enabled&&!permission)"Android access needs attention." else if(enabled)"For the supported apps below." else "No new messages are being saved.")
            }
            SherrySwitch("Capture new messages",enabled,!model.busy&&model.store.storageError==null,true){on->
                if(on&&!permission)onPermission() else model.act{
                    if(on&&state.proofProviders.isEmpty())model.store.proof(Provider.CHATGPT,true)
                    model.store.captureEnabled(on)
                }
            }
        }
        if(enabled)SmallCopy("Use ChatGPT normally. You do not need to keep Sherry open.")
    }
    if(needsReview)CaptureRecoveryCard(enabled=!model.busy,onDifferentChat={model.act{
        model.store.startSeparateNativeSession()
        CaptureAccessibilityService.clearAutomaticIssue()
        model.notice="Separate capture ready. Return to that ChatGPT chat."
    }},onTroubleshooting={model.tool="preview"})
    val waiting=state.captures.size
    when {
        state.connection==null||state.connection.needsReconnect->SherryCard(SherryColors.Warning) {
            Text("$waiting messages waiting",fontSize=21.sp,fontWeight=FontWeight.SemiBold)
            SmallCopy("Saved on this phone. Not yet received by Sherry.",color=SherryColors.WarningText)
            SherryAction(if(state.connection?.needsReconnect==true)"Reconnect Sherry" else "Sign in to Sherry",true){model.tool="account"}
        }
        state.paused->SherryCard(SherryColors.Warning){
            Text("$waiting messages waiting",fontSize=21.sp,fontWeight=FontWeight.SemiBold)
            SmallCopy("Uploads are paused. Capture and your saved messages stay available.",color=SherryColors.WarningText)
            SherryAction("Resume uploads",!needsReview){model.act{model.store.deliveryPaused(false);SyncScheduler.enqueue(model.getApplication())}}
        }
        else->{
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                for((value,label)in listOf(waiting.toString() to "Waiting to upload",state.receivedCount.toString() to "Received by Sherry"))
                    Surface(Modifier.weight(1f),color=SherryColors.Surface,shape=RoundedCornerShape(12.dp)){
                        Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(4.dp)){Text(value,fontSize=27.sp,fontWeight=FontWeight.SemiBold);SmallCopy(label)}
                    }
            }
            SmallCopy(state.lastSync?.let{"Last received by Sherry ${capturedTime(it)}"} ?: "Waiting for the first confirmed upload.")
            SmallCopy("The received count covers uploads confirmed by this app version.")
        }
    }
    if(state.pendingNativeObservations.isNotEmpty())SherryCard(SherryColors.Warning) {
        val awaitingReply=state.pendingNativeObservations.all{it.awaitingReply}
        Text(if(awaitingReply)"Your message is saved on this phone"else "Some messages are still being organized",fontWeight=FontWeight.SemiBold)
        SmallCopy(if(awaitingReply)"Your message is kept here. Upload will follow when Sherry can read the completed reply in ChatGPT."
            else "They are securely saved on this phone while Sherry identifies their conversation. They have not been uploaded yet.",color=SherryColors.WarningText)
    }
    val rejected=state.captures.count{it.status=="rejected"}
    if(rejected>0)SherryCard(SherryColors.Warning){Text("$rejected messages need attention",fontWeight=FontWeight.SemiBold);SmallCopy("Their saved copies are kept on this phone.");SherryAction("Review waiting messages"){model.tool="waiting"}}
    SmallCopy("AI APPS ON THIS PHONE")
    Provider.entries.forEach { provider ->
        val supported=provider==Provider.CHATGPT
        val on=provider in state.proofProviders
        Row(Modifier.fillMaxWidth().heightIn(min=56.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(34.dp).background(SherryColors.Surface,RoundedCornerShape(9.dp)),contentAlignment=Alignment.Center){Text(provider.label.first().toString(),fontSize=14.sp,fontWeight=FontWeight.SemiBold,color=SherryColors.Secondary)}
            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(2.dp)) {
                Text(provider.label,fontSize=14.sp,fontWeight=FontWeight.Medium)
                SmallCopy(if(!supported)"Phone reader not available yet" else if(!permission)"Needs Android Accessibility access" else if(!on)"Reader available · source is off" else if(!enabled)"Reader available · capture paused" else "Ready · ordinary visible chats")
            }
            SherrySwitch("${provider.label} capture",on&&supported,supported&&!model.busy){checked->
                if(checked&&!permission)onPermission()else model.act{model.store.proof(provider,checked)}
            }
        }
    }
    if(!permission)TextButton(onClick=onPermission){Text("Set up Android access")}
    SmallCopy("Pausing capture keeps saved messages. Original message dates may be unknown, and history the AI app has not loaded cannot be recovered.")
    TextButton(onClick={model.tool="support"}){Text("Troubleshooting",fontSize=12.sp)}
}

@Composable internal fun CaptureRecoveryCard(enabled:Boolean,onDifferentChat:()->Unit,onTroubleshooting:()->Unit) {
    SherryCard(SherryColors.Warning){
        Text("Sherry needs help matching this chat",fontSize=18.sp,fontWeight=FontWeight.SemiBold)
        SmallCopy("If this is the same ChatGPT chat, scroll to show earlier messages. If you've switched chats, start a separate capture below.")
        SherryAction("Capture this as a different chat",true,enabled,onDifferentChat)
        TextButton(onClick=onTroubleshooting,enabled=enabled){Text("More troubleshooting",fontSize=12.sp)}
    }
}

@Composable internal fun PermissionSetup(onPermission:()->Unit) {
    ScreenTitle("Let Sherry read your chats","One setup step before automatic capture.")
    SherryCard(SherryColors.UserBubble){Text("Allow Accessibility access",fontSize=18.sp,fontWeight=FontWeight.SemiBold);Text("This Android permission lets Sherry read supported chat text while you use an AI app.")}
    listOf("Open Android Settings" to "Find Sherry in Accessibility settings.","Turn on Sherry access" to "Read Android’s notice and confirm.","Return here to start capture" to "Capture stays paused until you turn it on.").forEachIndexed{i,(title,desc)->
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){Text("${i+1}",fontSize=13.sp,color=SherryColors.PurpleText);Column{Text(title,fontWeight=FontWeight.SemiBold);SmallCopy(desc)}}
    }
    SherryAction("Open Accessibility settings",true,onClick=onPermission)
    SmallCopy("You can turn access off in Android Settings. This does not give AI tools permission to retrieve Sherry memories.")
}

@Composable internal fun TroubleshootingScreen(model:CaptureViewModel,state:CaptureState,permission:Boolean) {
    ScreenTitle("Capture troubleshooting","Use these checks when messages are missing. Your saved messages stay intact.")
    SmallCopy(state.syncMessage)
    SherryCard(SherryColors.Surface){Text("Waiting messages",fontWeight=FontWeight.SemiBold);SmallCopy("${state.captures.size} saved on this phone");SherryAction("Review waiting messages"){model.tool="waiting"}}
    SherryCard(SherryColors.Surface){
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Text("Pause uploads",Modifier.weight(1f),fontWeight=FontWeight.SemiBold);SherrySwitch("Pause uploads",state.paused,!model.busy){paused->model.act{model.store.deliveryPaused(paused);if(paused)SyncScheduler.cancel(model.getApplication())else SyncScheduler.enqueue(model.getApplication())}}}
        SmallCopy("Stops later upload requests. A request already sent may finish. This does not change the capture switch.")
    }
    SherryCard(SherryColors.Surface){
        Text(if(state.captureEnabled)"Automatic capture" else "Preview the reader",fontWeight=FontWeight.SemiBold)
        SmallCopy(if(state.captureEnabled)"Check capture status and recover when Sherry cannot match a chat." else "Reads visible text without saving or uploading that preview. Turn automatic capture off to use this check.")
        SherryAction(if(state.captureEnabled)"Review automatic capture" else "Open reader check",enabled=!model.busy){model.tool=if(permission)"preview" else "setup"}
    }
    SherryCard(SherryColors.Surface){Text("Share an excerpt",fontWeight=FontWeight.SemiBold);SmallCopy("Manually save selected text when automatic capture is unavailable.");SherryAction("Add an excerpt"){model.tool="share"}}
    SherryAction(if(state.connection==null)"Sign in to Sherry" else "Account and connection"){model.tool="account"}
    SmallCopy("Sherry 0.1.10 · Android")
}
