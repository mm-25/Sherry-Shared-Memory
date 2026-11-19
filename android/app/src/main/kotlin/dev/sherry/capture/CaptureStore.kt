package dev.sherry.capture

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import dev.sherry.capture.core.*
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class NativeObservation(val id:String,val context:NativeConversationContext,val messages:List<ParsedMessage>,
    val appVersion:String,val observedAt:String,val workspaceId:String?=null,val continuesFrom:String?=null,
    val awaitingReply:Boolean=false,val firstUserObservedAt:String?=null)
data class AutomaticSaveResult(val added:Int=0,val pending:Int=0,val issue:NativeResolutionIssue?=null,
    val queueFull:Boolean=false,val observationId:String?=null,val resolvedSessionId:String?=null)

@Serializable
data class CaptureState(
    val deviceId: String = UUID.randomUUID().toString(),
    val paused: Boolean = true,
    val connection: Connection? = null,
    val captures: List<LocalCapture> = emptyList(),
    val proofProviders: Set<Provider> = emptySet(),
    val lastSync: String? = null,
    val syncMessage: String = "Saved captures stay on this phone until you connect and resume sync.",
    val savedNativePreviews: List<String> = emptyList(),
    val nativeSessions: List<NativeSession> = emptyList(),
    val currentNativeSessionId: String? = null,
    val automaticChatGptCapture: Boolean = false,
    val captureControlVersion: Int = 0,
    val recentCaptures: List<RecentCapture> = emptyList(),
    val receivedCount: Long = 0,
    val automaticContext: NativeConversationContext? = null,
    val pendingNativeObservations: List<NativeObservation> = emptyList(),
    val processedAutomaticWindows: List<String> = emptyList(),
)

val CaptureState.captureEnabled: Boolean get() = captureMasterEnabled(automaticChatGptCapture, paused, captureControlVersion)

/** Single-process repository. AES-GCM payload + atomic replacement; no plaintext transcripts on disk. */
class CaptureStore internal constructor(context: Context, private val testKey: SecretKey? = null) : AccountSessionStore {
    private val file = AtomicFile(File(context.noBackupFilesDir, "capture-v1.enc"))
    private val key: SecretKey by lazy {
        testKey ?: androidKey()
    }
    private fun androidKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private var loadFailure: String? = null
    private val mutable = MutableStateFlow(read())
    val state = mutable.asStateFlow()
    val storageError: String? get() = loadFailure

    private fun read(): CaptureState {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return CaptureState()
        return try {
            val bytes = file.readFully()
            require(bytes.size in 29..12_000_000 && bytes[0] == 1.toByte())
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
            cipher.updateAAD("sherry-capture-v1".toByteArray())
            CaptureJson.decodeFromString<CaptureState>(cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8))
        } catch (_: Exception) {
            loadFailure = "The encrypted capture store could not be opened. Existing data was preserved."
            CaptureState(syncMessage = loadFailure!!)
        }
    }

    @Synchronized
    private fun update(transform: (CaptureState) -> CaptureState) {
        check(loadFailure == null) { loadFailure!! }
        val next = transform(mutable.value)
        val plaintext = CaptureJson.encodeToString(next).toByteArray(Charsets.UTF_8)
        require(plaintext.size <= 10_000_000) { "The local queue is full. Sync or remove pending captures first." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD("sherry-capture-v1".toByteArray())
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(plaintext)
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (error: Exception) {
            file.failWrite(output)
            throw error
        }
        mutable.value = next
    }

    fun add(capture: LocalCapture) = update { current ->
        require(current.captures.size < 100) { "You have 100 pending captures. Sync or remove some before saving more." }
        require(current.captures.none { it.id == capture.id }) { "This capture has already been saved." }
        val bound = current.connection?.let { CaptureFactory.freeze(capture, it.workspaceId, current.deviceId) } ?: capture
        current.copy(captures = current.captures + bound,
            recentCaptures = rememberRecent(current.recentCaptures, listOf(bound), current.connection?.workspaceId))
    }

    @Synchronized
    fun previewMerge(id: String, messages: List<ParsedMessage>, observedAt: String, sessionId: String?,
                     allowSingleTrailingAnchor: Boolean = false): SessionMerge {
        val current = mutable.value
        val session = if (sessionId == null) NativeSession(id, observedAt, observedAt, workspaceId = current.connection?.workspaceId)
            else current.nativeSessions.firstOrNull { it.id == sessionId } ?: error("This capture session is no longer available. Start a new capture.")
        require(session.workspaceId == null || current.connection == null || session.workspaceId == current.connection.workspaceId) {
            "This capture belongs to another workspace. Start a new capture for the connected workspace."
        }
        return NativeReconciler.merge(session, messages, observedAt, allowSingleTrailingAnchor)
    }

    @Synchronized
    fun saveNativePreview(id: String, messages: List<ParsedMessage>, appVersion: String, observedAt: String,
                          sessionId: String? = null, automatic: Boolean = false,
                          allowSingleTrailingAnchor: Boolean = false): Int {
        var added = 0
        update { current ->
            if (automatic) {
                require(current.captureEnabled && Provider.CHATGPT in current.proofProviders) {
                    "Automatic ChatGPT capture is off or paused."
                }
                require(sessionId == current.currentNativeSessionId) { "The active conversation changed. Read the screen again." }
            }
            require(id !in current.savedNativePreviews) { "This preview has already been saved." }
            require(sessionId != null || current.nativeSessions.size < 100) { "The local capture registry is full. Existing sessions are preserved." }
            val merge = previewMerge(id, messages, observedAt, sessionId, allowSingleTrailingAnchor)
            val session = merge.session.copy(workspaceId = merge.session.workspaceId ?: current.connection?.workspaceId)
            val captures = merge.additions.map { (turn, message) -> CaptureFactory.nativeTurn(session, turn, message, id, appVersion, observedAt) }
            require(current.captures.size + captures.size <= 100) { "Not enough queue space. Sync or remove captures before saving this conversation." }
            val bound = captures.map { capture -> current.connection?.let {
                CaptureFactory.freeze(capture, it.workspaceId, current.deviceId)
            } ?: capture }
            added = bound.size
            current.copy(captures = current.captures + bound,
                recentCaptures = rememberRecent(current.recentCaptures, bound, current.connection?.workspaceId),
                nativeSessions = current.nativeSessions.filterNot { it.id == session.id } + session,
                currentNativeSessionId = session.id,
                automaticContext = if (automatic) current.automaticContext else null,
                savedNativePreviews = (current.savedNativePreviews + id).takeLast(100),
                syncMessage = "${bound.size} new messages saved; ${merge.duplicates} already captured. Original message dates are unknown.")
        }
        return added
    }

    /** Called only after a positive source navigation fact. Never clears waiting messages. */
    @Synchronized
    fun beginAutomaticVisit(navigation:NativeNavigation,expectedContextId:String?=mutable.value.automaticContext?.id):NativeConversationContext {
        require(mutable.value.automaticContext?.id==expectedContextId){"The active conversation changed. Read the screen again."}
        val context=NativeConversationContext(UUID.randomUUID().toString(),navigation)
        update{it.copy(automaticContext=context)}
        return context
    }

    @Synchronized
    fun ensureAutomaticContext(expectedContextId:String?=mutable.value.automaticContext?.id):NativeConversationContext? {
        if(mutable.value.automaticContext?.id!=expectedContextId)return null
        mutable.value.automaticContext?.let{return it}
        val context=NativeConversationContext(UUID.randomUUID().toString(),sessionId=mutable.value.currentNativeSessionId)
        update{it.copy(automaticContext=context)}
        return context
    }

    /** Durable observation first; resolution/delivery second. A retry never changes event identity. */
    @Synchronized
    fun saveAutomaticWindow(contextId:String,messages:List<ParsedMessage>,appVersion:String,observedAt:String,
                            allowSingleTrailingAnchor:Boolean=false,continuesFrom:String?=null,awaitingReply:Boolean=false):AutomaticSaveResult {
        val current=mutable.value
        require(current.captureEnabled&&Provider.CHATGPT in current.proofProviders){"Automatic ChatGPT capture is off."}
        require(ChatGptParser.validVersionMetadata(appVersion))
        require(messages.size in 1..100 && messages.all{it.role in setOf("user","assistant")&&it.text.isNotBlank()&&it.text.length<=CaptureFactory.MAX_TEXT})
        val context=current.automaticContext
        if(context?.id!=contextId)return AutomaticSaveResult(issue=NativeResolutionIssue.STALE_CONTEXT)
        val ledger=context.sessionId?.let{id->current.nativeSessions.firstOrNull{it.id==id}?.turns}
        val revision=ledger?.let{it.size.toString()+":"+it.lastOrNull()?.id}.orEmpty()
        if(awaitingReply)require(messages.size==1&&messages.single().role=="user")
        val fingerprint=contextId+":"+revision+":"+appVersion+":"+awaitingReply+":"+CaptureJson.encodeToString(messages)
        val id=UUID.nameUUIDFromBytes(fingerprint.toByteArray(Charsets.UTF_8)).toString()
        if(id in current.processedAutomaticWindows)return AutomaticSaveResult(pending=current.pendingNativeObservations.size,
            observationId=id,resolvedSessionId=context.sessionId)
        if(continuesFrom!=null) {
            val parent=current.pendingNativeObservations.firstOrNull{it.id==continuesFrom}
            require((parent!=null&&parent.context.id==contextId)||continuesFrom in current.processedAutomaticWindows){"The prior read is no longer available for continuity."}
        }
        if(current.pendingNativeObservations.none{it.id==id}) {
            val prefixes=if(awaitingReply||messages.size<2||messages[1].role!="assistant")emptyList()else
                current.pendingNativeObservations.filter{old->old.context.id==contextId&&old.awaitingReply&&
                    old.messages.size==1&&old.messages.single().role==messages[0].role&&old.messages.single().text==messages[0].text}
            val inheritedOwners=prefixes.mapNotNull{it.workspaceId}.distinct()
            require(inheritedOwners.size<=1&&inheritedOwners.all{current.connection==null||it==current.connection.workspaceId}){
                "The retained user message belongs to its previously connected workspace."
            }
            val owner=current.connection?.workspaceId?:inheritedOwners.singleOrNull()
            val firstSeen=prefixes.minByOrNull{java.time.Instant.parse(it.observedAt)}?.observedAt
            val observation=NativeObservation(id,context,messages,appVersion,observedAt,owner,continuesFrom,awaitingReply,firstSeen)
            update{state->
                // A complete source window contains this exact earlier user prefix;
                // replace it atomically, retaining its original observation time and owner.
                val pending=state.pendingNativeObservations.filterNot{old->prefixes.any{it.id==old.id}}+observation
                require(pending.size<=100 && pending.sumOf{item->item.messages.sumOf{it.text.toByteArray(Charsets.UTF_8).size.toLong()}}<=2_000_000){
                    "Conversation identification storage is full. Earlier saved messages are preserved."}
                state.copy(pendingNativeObservations=pending,
                    processedAutomaticWindows=(state.processedAutomaticWindows+prefixes.map{it.id}).takeLast(100))
            }
        }
        if(awaitingReply)return AutomaticSaveResult(pending=mutable.value.pendingNativeObservations.size,observationId=id)
        return resolveAutomaticContext(context,id,allowSingleTrailingAnchor).copy(observationId=id)
    }

    /** Process already-retained reads even after collection stops or ChatGPT closes. */
    @Synchronized
    fun reconcileRetainedObservations():Int {
        var added=0
        val groups=mutable.value.pendingNativeObservations.groupBy{it.context.id}
        for(observations in groups.values) {
            var context=observations.lastOrNull{it.context.sessionId!=null}?.context?:observations.first().context
            var remaining=observations.size
            do {
                val result=resolveAutomaticContext(context)
                added+=result.added
                result.resolvedSessionId?.let{context=context.copy(sessionId=it)}
                val now=mutable.value.pendingNativeObservations.count{it.context.id==context.id}
                val progressed=now<remaining;remaining=now
            } while(remaining>0&&progressed)
        }
        return added
    }

    private fun resolveAutomaticContext(context:NativeConversationContext,preferredId:String?=null,
                                        allowSingleTrailingAnchor:Boolean=false):AutomaticSaveResult {
        val current=mutable.value
        var active=current.automaticContext?.takeIf{it.id==context.id}?:context
        if(active.sessionId==null&&current.nativeSessions.any{it.id==active.id})active=active.copy(sessionId=active.id)
        var captures=current.captures
        var sessions=current.nativeSessions
        var recent=current.recentCaptures
        val completed=mutableListOf<String>()
        var issue:NativeResolutionIssue?=null
        var queueFull=false
        var added=0
        var candidate=active.sessionId?:active.id.takeIf{active.navigation==NativeNavigation.NEW_CHAT}
        // Resolve the newest complete view first. Its anchors can then recover an
        // earlier retained window from this same source visit without asking the user.
        val observations=current.pendingNativeObservations.filter{it.context.id==context.id&&!it.awaitingReply}
            .sortedBy{if(it.id==preferredId)0 else 1}
        for(observation in observations) {
            if(observation.continuesFrom!=null&&observations.any{it.id==observation.continuesFrom}&&observation.continuesFrom !in completed) {
                queueFull=true
                continue
            }
            val sourceWorkspace=observation.workspaceId?:sessions.firstOrNull{it.id==active.sessionId}?.workspaceId?:current.connection?.workspaceId
            if(observation.workspaceId!=null&&current.connection!=null&&observation.workspaceId!=current.connection.workspaceId) {
                if(observation.id==preferredId)issue=NativeResolutionIssue.STALE_CONTEXT
                continue
            }
            val eligible=sessions.filter{it.workspaceId==null||it.workspaceId==sourceWorkspace}
            val resolved=NativeConversationResolver.resolve(eligible,observation.messages,observation.observedAt,active,
                (allowSingleTrailingAnchor && observation.id==preferredId)||observation.continuesFrom!=null)
            val merge=resolved.merge
            if(merge==null){if(observation.id==preferredId)issue=resolved.issue;continue}
            val session=merge.session.copy(workspaceId=merge.session.workspaceId?:sourceWorkspace)
            candidate=session.id
            val additions=merge.additions.map{(turn,message)->
                val capturedAt=if(turn.sequence==session.turns.minOf{it.sequence}&&message.role=="user")
                    observation.firstUserObservedAt?:observation.observedAt else observation.observedAt
                CaptureFactory.nativeTurn(session,turn,message,observation.id,observation.appVersion,capturedAt)}
            if(captures.size+additions.size>100){queueFull=true;continue}
            require(sessions.any{it.id==session.id}||sessions.size<100){"The local conversation registry is full; saved observations are preserved."}
            val bound=additions.map{capture->session.workspaceId?.let{CaptureFactory.freeze(capture,it,current.deviceId)}?:capture}
            captures=captures+bound;added+=bound.size
            recent=rememberRecent(recent,bound,session.workspaceId)
            sessions=sessions.filterNot{it.id==session.id}+session
            active=active.copy(sessionId=session.id)
            completed+=observation.id
        }
        if(completed.isNotEmpty())update{state->state.copy(captures=captures,recentCaptures=recent,
            nativeSessions=sessions,
            currentNativeSessionId=if(state.automaticContext?.id==context.id)active.sessionId else state.currentNativeSessionId,
            automaticContext=if(state.automaticContext?.id==context.id)active else state.automaticContext,
            pendingNativeObservations=state.pendingNativeObservations.filterNot{it.id in completed},
            processedAutomaticWindows=(state.processedAutomaticWindows+completed).takeLast(100),
            syncMessage="$added new messages saved on this phone.")}
        return AutomaticSaveResult(added,mutable.value.pendingNativeObservations.size,issue,queueFull,resolvedSessionId=candidate)
    }

    fun connect(workspace: String, token: String) = update { current ->
        require(CaptureFactory.validWorkspace(workspace)) { "Enter a valid workspace ID." }
        require(token.isNotBlank() && token.length < 16_000 && !token.any(Char::isWhitespace)) { "Enter a valid session access token." }
        require(current.connection?.workspaceId == null || current.connection.workspaceId == workspace || current.captures.isEmpty()) {
            "Sync or remove this workspace’s pending captures before switching workspaces."
        }
        require(current.pendingNativeObservations.none{it.workspaceId!=null&&it.workspaceId!=workspace}) {
            "Waiting messages are assigned to the previously connected workspace. Reconnect that account first."
        }
        val captures = current.captures.map { CaptureFactory.freeze(it, workspace, current.deviceId) }
        current.copy(connection = Connection(workspace, token), captures = captures,
            pendingNativeObservations = current.pendingNativeObservations.map{if(it.workspaceId==null)it.copy(workspaceId=workspace)else it},
            nativeSessions = current.nativeSessions.map { if (it.workspaceId == null) it.copy(workspaceId = workspace) else it },
            syncMessage = "Connected. Resume sync when you’re ready to upload.")
    }

    fun disconnect() = update { it.copy(connection = null, paused = true, automaticChatGptCapture = false,
        captureControlVersion = 1, syncMessage = "Signed out. Pending captures remain encrypted on this phone.") }
    fun pause(paused: Boolean) = update { it.copy(paused = paused) }
    fun proof(provider: Provider, enabled: Boolean) = update {
        it.copy(proofProviders = if (enabled) it.proofProviders + provider else it.proofProviders - provider)
    }
    fun automaticChatGptCapture(enabled: Boolean) = update { it.copy(automaticChatGptCapture = enabled) }
    fun captureEnabled(enabled: Boolean) = update { it.copy(automaticChatGptCapture = enabled, captureControlVersion = 1) }
    fun deliveryPaused(paused: Boolean) = update {
        it.copy(automaticChatGptCapture = it.captureEnabled, captureControlVersion = 1, paused = paused)
    }
    fun startSeparateNativeSession() = update { it.copy(currentNativeSessionId = null,
        automaticContext = NativeConversationContext(UUID.randomUUID().toString(), NativeNavigation.NEW_CHAT)) }
    fun remove(id: String) = update { it.copy(captures = it.captures.filterNot { capture -> capture.id == id },
        recentCaptures = it.recentCaptures.filterNot { capture -> capture.id == id }) }
    fun status(message: String) = update { it.copy(syncMessage = message) }
    fun reject(id: String, message: String) = update { it.copy(captures = it.captures.map { item ->
        if (item.id == id) item.copy(status = "rejected", message = message) else item
    }, syncMessage = message) }
    fun committed(id: String) = update { current ->
        val capture = current.captures.firstOrNull { it.id == id } ?: return@update current
        current.copy(captures = current.captures.filterNot { item -> item.id == id },
            recentCaptures = rememberRecent(current.recentCaptures, listOf(capture), current.connection?.workspaceId)
                .map { if (it.id == id) it.copy(delivery = "committed") else it },
            receivedCount = current.receivedCount + 1,
            lastSync = java.time.Instant.now().toString(), syncMessage = "Saved to Sherry.")
    }

    override fun account(): Connection? = mutable.value.connection
    override fun saveSignedIn(next: Connection) = update { current ->
        require(current.connection?.workspaceId == null || current.connection.workspaceId == next.workspaceId || current.captures.isEmpty()) {
            "Your waiting messages belong to the previously connected workspace. Reconnect that account first."
        }
        require(current.pendingNativeObservations.none{it.workspaceId!=null&&it.workspaceId!=next.workspaceId}) {
            "Waiting messages are assigned to the previously connected workspace. Reconnect that account first."
        }
        val captures = current.captures.map { CaptureFactory.freeze(it, next.workspaceId, current.deviceId) }
        current.copy(connection = next, captures = captures,
            pendingNativeObservations = current.pendingNativeObservations.map{if(it.workspaceId==null)it.copy(workspaceId=next.workspaceId)else it},
            recentCaptures = current.recentCaptures.map { if (it.workspaceId == null) it.copy(workspaceId = next.workspaceId) else it },
            nativeSessions = current.nativeSessions.map { if (it.workspaceId == null) it.copy(workspaceId = next.workspaceId) else it },
            syncMessage = if (current.paused) "Connected. Resume uploads when you are ready." else "Connected to Sherry.")
    }
    @Synchronized override fun replaceAccount(expected: Connection, next: Connection): Boolean {
        if (mutable.value.connection != expected) return false
        update { it.copy(connection = next) }; return true
    }
    override fun requireReconnect(expected: Connection) = update {
        if (it.connection == expected) it.copy(connection = expected.copy(needsReconnect = true),
            syncMessage = "Sign in to Sherry again. Waiting messages are safe on this phone.") else it
    }

    @Synchronized
    fun nextUpload(): Pair<Connection, LocalCapture>? {
        val current = mutable.value
        val connection = current.connection ?: return null
        if (current.paused) return null
        val capture = current.captures.firstOrNull { it.status == "pending" } ?: return null
        val frozen = CaptureFactory.freeze(capture, connection.workspaceId, current.deviceId)
        if (capture.payload == null) update { it.copy(captures = it.captures.map { row -> if (row.id == capture.id) frozen else row }) }
        return connection to frozen
    }

    companion object { private const val KEY_ALIAS = "dev.sherry.capture.queue.v1" }
}
