package dev.sherry.capture

import android.app.UiAutomation
import android.os.Bundle
import android.os.SystemClock
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import dev.sherry.capture.core.ChatGptParser
import dev.sherry.capture.core.ScreenNode
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in checks and the owner's explicit pause action. Never resets or removes saved captures. */
class PhoneCaptureProbe {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val arguments get() = InstrumentationRegistry.getArguments()
    private val store get() = (instrumentation.targetContext.applicationContext as SherryApplication).store

    private fun stateFile() = File(instrumentation.targetContext.noBackupFilesDir, "capture-v1.enc")
    private fun digest(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    private fun emit(value: JSONObject) = instrumentation.sendStatus(0, Bundle().apply {
        putString("stream", "\nSHERRY_PROBE_JSON " + value.toString() + "\n")
    })
    private fun requirePaused() {
        assertNull("Encrypted store must open without recovery/reset", store.storageError)
        assertTrue("Pause capture/sync before this read-only diagnostic", store.state.value.paused)
    }

    /** Diagnostic only: report structure behind visibility boundaries, never save or enable it. */
    private fun diagnosticTree(root: AccessibilityNodeInfo): ScreenRead {
        var count = 0
        var complete = true
        var textCharacters = 0
        val deadline = SystemClock.elapsedRealtime() + 2500
        fun visit(node: AccessibilityNodeInfo, depth: Int): ScreenNode {
            if (++count > 1600 || depth > 96 || SystemClock.elapsedRealtime() > deadline) { complete = false; return ScreenNode(visible = false) }
            val bounds = Rect().also(node::getBoundsInScreen)
            val editable = node.isEditable || node.className?.toString() == "android.widget.EditText"
            val private = editable || node.isPassword
            val text = if (private) "" else node.text?.toString().orEmpty()
            textCharacters += text.length
            if (textCharacters > 120_000) { complete = false; return ScreenNode(visible = false) }
            val children = mutableListOf<ScreenNode>()
            if (!private) for (i in 0 until node.childCount.coerceAtMost(100)) {
                if (!complete) break
                val child = node.getChild(i) ?: continue
                try { children += visit(child, depth + 1) } finally { @Suppress("DEPRECATION") child.recycle() }
            }
            return ScreenNode(packageName = node.packageName?.toString().orEmpty(), className = node.className?.toString().orEmpty(),
                text = text, description = if (private) "" else node.contentDescription?.toString().orEmpty(),
                clickable = node.isClickable, editable = editable, password = node.isPassword, visible = node.isVisibleToUser,
                scrollable = node.isScrollable, left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom, children = children)
        }
        val result = visit(root, 0)
        return ScreenRead(result, complete, count)
    }

    @Test fun inspectPausedStateOnly() {
        assumeTrue(arguments.getString("sherry.inspect") == "true")
        val before = digest(stateFile())
        assertNull("Encrypted store must open without recovery/reset", store.storageError)
        val state = store.state.value
        arguments.getString("sherry.expectedPending")?.toInt()?.let { assertEquals(it, state.captures.size) }
        val result = JSONObject()
            .put("kind", "paused_state_only")
            .put("paused", state.paused)
            .put("pending", state.captures.size)
            .put("hasSavedConnection", state.connection != null)
            .put("automaticChatGptConfigured", state.automaticChatGptCapture)
            .put("withObservationEvidence", state.captures.count { it.event.captureEvidence != null })
            .put("rejected", state.captures.count { it.status == "rejected" })
            .put("frozenPayloads", state.captures.count { it.payload != null })
            .put("storeUnchanged", before == digest(stateFile()))
        assertEquals("Diagnostic must not change the saved store", before, digest(stateFile()))
        emit(result)
    }

    @Test fun applyAuthorizedPauseOnly() {
        assumeTrue(arguments.getString("sherry.pause") == "true")
        assertNull("Encrypted store must open without recovery/reset", store.storageError)
        val before = store.state.value
        arguments.getString("sherry.expectedPending")?.toInt()?.let { assertEquals(it, before.captures.size) }
        store.pause(true)
        SyncScheduler.cancel(instrumentation.targetContext)
        val after = store.state.value
        assertEquals("Only the requested pause setting may change", before.copy(paused = true), after)
        emit(JSONObject().put("kind", "authorized_pause_only").put("wasPaused", before.paused)
            .put("paused", after.paused).put("pending", after.captures.size)
            .put("hasSavedConnection", after.connection != null).put("allOtherStatePreserved", true))
    }

    @Test fun inspectInventedChatOnly() {
        assumeTrue(arguments.getString("sherry.inspect") == "true")
        requirePaused()
        val before = digest(stateFile())
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val root = automation.rootInActiveWindow ?: error("Open the invented ChatGPT test conversation")
        assertEquals("com.openai.chatgpt", root.packageName.toString())
        val diagnostic = arguments.getString("sherry.inspectHiddenStructure") == "true"
        val snapshot = try { if (diagnostic) diagnosticTree(root) else ChatGptScreenReader.read(root) } finally { @Suppress("DEPRECATION") root.recycle() }
        val version = instrumentation.targetContext.packageManager.getPackageInfo("com.openai.chatgpt", 0).versionName.orEmpty()
        val expected = setOf(PROMPT, OBSERVED_PROMPT, "Checking sherry in phone. Reply amber notebook", REPLY)
        val visibleStrings = snapshot.root.descendants().filter { !it.editable && !it.password }.flatMap { sequenceOf(it.text, it.description) }.toSet()
        fun normalized(value: String) = value.trim().trim('"', '“', '”', '.', ' ').replace(Regex("\\s+"), " ").lowercase()
        emit(JSONObject().put("kind", "sentinel_metadata_only").put("appVersion", version)
            .put("complete", snapshot.complete).put("nodeCount", snapshot.nodeCount)
            .put("exactPrompt", visibleStrings.count { it == PROMPT })
            .put("exactReply", visibleStrings.count { it == REPLY })
            .put("normalizedPrompt", visibleStrings.count { normalized(it) == normalized(PROMPT) })
            .put("normalizedReply", visibleStrings.count { normalized(it) == normalized(REPLY) })
            .put("containsPromptMarker", visibleStrings.any { it.contains("Sherry Android layout check A", true) })
            .put("containsReplyMarker", visibleStrings.any { it.contains(REPLY, true) }))
        // The owner rephrased the invented prompt; the physical screen was visually verified.
        // Keep only that bounded known vocabulary, including provider-added speaker wrappers.
        val allowed = expected + setOf("New chat", "Menu", "Edit Menu", "Reply to ChatGPT", "Read aloud", "Share", "More actions", "Copy", "Good response", "Bad response", "ChatGPT", "Send")
        val inventedWords = setOf("check", "checking", "ing", "sherry", "in", "phone", "reply", "amber", "notebook", "you", "said", "chatgpt")
        fun invented(value: String): Boolean {
            val words = Regex("[a-zA-Z]+").findAll(value).map { it.value.lowercase() }.toList()
            return words.containsAll(listOf("amber", "notebook")) && words.all { it in inventedWords }
        }
        val authorizedPrompt = visibleStrings.any { it in expected - REPLY || (invented(it) && it.contains("sherry", true)) }
        val authorizedReply = visibleStrings.any { normalized(it) == normalized(REPLY) || (invented(it) && !it.contains("sherry", true)) }
        assertTrue("Only the authorized invented chat may be exported", authorizedPrompt && authorizedReply)
        fun safe(value: String) = if (value.isBlank() || value in allowed || invented(value)) value else "[other text: ${value.length} characters]"
        fun node(value: ScreenNode): JSONObject = JSONObject()
            .put("packageName", value.packageName).put("className", value.className)
            .put("text", safe(value.text)).put("description", safe(value.description))
            .put("clickable", value.clickable).put("editable", value.editable).put("password", value.password)
            .put("visible", value.visible).put("scrollable", value.scrollable)
            .put("left", value.left).put("top", value.top).put("right", value.right).put("bottom", value.bottom)
            .put("children", JSONArray(value.children.map(::node)))
        emit(JSONObject().put("kind", "redacted_structure_only").put("appVersion", version)
            .put("complete", snapshot.complete).put("nodeCount", snapshot.nodeCount)
            .put("diagnosticAllNodesOnly", diagnostic)
            .put("fixture", node(snapshot.root)))
        val productionRead = ChatGptParser.parse(snapshot.root, version, snapshot.complete)
        // Diagnostic comparison only: never changes the production version guard or saves anything.
        val shapeRead = ChatGptParser.parse(snapshot.root, ChatGptParser.CURRENT_LAYOUT_VERSION, snapshot.complete)
        emit(JSONObject().put("kind", "invented_chat_layout").put("appVersion", version)
            .put("complete", snapshot.complete).put("nodeCount", snapshot.nodeCount)
            .put("productionRecognized", productionRead.recognized)
            .put("knownShapeRecognized", shapeRead.recognized)
            .put("knownShapeRoles", JSONArray(shapeRead.messages.map { it.role }))
            .put("knownShapeLengths", JSONArray(shapeRead.messages.map { it.text.length }))
            .put("fixture", node(snapshot.root))
            .put("storeUnchanged", before == digest(stateFile())))
        assertEquals("Diagnostic must not change the saved store", before, digest(stateFile()))
        assertEquals(listOf("user", "assistant"), productionRead.messages.map { it.role })
        assertTrue("Recognize the actual invented prompt exactly", productionRead.messages.first().text in expected - REPLY)
        // Sentinel identification tolerates punctuation; captured source text is never normalized.
        assertEquals(normalized(REPLY), normalized(productionRead.messages.last().text))
    }

    companion object {
        const val PROMPT = "Sherry Android layout check A. Reply with exactly: amber notebook."
        const val OBSERVED_PROMPT = "Check ing sherry in phone. Reply amber notebook"
        const val REPLY = "amber notebook"
    }
}
