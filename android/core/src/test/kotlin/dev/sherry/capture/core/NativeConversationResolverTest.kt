package dev.sherry.capture.core

import kotlin.test.*

class NativeConversationResolverTest {
    private val at="2026-10-27T16:00:00Z"
    private val a=listOf(ParsedMessage("user","A question"),ParsedMessage("assistant","A answer"))
    private val b=listOf(ParsedMessage("user","B question"),ParsedMessage("assistant","B answer"))
    private fun saved(id:String,messages:List<ParsedMessage>)=NativeReconciler.merge(NativeSession(id,at,at),messages,at).session

    @Test fun `a positively observed new chat remains separate even when its text repeats an old chat`() {
        val old=saved("old",a)
        val result=NativeConversationResolver.resolve(listOf(old),a,at,NativeConversationContext("new",NativeNavigation.NEW_CHAT))
        assertEquals("new",result.merge!!.session.id)
        assertEquals(2,result.merge!!.additions.size)
    }
    @Test fun `returning through history recognizes an earlier chat rather than only the last active one`() {
        val old=saved("old",a);val other=saved("other",b)
        val result=NativeConversationResolver.resolve(listOf(old,other),a,at,NativeConversationContext("visit",NativeNavigation.HISTORY))
        assertEquals("old",result.merge!!.session.id)
        assertEquals(0,result.merge!!.additions.size)
    }
    @Test fun `ambiguous identical existing chats remain unresolved instead of mixing them`() {
        val result=NativeConversationResolver.resolve(listOf(saved("a",a),saved("b",a)),a,at,
            NativeConversationContext("visit",NativeNavigation.HISTORY))
        assertNull(result.merge)
        assertEquals(NativeResolutionIssue.AMBIGUOUS,result.issue)
    }
    @Test fun `unknown text without a new chat or history signal cannot silently start another session`() {
        val result=NativeConversationResolver.resolve(listOf(saved("a",a)),b,at,
            NativeConversationContext("visit",NativeNavigation.UNKNOWN))
        assertNull(result.merge)
        assertEquals(NativeResolutionIssue.NEEDS_CONTEXT,result.issue)
    }
    @Test fun `a bound context never switches to another conversation because of unmatched text`() {
        val result=NativeConversationResolver.resolve(listOf(saved("a",a),saved("b",b)),b,at,
            NativeConversationContext("visit",NativeNavigation.HISTORY,"a"))
        assertNull(result.merge)
    }
    @Test fun `an unseen history window is retained until its source identity is established`() {
        val result=NativeConversationResolver.resolve(listOf(saved("a",a)),b,at,
            NativeConversationContext("visit",NativeNavigation.HISTORY))
        assertNull(result.merge)
        assertEquals(NativeResolutionIssue.NEEDS_CONTEXT,result.issue)
    }
    @Test fun `one trailing anchor is limited to a verified continuous bound conversation`() {
        val old=saved("a",a)
        val window=a.takeLast(1)+listOf(ParsedMessage("user","Next question"))
        assertNull(NativeConversationResolver.resolve(listOf(old),window,at,
            NativeConversationContext("visit",NativeNavigation.UNKNOWN)).merge)
        val bound=NativeConversationContext("visit",NativeNavigation.UNKNOWN,"a")
        assertNull(NativeConversationResolver.resolve(listOf(old),window,at,bound).merge)
        assertEquals(1,NativeConversationResolver.resolve(listOf(old),window,at,bound,true).merge!!.additions.size)
    }
    @Test fun `the first ever capture can start without depending on the Sherry popup`() {
        val result=NativeConversationResolver.resolve(emptyList(),a,at,NativeConversationContext("first",NativeNavigation.UNKNOWN))
        assertEquals("first",result.merge!!.session.id)
    }
}
