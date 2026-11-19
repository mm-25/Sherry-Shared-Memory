package dev.sherry.capture

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import dev.sherry.capture.core.*
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class CaptureStoreTest {
    private val workspace = "7c895c18-05e4-4f96-9148-37ad93b2a789"
    private fun context(): ContextWrapper {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(base.noBackupFilesDir, "test-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        return object : ContextWrapper(base) { override fun getNoBackupFilesDir(): File = directory }
    }

    @Test fun encryptedQueueSurvivesRestartAndKeepsExactRetryBody() {
        val context = context()
        val store = CaptureStore(context)
        val capture = CaptureFactory.share(Provider.CHATGPT, "private-test-transcript", "Private test")
        store.connect(workspace, "private-test-token")
        store.add(capture)
        val disk = File(context.noBackupFilesDir, "capture-v1.enc").readBytes().toString(Charsets.UTF_8)
        assertFalse(disk.contains("private-test-transcript"))
        assertFalse(disk.contains("private-test-token"))
        val restarted = CaptureStore(context)
        assertEquals("private-test-transcript", restarted.state.value.captures.single().event.text)
        assertNull(restarted.nextUpload())
        restarted.pause(false)
        val payload = restarted.nextUpload()!!.second.payload
        assertEquals(payload, CaptureStore(context).nextUpload()!!.second.payload)
        restarted.committed(capture.id)
        assertTrue(CaptureStore(context).state.value.captures.isEmpty())
    }

    @Test fun nativePreviewSaveIsAtomicAndCannotBeSavedTwiceAfterRestart() {
        val context = context()
        val store = CaptureStore(context)
        val id = java.util.UUID.randomUUID().toString()
        val messages = listOf(ParsedMessage("user", "test question"), ParsedMessage("assistant", "test answer"))
        store.saveNativePreview(id, messages, ChatGptParser.VERIFIED_VERSION, java.time.Instant.now().toString())
        val restored = CaptureStore(context)
        assertEquals(listOf("user", "assistant"), restored.state.value.captures.map { it.event.role })
        var rejected = false
        try { restored.saveNativePreview(id, messages, ChatGptParser.VERIFIED_VERSION, java.time.Instant.now().toString()) }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertEquals(2, CaptureStore(context).state.value.captures.size)
        val large = List(99) { ParsedMessage("user", "test") }
        rejected = false
        try { restored.saveNativePreview(java.util.UUID.randomUUID().toString(), large, ChatGptParser.VERIFIED_VERSION, java.time.Instant.now().toString()) }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertEquals(2, CaptureStore(context).state.value.captures.size)
    }

    @Test fun overlappingReadsRemainDeduplicatedAfterUploadRestartAndKeepAtomicQueue() {
        val ctx = context()
        val store = CaptureStore(ctx)
        val all = listOf(ParsedMessage("user", "one"), ParsedMessage("assistant", "two"), ParsedMessage("user", "three"), ParsedMessage("assistant", "four"))
        val session = java.util.UUID.randomUUID().toString()
        val at = "2026-10-02T06:00:00Z"
        assertEquals(3, store.saveNativePreview(session, all.drop(1), ChatGptParser.VERIFIED_VERSION, at))
        store.state.value.captures.forEach { store.committed(it.id) }
        val restarted = CaptureStore(ctx)
        val preview = java.util.UUID.randomUUID().toString()
        assertEquals(1, restarted.saveNativePreview(preview, all, ChatGptParser.VERIFIED_VERSION, at, session))
        assertEquals(4, restarted.state.value.nativeSessions.single().turns.size)
        assertEquals(1, restarted.state.value.captures.size)
        assertEquals("one", restarted.state.value.captures.single().event.text)
        assertEquals(0, restarted.saveNativePreview(java.util.UUID.randomUUID().toString(), all, ChatGptParser.VERIFIED_VERSION, at, session))
        restarted.connect(workspace, "test-token")
        restarted.state.value.captures.forEach { restarted.committed(it.id) }
        restarted.disconnect()
        restarted.connect("7c895c18-05e4-4f96-9148-37ad93b2a780", "test-token")
        var rejected = false
        try { restarted.saveNativePreview(java.util.UUID.randomUUID().toString(), all, ChatGptParser.VERIFIED_VERSION, at, session) }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertTrue(restarted.state.value.captures.isEmpty())
    }

    @Test fun automaticSaveRequiresOptInAndPauseAllowsNoNewMessages() {
        val ctx = context()
        val store = CaptureStore(ctx)
        val first = listOf(ParsedMessage("user", "automatic question"), ParsedMessage("assistant", "automatic answer"))
        val observed = "2026-10-02T20:00:00Z"
        val id = java.util.UUID.randomUUID().toString()
        store.proof(Provider.CHATGPT, true)
        store.pause(false)
        var rejected = false
        try { store.saveNativePreview(id, first, ChatGptParser.VERIFIED_VERSION, observed, automatic = true) }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertTrue(store.state.value.captures.isEmpty())
        store.automaticChatGptCapture(true)
        assertEquals(2, store.saveNativePreview(id, first, ChatGptParser.VERIFIED_VERSION, observed, automatic = true))
        assertEquals(2, CaptureStore(ctx).state.value.captures.size)
        store.pause(true)
        rejected = false
        try {
            store.saveNativePreview(java.util.UUID.randomUUID().toString(), first + ParsedMessage("user", "next"),
                ChatGptParser.VERIFIED_VERSION, observed, id, automatic = true)
        } catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertEquals(2, store.state.value.captures.size)
    }

    @Test fun reconnectCannotMoveBoundCapturesToAnotherWorkspace() {
        val store = CaptureStore(context())
        store.connect(workspace, "test-token")
        store.add(CaptureFactory.share(Provider.CHATGPT, "text", "title"))
        store.disconnect()
        var rejected = false
        try { store.connect("7c895c18-05e4-4f96-9148-37ad93b2a780", "test-token") }
        catch (_: IllegalArgumentException) { rejected = true }
        assertTrue(rejected)
        assertNull(store.state.value.connection)
        assertEquals(1, store.state.value.captures.size)
    }

    @Test fun corruptCiphertextIsPreservedAndNeverOverwrittenWithEmptyState() {
        val context = context()
        CaptureStore(context).add(CaptureFactory.share(Provider.CHATGPT, "text", "title"))
        val file = File(context.noBackupFilesDir, "capture-v1.enc")
        val corrupt = file.readBytes().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        file.writeBytes(corrupt)
        val restarted = CaptureStore(context)
        assertNotNull(restarted.storageError)
        var rejected = false
        try { restarted.pause(false) } catch (_: IllegalStateException) { rejected = true }
        assertTrue(rejected)
        assertArrayEquals(corrupt, file.readBytes())
    }

    @Test fun rejectedCapturesDoNotBlockNewCapturesAndPauseGatesUpload() {
        val store = CaptureStore(context())
        store.connect(workspace, "test-token")
        val rejected = CaptureFactory.share(Provider.CHATGPT, "bad", "first")
        val next = CaptureFactory.share(Provider.CHATGPT, "good", "second")
        store.add(rejected); store.add(next)
        store.reject(rejected.id, "Rejected")
        assertNull(store.nextUpload())
        store.pause(false)
        assertEquals(next.id, store.nextUpload()!!.second.id)
        store.disconnect()
        assertNull(store.nextUpload())
        assertEquals(2, store.state.value.captures.size)
    }
}
