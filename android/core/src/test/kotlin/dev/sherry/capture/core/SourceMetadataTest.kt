package dev.sherry.capture.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.test.*

class SourceMetadataTest {
    private val workspace = "7c895c18-05e4-4f96-9148-37ad93b2a789"
    private val at = "2026-10-30T12:00:00Z"

    @Test fun `source metadata delivery requires explicit server support`() {
        assertTrue(supportsSourceMetadata("""{"ok":true,"sourceMetadataVersion":1}"""))
        for (body in listOf(null, "bad", "[]", "{}", """{"ok":true,"captureEvidenceVersion":1}""",
            """{"ok":false,"sourceMetadataVersion":1}""", """{"ok":true,"sourceMetadataVersion":2}""",
            """{"ok":true,"sourceMetadataVersion":"1"}""")) {
            assertFalse(supportsSourceMetadata(body), body)
        }
    }

    @Test fun `capability checks preserve legacy delivery and require every field in the actual batch`() {
        val capture = CaptureFactory.share(Provider.CHATGPT, "Invented text", "Title", now = at)
        val batch = CaptureJson.decodeFromString<CaptureBatch>(CaptureFactory.freeze(capture, workspace, "test-device").payload!!)
        val event = batch.events.single()
        val legacy = batch.copy(events = listOf(event.copy(sourceMetadata = null)))
        assertTrue(supportsCaptureBatchMetadata(legacy, null))
        assertFalse(supportsCaptureBatchMetadata(batch, null))
        assertFalse(supportsCaptureBatchMetadata(batch, """{"ok":true,"captureEvidenceVersion":1}"""))
        assertTrue(supportsCaptureBatchMetadata(batch, """{"ok":true,"sourceMetadataVersion":1}"""))
        val native = batch.copy(events = listOf(event.copy(captureEvidence = CaptureEvidence())))
        assertFalse(supportsCaptureBatchMetadata(native, """{"ok":true,"sourceMetadataVersion":1}"""))
        assertTrue(supportsCaptureBatchMetadata(native, """{"ok":true,"sourceMetadataVersion":1,"captureEvidenceVersion":1}"""))
        val oldNative = native.copy(events = listOf(native.events.single().copy(sourceMetadata = null)))
        assertTrue(supportsCaptureBatchMetadata(oldNative, """{"ok":true,"captureEvidenceVersion":1}"""))
        assertFalse(supportsCaptureBatchMetadata(batch.copy(events = legacy.events + batch.events), null))
    }
    private fun eventJson(capture: LocalCapture) = CaptureJson.parseToJsonElement(
        CaptureFactory.freeze(capture, workspace, "metadata-test-device").payload!!
    ).jsonObject.getValue("events").jsonArray.single().jsonObject

    private fun assertEvidence(event: JsonObject, title: String, messageIdentity: String) {
        val metadata = assertNotNull(event["sourceMetadata"] as? JsonObject)
        assertEquals(1, metadata.getValue("version").jsonPrimitive.int)
        assertEquals(title, metadata.getValue("titleBasis").jsonPrimitive.content)
        assertEquals("local", metadata.getValue("conversationIdentity").jsonPrimitive.content)
        assertEquals(messageIdentity, metadata.getValue("messageIdentity").jsonPrimitive.content)
        assertEquals("observed", metadata.getValue("timestampBasis").jsonPrimitive.content)
        assertEquals("not_inspected", metadata.getValue("linksStatus").jsonPrimitive.content)
        assertEquals("not_inspected", metadata.getValue("attachmentsStatus").jsonPrimitive.content)
        assertEquals(JsonNull, event["messageTimestamp"])
        assertEquals(JsonNull, event["providerMessageId"])
    }

    @Test fun `new native turns classify local evidence without claiming original facts`() {
        val session = NativeSession(java.util.UUID.randomUUID().toString(), at, at)
        val message = ParsedMessage("assistant", "Invented safe reply")
        val merge = NativeReconciler.merge(session, listOf(message), at)
        val capture = CaptureFactory.nativeTurn(merge.session, merge.additions.single().first,
            message, java.util.UUID.randomUUID().toString(), "1.2026.293", at)
        val event = eventJson(capture)
        assertEvidence(event, "generic", "local")
        assertEquals("ChatGPT captured conversation", event.getValue("chatTitle").jsonPrimitive.content)
        assertEquals("android-session:${session.id}", event.getValue("conversationId").jsonPrimitive.content)
        assertEquals("placeholder", event.getValue("captureEvidence").jsonObject.getValue("titleBasis").jsonPrimitive.content)
    }

    @Test fun `manual snapshots classify generic titles and local sequence`() {
        val capture = CaptureFactory.nativeSnapshot(listOf(ParsedMessage("user", "Invented question")),
            java.util.UUID.randomUUID().toString(), "1.2026.293", at).single()
        assertEvidence(eventJson(capture), "generic", "local")
    }

    @Test fun `owner entered titles and provider links do not confer provider identity`() {
        for (provider in Provider.entries) {
            val capture = CaptureFactory.share(provider, "https://chatgpt.com/share/invented", "My chosen title", now = at)
            assertEvidence(eventJson(capture), "user", "local")
        }
    }

    @Test fun `legacy frozen bytes survive reload retry and new device metadata`() {
        val fresh = CaptureFactory.freeze(CaptureFactory.share(Provider.CHATGPT, "Invented legacy text", "Old title", now = at), workspace, "original-test-device")
        val batch = CaptureJson.parseToJsonElement(fresh.payload!!).jsonObject
        val oldEvent = JsonObject(batch.getValue("events").jsonArray.single().jsonObject - "sourceMetadata")
        val oldPayload = JsonObject(batch + ("events" to JsonArray(listOf(oldEvent)))).toString()
        val local = CaptureJson.parseToJsonElement(CaptureJson.encodeToString(fresh)).jsonObject
        val oldLocal = JsonObject(local + mapOf("event" to oldEvent, "payload" to JsonPrimitive(oldPayload))).toString()
        val restored = CaptureJson.decodeFromString<LocalCapture>(oldLocal)
        val retried = CaptureFactory.freeze(restored, workspace, "new-test-device")
        assertEquals(oldPayload, retried.payload)
        assertEquals(fresh.id, retried.id)
        assertEquals(fresh.event.eventId, retried.event.eventId)
        assertEquals(fresh.event.conversationId, retried.event.conversationId)
        assertEquals("original-test-device", CaptureJson.decodeFromString<CaptureBatch>(retried.payload!!).captureClient.deviceId)
        // Pending, never-frozen legacy captures retain unknown metadata as well.
        val pending = restored.copy(payload = null)
        val frozenEvent = eventJson(pending)
        assertTrue(frozenEvent["sourceMetadata"] == null || frozenEvent["sourceMetadata"] == JsonNull)
    }
}
