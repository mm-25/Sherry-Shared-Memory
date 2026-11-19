package dev.sherry.capture

import dev.sherry.capture.core.*

data class AutomaticCaptureStep(val status:String,val added:Int=0,val pending:Boolean=false,
    val nextReadAfterMs:Long=500L)

/** One foreground observation actor. Source reading, scheduling and delivery remain in the service. */
class AutomaticCaptureEngine(private val store:CaptureStore) {
    private var homeLatched=false
    private var historyLatched=false
    private var previous:List<ParsedMessage>?=null
    private var since=0L
    private var verified:List<ParsedMessage>?=null
    private var verifiedSession:String?=null
    private var verifiedObservation:String?=null
    private fun clearContinuity() {previous=null;verified=null;verifiedSession=null;verifiedObservation=null}

    /** Only the source adapter may supply a positively observed navigation boundary. */
    fun navigation(navigation:NativeNavigation,expectedContextId:String?=store.state.value.automaticContext?.id) {
        if(!store.state.value.captureEnabled||Provider.CHATGPT !in store.state.value.proofProviders)return
        clearContinuity();store.beginAutomaticVisit(navigation,expectedContextId)
    }
    fun readFailed():AutomaticCaptureStep {
        clearContinuity()
        return AutomaticCaptureStep("ChatGPT could not be read just now. Sherry will retry automatically.",pending=true)
    }
    fun observe(root:ScreenNode?,version:String,elapsedMs:Long,observedAt:String,complete:Boolean=true,expectedContextId:String?=store.state.value.automaticContext?.id):AutomaticCaptureStep {
        val state=store.state.value
        if(!state.captureEnabled||Provider.CHATGPT !in state.proofProviders){clearContinuity();return AutomaticCaptureStep("Automatic capture is off.")}
        if(expectedContextId!=state.automaticContext?.id) {
            clearContinuity()
            return AutomaticCaptureStep("Checking the current ChatGPT screen…",pending=true)
        }
        if(root?.packageName!=Provider.CHATGPT.packageName) {
            clearContinuity();homeLatched=false;historyLatched=false
            return AutomaticCaptureStep("Watching for ChatGPT. Open a conversation to capture new messages.",nextReadAfterMs=1000L)
        }
        if(ChatGptParser.validVersionMetadata(version)&&ChatGptScreenSignals.isHistoryMenu(root,complete)) {
            if(!historyLatched)navigation(NativeNavigation.HISTORY,expectedContextId)
            historyLatched=true;homeLatched=false
            return AutomaticCaptureStep("Choose a ChatGPT conversation. Sherry will check its saved messages before adding more.")
        }
        historyLatched=false
        if(ChatGptScreenSignals.isEmptyHome(root,complete)) {
            if(!homeLatched)navigation(NativeNavigation.NEW_CHAT,expectedContextId)
            homeLatched=true
            return AutomaticCaptureStep("Ready for a new ChatGPT conversation.")
        }
        homeLatched=false
        var read=ChatGptParser.parse(root,version,complete)
        var firstReplyPending=false
        if(!read.recognized) {
            val prefix=ChatGptParser.parseStreamingPrefix(root,version,complete)
            if(prefix.recognized){read=prefix;firstReplyPending=true}
        }
        if(!read.recognized) {
            previous=null
            // Streaming changes the message body, not its conversation. Retain the
            // last verified tail only while the ordinary conversation chrome remains.
            if(!ChatGptScreenSignals.isConversationChrome(root,complete)){verified=null;verifiedSession=null;verifiedObservation=null}
            return AutomaticCaptureStep(read.issue?:"Waiting for readable ChatGPT messages.",pending=true)
        }
        val tail=verified?.lastOrNull()
        val sourceSession=state.automaticContext?.let{it.sessionId?:it.id.takeIf{_->it.navigation==NativeNavigation.NEW_CHAT}}
        val retainedTail=state.pendingNativeObservations.firstOrNull{it.id==verifiedObservation&&it.context.id==state.automaticContext?.id}?.messages?.lastOrNull()
        val savedTail=state.nativeSessions.firstOrNull{it.id==sourceSession}?.turns?.maxByOrNull{it.sequence}
        val tailMatches=tail!=null&&(
            (savedTail!=null&&tail.role==savedTail.role&&CaptureFactory.hash(tail.text)==savedTail.hash)||
            (retainedTail!=null&&tail.role==retainedTail.role&&tail.text==retainedTail.text))
        val trustedTail=sourceSession!=null&&sourceSession==verifiedSession&&tailMatches
        // An identical body already read in full can remain an anchor when its
        // view is partly offscreen. Never promote new clipped message content.
        val anchored=read.messages.mapIndexed{index,message->
            if(index==0&&trustedTail&&message.completeness=="possibly_clipped"&&message.role==tail!!.role&&message.text==tail.text)
                message.copy(completeness=tail.completeness) else message
        }
        val messages=AutomaticWindow.completeTurns(anchored)
        if(messages.isEmpty()) {previous=null;return AutomaticCaptureStep("Waiting for complete visible ChatGPT messages.",pending=true)}
        if(firstReplyPending) {
            // Posted user text is already sent, and this narrow reader excludes
            // the composer and unfinished AI row. Retain it before a quick exit.
            previous=null
            val context=store.ensureAutomaticContext(expectedContextId)
                ?: return AutomaticCaptureStep("Checking the current ChatGPT screen…",pending=true)
            store.saveAutomaticWindow(context.id,messages,version,observedAt,awaitingReply=true)
            return AutomaticCaptureStep("Your posted message is saved on this phone. Waiting for ChatGPT's reply before uploading.",pending=true)
        }
        if(previous!=messages){previous=messages;since=elapsedMs}
        if(elapsedMs-since<150)return AutomaticCaptureStep("ChatGPT changed. Confirming the completed messages…",pending=true,nextReadAfterMs=150L)
        val context=store.ensureAutomaticContext(expectedContextId)
            ?: return AutomaticCaptureStep("Checking the current ChatGPT screen…",pending=true)
        val continuous=trustedTail&&sourceSession==verifiedSession&&messages.any{it.role==tail!!.role&&it.text==tail.text}
        val result=store.saveAutomaticWindow(context.id,messages,version,observedAt,continuous,
            continuesFrom=verifiedObservation.takeIf{continuous})
        if(result.issue!=null) {
            verified=null;verifiedSession=null;verifiedObservation=null
            return AutomaticCaptureStep("Messages are saved securely on this phone while Sherry checks their conversation.",result.added,pending=true)
        }
        verified=messages;verifiedSession=result.resolvedSessionId;verifiedObservation=result.observationId
        if(result.queueFull)return AutomaticCaptureStep("Messages are saved on this phone. Upload waiting messages to make room.",result.added,pending=true)
        val edges=if(messages.size!=read.messages.size)" Some text at the screen edge is not ready yet."else ""
        return AutomaticCaptureStep(if(result.added>0)"Saved ${result.added} new ChatGPT messages on this phone.$edges"
            else "Visible ChatGPT messages are up to date on this phone.$edges",result.added)
    }
}
