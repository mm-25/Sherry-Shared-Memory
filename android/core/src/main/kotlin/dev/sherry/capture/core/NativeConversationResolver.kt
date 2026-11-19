package dev.sherry.capture.core

import kotlinx.serialization.Serializable

/** Navigation facts must be obtained from the provider UI, never inferred from unmatched text. */
@Serializable enum class NativeNavigation { UNKNOWN, NEW_CHAT, HISTORY }
@Serializable data class NativeConversationContext(val id:String,val navigation:NativeNavigation=NativeNavigation.UNKNOWN,
    val sessionId:String?=null)
enum class NativeResolutionIssue { NEEDS_CONTEXT, AMBIGUOUS, INCOMPLETE_OVERLAP, STALE_CONTEXT }
data class NativeResolution(val merge:SessionMerge?=null,val issue:NativeResolutionIssue?=null)

/** Resolves a positively observed visit; it does not invent a provider conversation ID. */
object NativeConversationResolver {
    fun resolve(sessions:List<NativeSession>,messages:List<ParsedMessage>,observedAt:String,
                context:NativeConversationContext,continuousTrailingAnchor:Boolean=false):NativeResolution {
        require(messages.isNotEmpty())
        if(context.sessionId!=null) {
            val session=sessions.singleOrNull{it.id==context.sessionId}
                ?: return NativeResolution(issue=NativeResolutionIssue.STALE_CONTEXT)
            return try { NativeResolution(NativeReconciler.merge(session,messages,observedAt,continuousTrailingAnchor)) }
                catch(_:IllegalArgumentException){NativeResolution(issue=NativeResolutionIssue.INCOMPLETE_OVERLAP)}
        }
        if(context.navigation==NativeNavigation.NEW_CHAT || sessions.isEmpty()) {
            return NativeResolution(NativeReconciler.merge(NativeSession(context.id,observedAt,observedAt),messages,observedAt))
        }
        if(context.navigation!=NativeNavigation.HISTORY)return NativeResolution(issue=NativeResolutionIssue.NEEDS_CONTEXT)
        val matches=sessions.mapNotNull{session->try{NativeReconciler.merge(session,messages,observedAt)}catch(_:IllegalArgumentException){null}}
        if(matches.size==1)return NativeResolution(matches.single())
        if(matches.size>1)return NativeResolution(issue=NativeResolutionIssue.AMBIGUOUS)
        // A partial/edited/repeated overlap is evidence of uncertainty, not a new chat.
        val keys=messages.map{it.role to CaptureFactory.hash(it.text)}.toSet()
        if(sessions.any{session->session.turns.any{it.role to it.hash in keys}})
            return NativeResolution(issue=NativeResolutionIssue.INCOMPLETE_OVERLAP)
        // Opening history does not prove this is a never-captured provider chat:
        // it could be a distant part of a known conversation. Keep the observation
        // until the source adapter supplies sufficient identity/overlap evidence.
        return NativeResolution(issue=NativeResolutionIssue.NEEDS_CONTEXT)
    }
}
