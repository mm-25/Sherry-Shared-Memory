package dev.sherry.capture.verifier

import kotlin.test.*

class TraceRedactionTest {
    @Test fun `only controls and exact invented text are retained`() {
        val p=TraceRedaction("run123",ByteArray(32){7})
        assertEquals("New chat",p.text("New chat"))
        assertEquals(p.prompt("A"),p.text(p.prompt("A")))
        assertEquals("amber notebook.",p.text("amber notebook."))
        assertEquals("[redacted]",p.text("My private project and account details"))
        assertEquals("[redacted]",p.text(p.prompt("A")+" private suffix"))
        assertEquals("[redacted]",p.text("Bearer secret-token"))
        assertEquals("",p.text(""))
    }
    @Test fun `a change beyond the initial screen wrappers changes the diagnostic fingerprint`() {
        val p=TraceRedaction("run123",ByteArray(32){7})
        val unchangedWrappers="x".repeat(12_000)
        assertNotEquals(p.identifier(unchangedWrappers+"chat A"),p.identifier(unchangedWrappers+"chat B"))
    }
    @Test fun `private fields never expose text or descriptions`() {
        val p=TraceRedaction("run123",ByteArray(32){7})
        assertEquals("",p.text("amber notebook",privateField=true))
        assertEquals("",p.text("New chat",privateField=true))
        assertNull(p.identifier("private password",privateField=true))
    }
    @Test fun `identifiers can be compared within one trace without exposing raw values`() {
        val p=TraceRedaction("run123",ByteArray(32){7})
        val id="provider-chat-private-id"
        assertEquals(p.identifier(id),p.identifier(id))
        assertNotEquals(p.identifier(id),p.identifier("another-chat"))
        assertNotEquals(p.identifier(id),TraceRedaction("run123",ByteArray(32){8}).identifier(id))
        assertFalse(p.identifier(id)!!.contains(id))
        assertEquals(64,p.identifier(id)!!.length)
        assertNull(p.identifier(null));assertNull(p.identifier(""))
    }
}
