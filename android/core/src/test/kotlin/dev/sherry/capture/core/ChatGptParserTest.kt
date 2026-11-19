package dev.sherry.capture.core

import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import kotlin.test.*
import kotlinx.serialization.json.*

class ChatGptParserTest {
    private fun currentFixture(version: String = "1.2026.286"): ScreenNode {
        return capturedFixture("chatgpt-$version-pixel-redacted")
    }
    private fun capturedFixture(name:String):ScreenNode {
        val source = javaClass.getResourceAsStream("/fixtures/$name.json")!!.bufferedReader().use { it.readText() }
        fun node(value: JsonObject): ScreenNode {
            fun text(key: String) = value.getValue(key).jsonPrimitive.content
            fun flag(key: String) = value.getValue(key).jsonPrimitive.boolean
            fun number(key: String) = value.getValue(key).jsonPrimitive.int
            return ScreenNode(packageName = text("packageName"), className = text("className"), text = text("text"), description = text("description"),
                clickable = flag("clickable"), editable = flag("editable"), password = flag("password"), visible = flag("visible"), scrollable = flag("scrollable"),
                left = number("left"), top = number("top"), right = number("right"), bottom = number("bottom"),
                children = value.getValue("children").jsonArray.map { node(it.jsonObject) })
        }
        return node(CaptureJson.parseToJsonElement(source).jsonObject)
    }

    private fun withStop(root:ScreenNode):ScreenNode {
        val actual=capturedFixture("chatgpt-1.2026.293-thinking-redacted")
        val composer=actual.descendants().filter{n->n.descendants().any{it.editable}&&n.descendants().any{it.description=="Stop"}}
            .minBy{(it.right-it.left).toLong()*(it.bottom-it.top)}
        val target=root.descendants().filter{n->n.descendants().any{it.editable}&&n.descendants().any{it.description=="Reply to ChatGPT"}}
            .minBy{(it.right-it.left).toLong()*(it.bottom-it.top)}
        return map(root){if(it==target)composer else it}
    }

    @Test fun `actual first-response frames expose only the posted user while AI text remains unfinished`() {
        for(stage in listOf("thinking","composer-transition","empty-reply","streamed-reply")) {
            val result=ChatGptParser.parseStreamingPrefix(capturedFixture("chatgpt-1.2026.293-$stage-redacted"),"1.2026.293")
            assertTrue(result.recognized,result.issue)
            assertEquals(listOf("user"),result.messages.map{it.role})
            assertEquals("Sherry reliability oct28nav01 A. Reply with exactly: amber notebook.",result.messages.single().text)
        }
        assertFalse(ChatGptParser.parseStreamingPrefix(capturedFixture("chatgpt-1.2026.293-complete-reply-redacted"),"1.2026.293").recognized)
    }
    @Test fun `streaming prefix keeps temporary private truncated and ambiguous screens excluded`() {
        val base=capturedFixture("chatgpt-1.2026.293-thinking-redacted")
        assertFalse(ChatGptParser.parseStreamingPrefix(base.copy(children=base.children+ScreenNode(text="Temporary chat")),"1.2026.293").recognized)
        assertFalse(ChatGptParser.parseStreamingPrefix(base,"1.2026.293",false).recognized)
        assertFalse(ChatGptParser.parseStreamingPrefix(base.copy(packageName="other.app"),"1.2026.293").recognized)
        assertFalse(ChatGptParser.parseStreamingPrefix(base.copy(children=listOf(base,base)),"1.2026.293").recognized)
        assertFalse(ChatGptParser.parseStreamingPrefix(map(base){if(it.clickable&&it.left>300)it.copy(clickable=false)else it},"1.2026.293").recognized)
        val private=map(base){if(it.editable)it.copy(text="UNSENT SECRET",children=listOf(ScreenNode(text="UNSENT SECRET",className="android.widget.TextView")))else it}
        val read=ChatGptParser.parseStreamingPrefix(private,"1.2026.293")
        assertTrue(read.recognized)
        assertTrue(read.messages.none{"SECRET" in it.text})
    }

    @Test fun `an AI progress label cannot impersonate a header control during first-user reading`() {
        val frame=map(capturedFixture("chatgpt-1.2026.293-thinking-redacted")){if(it.text=="[redacted]")it.copy(description="Menu")else it}
        val read=ChatGptParser.parseStreamingPrefix(frame,"1.2026.293")
        assertTrue(read.recognized,read.issue)
        assertEquals(listOf("user"),read.messages.map{it.role})
    }
    @Test fun `Stop generating text in a completed AI message is ordinary memory content`() {
        val frame=map(capturedFixture("chatgpt-1.2026.293-complete-reply-redacted")){
            it.copy(text=if(it.text=="amber notebook.")"Stop generating"else it.text,
                description=if(it.description=="amber notebook.")"Stop generating"else it.description)}
        val read=ChatGptParser.parse(frame,"1.2026.293")
        assertTrue(read.recognized,read.issue)
        assertEquals("Stop generating",read.messages.last().text)
    }
    @Test fun `unchanged positively recognized layout survives a provider version update through frozen upload`() {
        val version="1.2026.294"
        val read=ChatGptParser.parse(currentFixture("1.2026.293"),version)
        assertTrue(read.recognized,read.issue)
        val at="2026-10-27T16:00:00Z"
        val merge=NativeReconciler.merge(NativeSession(java.util.UUID.randomUUID().toString(),at,at),read.messages,at)
        val payloads=merge.additions.map { (turn,message)->CaptureFactory.freeze(
            CaptureFactory.nativeTurn(merge.session,turn,message,java.util.UUID.randomUUID().toString(),version,at),
            "7c895c18-05e4-4f96-9148-37ad93b2a789","version-update-test").payload!! }
        assertEquals(read.messages.map{it.text},payloads.map{CaptureJson.decodeFromString<CaptureBatch>(it).events.single().text})
        assertTrue(payloads.all{CaptureJson.decodeFromString<CaptureBatch>(it).captureClient.appVersion==version})
        assertFalse(ChatGptParser.parse(ScreenNode(),version).recognized)
    }

    @Test fun `new live 293 layout retains both speakers and exact punctuation`() {
        val result = ChatGptParser.parse(currentFixture("1.2026.293"), "1.2026.293")
        assertNull(result.issue)
        assertEquals(listOf("user", "assistant"), result.messages.map { it.role })
        assertEquals(listOf("Sherry Android layout check A. Reply with exactly: amber notebook.", "amber notebook."), result.messages.map { it.text })
    }

    @Test fun `new live shape already matches the checked 286 structural reader`() {
        val visibleOnly = map(currentFixture("1.2026.293")) {
            if (!it.visible) it.copy(text = "", description = "") else it
        }
        val result = ChatGptParser.parse(visibleOnly, "1.2026.286")
        assertNull(result.issue)
        assertEquals(listOf("user", "assistant"), result.messages.map { it.role })
        assertEquals("amber notebook.", result.messages.last().text)
    }

    @Test fun `checked real layouts can be saved and frozen with their actual provider version`() {
        val at = "2026-10-27T15:00:00Z"
        for ((version, root) in listOf("1.2026.265" to fixture(), "1.2026.286" to currentFixture(), "1.2026.293" to currentFixture("1.2026.293"))) {
            val read = ChatGptParser.parse(root, version)
            assertTrue(read.recognized)
            val session = NativeSession(java.util.UUID.randomUUID().toString(), at, at)
            val merged = NativeReconciler.merge(session, read.messages, at)
            val captures = merged.additions.map { (turn,message) -> CaptureFactory.nativeTurn(merged.session, turn, message, java.util.UUID.randomUUID().toString(), version, at) }
            val payloads = captures.map { CaptureFactory.freeze(it,"7c895c18-05e4-4f96-9148-37ad93b2a789","pipeline-test-device") }
            assertEquals(read.messages.map { it.text }, payloads.map { CaptureJson.decodeFromString<CaptureBatch>(it.payload!!).events.single().text })
            assertTrue(payloads.all { CaptureJson.decodeFromString<CaptureBatch>(it.payload!!).captureClient.appVersion == version })
            assertEquals(0,NativeReconciler.merge(merged.session,read.messages,at).additions.size)
            assertEquals(read.messages.size,CaptureFactory.nativeSnapshot(read.messages,session.id,version,at).size)
        }
        assertFailsWith<IllegalArgumentException> { CaptureFactory.nativeSnapshot(listOf(ParsedMessage("user","invented")),java.util.UUID.randomUUID().toString(),"unknown-version",at) }
    }

    @Test fun `293 keeps existing privacy streaming ambiguity and unknown version protections`() {
        val base = currentFixture("1.2026.293")
        val privateText = map(base) {
            if (it.editable) it.copy(text = "UNSENT SECRET", children = listOf(ScreenNode(text = "UNSENT SECRET", className = "android.widget.TextView"))) else it
        }.let { it.copy(children = it.children + ScreenNode(visible = false, text = "HIDDEN SECRET", className = "android.widget.TextView")) }
        val read = ChatGptParser.parse(privateText, "1.2026.293")
        assertTrue(read.recognized)
        assertEquals(2, read.messages.size)
        assertFalse(read.messages.any { "SECRET" in it.text })
        assertFalse(ChatGptParser.parse(withStop(base), "1.2026.293").recognized)
        assertFalse(ChatGptParser.parse(base.copy(children = base.children + ScreenNode(text = "Temporary chat")), "1.2026.293").recognized)
        assertFalse(ChatGptParser.parse(base.copy(children = listOf(base,base)), "1.2026.293").recognized)
        assertTrue(ChatGptParser.parse(base, "1.2026.999").recognized)
        assertFalse(ChatGptParser.parse(base, "1.2026.293", complete = false).recognized)
    }

    @Test fun `current real layout recognizes exact messages without a scrollable flag`() {
        val result = ChatGptParser.parse(currentFixture(), "1.2026.286")
        assertNull(result.issue)
        assertEquals(listOf("user", "assistant"), result.messages.map { it.role })
        assertEquals(listOf("Check ing sherry in phone. Reply amber notebook", "amber notebook"), result.messages.map { it.text })
        assertTrue(result.messages.all { it.completeness == "unknown" })
    }

    @Test fun `current layout keeps editable and invisible text out of results`() {
        val fixture = map(currentFixture()) {
            if (it.editable) it.copy(text = "UNSENT SECRET", children = listOf(ScreenNode(text = "UNSENT SECRET", className = "android.widget.TextView"))) else it
        }.let { it.copy(children = it.children + ScreenNode(visible = false, text = "HIDDEN SECRET", className = "android.widget.TextView")) }
        val result = ChatGptParser.parse(fixture, "1.2026.286")
        assertTrue(result.recognized)
        assertEquals(2, result.messages.size)
        assertFalse(result.messages.any { "SECRET" in it.text })
    }

    @Test fun `current layout rejects two possible conversation lists`() {
        val fixture = currentFixture()
        val root = fixture.copy(children = listOf(fixture, fixture))
        assertFalse(ChatGptParser.parse(root, "1.2026.286").recognized)
    }

    @Test fun `current layout rejects missing speaker evidence and unfinished replies`() {
        val fixture = currentFixture()
        assertFalse(ChatGptParser.parse(map(fixture) { if (it.description == "Read aloud") it.copy(description = "") else it }, "1.2026.286").recognized)
        assertFalse(ChatGptParser.parse(map(fixture) { if (it.clickable && it.left > 300) it.copy(clickable = false) else it }, "1.2026.286").recognized)
        assertFalse(ChatGptParser.parse(withStop(fixture), "1.2026.286").recognized)
        assertFalse(ChatGptParser.parse(fixture, "future-version").recognized)
    }

    @Test fun `a recognized temporary chat label prevents capture`() {
        val old = fixture().let { it.copy(children = it.children + ScreenNode(text = "Temporary chat", className = "android.widget.TextView")) }
        assertFalse(ChatGptParser.parse(old, ChatGptParser.VERIFIED_VERSION).recognized)
    }

    @Test fun `temporary chat words in a user message are not a mode switch`() {
        val old = map(fixture()) { if (it.text == "First test prompt") it.copy(text = "Temporary chat") else it }
        val current = map(currentFixture()) { if (it.text == "Check ing sherry in phone. Reply amber notebook") it.copy(text = "Temporary chat") else it }
        for ((root, version) in listOf(old to ChatGptParser.VERIFIED_VERSION, current to "1.2026.286")) {
            val result = ChatGptParser.parse(root, version)
            assertTrue(result.recognized)
            assertEquals("Temporary chat", result.messages.first().text)
            assertEquals("user", result.messages.first().role)
        }
    }

    private fun fixture(): ScreenNode {
        val document = DocumentBuilderFactory.newInstance().apply {
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }.newDocumentBuilder().parse(javaClass.getResourceAsStream("/fixtures/chatgpt-1.2026.265-pixel.xml"))
        fun node(element: Element): ScreenNode {
            val bounds = Regex("-?\\d+").findAll(element.getAttribute("bounds")).map { it.value.toInt() }.toList()
            return ScreenNode(packageName = element.getAttribute("package"), className = element.getAttribute("class"),
                text = element.getAttribute("text"), description = element.getAttribute("content-desc"),
                clickable = element.getAttribute("clickable") == "true", editable = element.getAttribute("class") == "android.widget.EditText",
                password = element.getAttribute("password") == "true", scrollable = element.getAttribute("scrollable") == "true",
                left = bounds[0], top = bounds[1], right = bounds[2], bottom = bounds[3],
                children = (0 until element.childNodes.length).mapNotNull { element.childNodes.item(it) as? Element }.map(::node))
        }
        return node(document.documentElement.firstChild as Element)
    }
    private fun map(root: ScreenNode, transform: (ScreenNode) -> ScreenNode): ScreenNode = transform(root.copy(children = root.children.map { map(it, transform) }))

    @Test fun `real deep layout yields four messages with correct roles and list content`() {
        val result = ChatGptParser.parse(fixture(), ChatGptParser.VERIFIED_VERSION)
        assertNull(result.issue)
        assertEquals(listOf("user", "assistant", "user", "assistant"), result.messages.map { it.role })
        assertEquals("First test prompt", result.messages[0].text)
        assertEquals("1. First sample tip.\n2. Second sample tip.\n3. Third sample tip.", result.messages.last().text)
        assertFalse(result.messages.any { "Read aloud" in it.text || "Reply to ChatGPT" in it.text })
    }
    @Test fun `screen edge clipping is reported without claiming complete messages`() {
        val root = map(fixture()) { if (it.text == "First test prompt") it.copy(top = -100) else it }
        val result = ChatGptParser.parse(root, ChatGptParser.VERIFIED_VERSION)
        assertTrue(result.recognized)
        assertEquals("possibly_clipped", result.messages.first().completeness)
        assertTrue(result.messages.all { it.completeness in setOf("unknown", "possibly_clipped") })
    }

    @Test fun `composer contents never enter the transcript`() {
        val root = map(fixture()) { if (it.editable) it.copy(text = "UNSENT SECRET", children = listOf(ScreenNode(text = "UNSENT SECRET", className = "android.widget.TextView"))) else it }
        val result = ChatGptParser.parse(root, ChatGptParser.VERIFIED_VERSION)
        assertTrue(result.recognized)
        assertFalse(result.messages.any { "UNSENT" in it.text })
    }
    @Test fun `unknown version truncated trees and wrong packages fail closed`() {
        assertFalse(ChatGptParser.parse(fixture(), "next-version").recognized)
        assertFalse(ChatGptParser.parse(fixture(), ChatGptParser.VERIFIED_VERSION, false).recognized)
        assertFalse(ChatGptParser.parse(fixture().copy(packageName = "other.app"), ChatGptParser.VERIFIED_VERSION).recognized)
    }
    @Test fun `unfinished assistant controls are not misclassified as user text`() {
        val root = map(fixture()) { if (it.description == "Read aloud") it.copy(description = "") else it }
        assertFalse(ChatGptParser.parse(root, ChatGptParser.VERIFIED_VERSION).recognized)
    }
    @Test fun `identical messages are retained at separate positions`() {
        val root = map(fixture()) { if (it.text == "Second test prompt") it.copy(text = "First test prompt") else it }
        val result = ChatGptParser.parse(root, ChatGptParser.VERIFIED_VERSION)
        assertEquals(2, result.messages.count { it.text == "First test prompt" })
    }
    @Test fun `active streaming signal prevents accepting a final reply`() {
        val root = withStop(fixture())
        assertFalse(ChatGptParser.parse(root, ChatGptParser.VERIFIED_VERSION).recognized)
    }
}
