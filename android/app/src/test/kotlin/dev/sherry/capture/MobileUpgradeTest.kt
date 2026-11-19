package dev.sherry.capture

import android.app.Application
import android.content.ContextWrapper
import dev.sherry.capture.core.*
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34],application=Application::class)
class MobileUpgradeTest {
    private val workspace="7c895c18-05e4-4f96-9148-37ad93b2a789"
    private val key=KeyGenerator.getInstance("AES").apply{init(256)}.generateKey()
    private fun context():ContextWrapper {
        val base=RuntimeEnvironment.getApplication()
        val directory=File(base.noBackupFilesDir,"test-${java.util.UUID.randomUUID()}").apply{mkdirs()}
        return object:ContextWrapper(base){override fun getNoBackupFilesDir():File=directory}
    }

    @Test fun oldTwentyMessageEncryptedStoreSurvivesUpgradeWithoutEnablingCaptureOrUploads() {
        val ctx=context()
        val oldCaptures=(1..20).map{CaptureFactory.share(Provider.CHATGPT,"invented message $it","Migration test").let{
            it.copy(event=it.event.copy(sourceMetadata=null))
        }}
        val legacy=CaptureState(paused=true,automaticChatGptCapture=true,proofProviders=setOf(Provider.CHATGPT),captures=oldCaptures)
        val oldState=CaptureJson.parseToJsonElement(CaptureJson.encodeToString(legacy)).jsonObject
            .filterKeys{it !in setOf("captureControlVersion","recentCaptures","receivedCount")}
        val oldJson=JsonObject(oldState+("captures" to JsonArray(oldState.getValue("captures").jsonArray.map{saved ->
            JsonObject(saved.jsonObject+("event" to JsonObject(saved.jsonObject.getValue("event").jsonObject-"sourceMetadata")))
        }))).toString()
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key);updateAAD("sherry-capture-v1".toByteArray())}
        File(ctx.noBackupFilesDir,"capture-v1.enc").writeBytes(byteArrayOf(1)+cipher.iv+cipher.doFinal(oldJson.toByteArray()))
        val before=File(ctx.noBackupFilesDir,"capture-v1.enc").readBytes()
        val upgraded=CaptureStore(ctx,key)
        assertNull(upgraded.storageError)
        assertEquals(oldCaptures,upgraded.state.value.captures)
        assertFalse(upgraded.state.value.captureEnabled)
        assertTrue(upgraded.state.value.paused)
        assertArrayEquals(before,File(ctx.noBackupFilesDir,"capture-v1.enc").readBytes())
        upgraded.deliveryPaused(false)
        assertFalse(upgraded.state.value.captureEnabled)
        assertNull(upgraded.nextUpload()) // no account; resuming is not a sign-in
        assertEquals(oldCaptures,CaptureStore(ctx,key).state.value.captures)
    }

    @Test fun captureAndUploadControlsAreIndependentAndRecentMessagesRemainAfterReceipt() {
        val ctx=context();val store=CaptureStore(ctx,key)
        store.captureEnabled(true);store.proof(Provider.CHATGPT,true)
        assertTrue(store.state.value.paused)
        assertTrue(store.state.value.captureEnabled)
        val messages=listOf(ParsedMessage("user","amber notebook"),ParsedMessage("assistant","invented answer"))
        val id=java.util.UUID.randomUUID().toString()
        assertEquals(2,store.saveNativePreview(id,messages,ChatGptParser.VERIFIED_VERSION,"2026-10-27T12:00:00Z",automatic=true))
        store.saveSignedIn(Connection(workspace,"test-token",email="demo@example.com"))
        assertNull(store.nextUpload())
        store.deliveryPaused(false)
        val payload=store.nextUpload()!!.second.payload
        assertEquals(payload,CaptureStore(ctx,key).nextUpload()!!.second.payload)
        val first=store.state.value.captures.first().id
        store.committed(first);store.committed(first)
        assertEquals(1L,store.state.value.receivedCount)
        assertEquals(2,store.state.value.recentCaptures.size)
        assertEquals(listOf("user","assistant"),store.state.value.recentCaptures.map{it.role})
        assertEquals("committed",store.state.value.recentCaptures.first().delivery)
        store.deliveryPaused(true)
        assertTrue(store.state.value.captureEnabled)
        assertNull(store.nextUpload())
        store.captureEnabled(false)
        assertEquals(1,CaptureStore(ctx,key).state.value.captures.size)
    }

    @Test fun removingWaitingMessageAlsoRemovesItsRecentCopyWithoutChangingOtherMessages() {
        val ctx=context();val store=CaptureStore(ctx,key)
        val first=CaptureFactory.share(Provider.CHATGPT,"first invented excerpt","Test")
        val second=CaptureFactory.share(Provider.CHATGPT,"second invented excerpt","Test")
        store.add(first);store.add(second);store.remove(first.id)
        val restored=CaptureStore(ctx,key).state.value
        assertEquals(listOf(second.id),restored.captures.map{it.id})
        assertEquals(listOf(second.id),restored.recentCaptures.map{it.id})
    }

    @Test fun explicitSeparateChatPreservesEarlierQueueAndThenAutomaticallySavesModernMessagesOnce() {
        val ctx=context();val store=CaptureStore(ctx,key);val at="2026-10-27T15:00:00Z"
        store.proof(Provider.CHATGPT,true);store.captureEnabled(true)
        val first=java.util.UUID.randomUUID().toString()
        store.saveNativePreview(first,listOf(ParsedMessage("user","old question"),ParsedMessage("assistant","old answer")),ChatGptParser.VERIFIED_VERSION,at,automatic=true)
        val earlier=store.state.value.captures
        val next=listOf(ParsedMessage("user","a different conversation"),ParsedMessage("assistant","cedar window."))
        var blocked=false
        try{store.saveNativePreview(java.util.UUID.randomUUID().toString(),next,"1.2026.293",at,first,automatic=true)}catch(_:IllegalArgumentException){blocked=true}
        assertTrue(blocked);assertEquals(earlier,store.state.value.captures)
        store.startSeparateNativeSession()
        assertEquals(earlier,store.state.value.captures);assertEquals(1,store.state.value.nativeSessions.size)
        val second=java.util.UUID.randomUUID().toString()
        assertEquals(2,store.saveNativePreview(second,next,"1.2026.293",at,automatic=true))
        assertEquals(0,store.saveNativePreview(java.util.UUID.randomUUID().toString(),next,"1.2026.293",at,second,automatic=true))
        val restarted=CaptureStore(ctx,key)
        assertEquals(earlier,restarted.state.value.captures.take(2));assertEquals(4,restarted.state.value.captures.size)
        assertEquals(2,restarted.state.value.nativeSessions.size);assertTrue(restarted.state.value.paused)
        assertEquals(listOf("1.2026.293","1.2026.293"),restarted.state.value.captures.takeLast(2).map{it.providerAppVersion})
    }
}
