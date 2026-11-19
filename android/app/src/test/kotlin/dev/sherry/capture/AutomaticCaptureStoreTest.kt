package dev.sherry.capture

import android.app.Application
import android.content.ContextWrapper
import dev.sherry.capture.core.*
import java.io.File
import java.util.UUID
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34],application=Application::class)
class AutomaticCaptureStoreTest {
    private val at="2026-10-27T16:00:00Z"
    private val key=KeyGenerator.getInstance("AES").apply{init(256)}.generateKey()
    private fun context():ContextWrapper {
        val base=RuntimeEnvironment.getApplication()
        val directory=File(base.noBackupFilesDir,"auto-${UUID.randomUUID()}").apply{mkdirs()}
        return object:ContextWrapper(base){override fun getNoBackupFilesDir():File=directory}
    }
    private val a=listOf(ParsedMessage("user","A question"),ParsedMessage("assistant","A answer"))
    private val b=listOf(ParsedMessage("user","B question"),ParsedMessage("assistant","B answer"))
    @Test fun automaticNewChatsRevisitAndRestartPreserveOldTwentyAndNeverNeedManualSave() {
        val ctx=context();val store=CaptureStore(ctx,key)
        repeat(20){store.add(CaptureFactory.share(Provider.CHATGPT,"Old waiting $it","Test"))}
        val old=store.state.value.captures
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val first=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        assertEquals(2,store.saveAutomaticWindow(first.id,a,"1.2026.293",at).added)
        assertEquals(0,store.saveAutomaticWindow(first.id,a,"1.2026.293",at).added)
        val second=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        assertEquals(2,store.saveAutomaticWindow(second.id,b,"1.2026.293",at).added)
        val visit=store.beginAutomaticVisit(NativeNavigation.HISTORY)
        assertEquals(0,store.saveAutomaticWindow(visit.id,a,"1.2026.293",at).added)
        assertEquals(first.id,store.state.value.currentNativeSessionId)
        val restored=CaptureStore(ctx,key)
        assertEquals(0,restored.saveAutomaticWindow(visit.id,a,"1.2026.293",at).added)
        assertEquals(old,restored.state.value.captures.take(20))
        assertEquals(24,restored.state.value.captures.size)
        assertTrue(restored.state.value.paused)
        assertEquals(2,restored.state.value.nativeSessions.size)
        assertTrue(restored.state.value.pendingNativeObservations.isEmpty())
        val repeated=restored.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        assertEquals(2,restored.saveAutomaticWindow(repeated.id,a,"1.2026.293",at).added)
        assertEquals(3,restored.state.value.nativeSessions.size)
    }
    @Test fun anUnidentifiedWindowSurvivesEncryptedRestartWithoutEnteringTheWrongChat() {
        val ctx=context();val store=CaptureStore(ctx,key)
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val first=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.saveAutomaticWindow(first.id,a,"1.2026.293",at)
        val before=store.state.value.captures
        val unknown=store.beginAutomaticVisit(NativeNavigation.UNKNOWN)
        val pending=store.saveAutomaticWindow(unknown.id,b,"1.2026.293",at)
        assertEquals(0,pending.added);assertNotNull(pending.issue)
        assertEquals(before,store.state.value.captures)
        val restored=CaptureStore(ctx,key)
        assertEquals(b,restored.state.value.pendingNativeObservations.single().messages)
        assertEquals(1,restored.saveAutomaticWindow(unknown.id,b,"1.2026.293",at).pending)
        assertEquals(1,restored.state.value.pendingNativeObservations.size)
    }
    @Test fun aLaterOverlappingReadAutomaticallyResolvesEarlierRetainedWindows() {
        val store=CaptureStore(context(),key);store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val visit=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.saveAutomaticWindow(visit.id,a,"1.2026.293",at)
        assertEquals(1,store.saveAutomaticWindow(visit.id,b,"1.2026.293",at).pending)
        assertEquals(2,store.saveAutomaticWindow(visit.id,a+b,"1.2026.293",at).added)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        assertEquals(4,store.state.value.captures.size)
    }
    @Test fun repeatedTextAfterTheLedgerChangesIsReconciledRatherThanContentDeduplicated() {
        val store=CaptureStore(context(),key);store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val visit=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.saveAutomaticWindow(visit.id,a,"1.2026.293",at)
        store.saveAutomaticWindow(visit.id,a+b,"1.2026.293",at,true)
        store.saveAutomaticWindow(visit.id,a+b+a,"1.2026.293",at,true)
        val repeated=store.saveAutomaticWindow(visit.id,a,"1.2026.293",at)
        assertNotNull(repeated.issue)
        assertEquals(1,repeated.pending)
        assertEquals(6,store.state.value.captures.size)
    }
    @Test fun aStaleReadCannotBeAttachedToTheNewlySelectedConversation() {
        val store=CaptureStore(context(),key);store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val old=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        val result=store.saveAutomaticWindow(old.id,a,"1.2026.293",at)
        assertEquals(0,result.added)
        assertEquals(NativeResolutionIssue.STALE_CONTEXT,result.issue)
        assertTrue(store.state.value.captures.isEmpty())
    }
    @Test fun retainedMessagesAreResolvedAfterQueueSpaceReturnsWithoutReopeningChatGPT() {
        val store=CaptureStore(context(),key)
        repeat(100){store.add(CaptureFactory.share(Provider.CHATGPT,"Waiting $it","Test"))}
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val visit=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.saveAutomaticWindow(visit.id,a,"1.2026.293",at)
        store.captureEnabled(false)
        store.committed(store.state.value.captures.first().id);store.committed(store.state.value.captures.first().id)
        assertEquals(2,store.reconcileRetainedObservations())
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
        assertEquals(100,store.state.value.captures.size)
        assertEquals(0,store.reconcileRetainedObservations())
    }
    @Test fun retainedMessagesKeepTheirWorkspaceAndFrozenIdentityAfterDisconnect() {
        val workspace="7c895c18-05e4-4f96-9148-37ad93b2a789"
        val store=CaptureStore(context(),key)
        store.saveSignedIn(Connection(workspace,"invented-token"))
        repeat(100){store.add(CaptureFactory.share(Provider.CHATGPT,"Waiting $it","Test"))}
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val visit=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        store.saveAutomaticWindow(visit.id,a,"1.2026.293",at)
        assertEquals(workspace,store.state.value.pendingNativeObservations.single().workspaceId)
        store.disconnect()
        store.committed(store.state.value.captures.first().id);store.committed(store.state.value.captures.first().id)
        assertEquals(2,store.reconcileRetainedObservations())
        val payloads=store.state.value.captures.takeLast(2).map{it.payload!!}
        assertTrue(payloads.all{CaptureJson.decodeFromString<CaptureBatch>(it).workspaceId==workspace})
        store.saveSignedIn(Connection(workspace,"invented-next-token"))
        assertEquals(payloads,store.state.value.captures.takeLast(2).map{it.payload!!})
        assertTrue(store.state.value.paused);assertFalse(store.state.value.captureEnabled)
    }
    @Test fun aFullUploadQueueRetainsTheUnsentObservationForLaterRetry() {
        val ctx=context();val store=CaptureStore(ctx,key)
        repeat(100){store.add(CaptureFactory.share(Provider.CHATGPT,"Waiting $it","Test"))}
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val visit=store.beginAutomaticVisit(NativeNavigation.NEW_CHAT)
        assertEquals(0,store.saveAutomaticWindow(visit.id,a,"1.2026.293",at).added)
        assertEquals(a,CaptureStore(ctx,key).state.value.pendingNativeObservations.single().messages)
        store.committed(store.state.value.captures.first().id);store.committed(store.state.value.captures.first().id)
        assertEquals(2,store.saveAutomaticWindow(visit.id,a,"1.2026.293",at).added)
        assertTrue(store.state.value.pendingNativeObservations.isEmpty())
    }
}
