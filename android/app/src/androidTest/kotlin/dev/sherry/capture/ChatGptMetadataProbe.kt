package dev.sherry.capture

import android.app.UiAutomation
import android.os.Bundle
import android.os.Build
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import dev.sherry.capture.core.ChatGptParser
import org.junit.Test

/** Explicit opt-in developer inspection; never run this against an unrelated foreground app. */
class ChatGptMetadataProbe {
    @Test fun inspectAuthorizedTestChat() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("sherry.inspect") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val root = automation.rootInActiveWindow ?: error("No foreground accessibility window")
        assertEquals("com.openai.chatgpt", root.packageName.toString())
        val lines = mutableListOf<String>()
        var count = 0
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (++count > 1600 || depth > 96 || node.isEditable || node.isPassword) return
            val uniqueId = if (Build.VERSION.SDK_INT >= 33) node.uniqueId else null
            val item = node.collectionItemInfo
            val collection = node.collectionInfo
            val bounds = Rect().also(node::getBoundsInScreen)
            if (uniqueId != null || item != null || collection != null || node.isScrollable || !node.text.isNullOrBlank()) {
                lines += "depth=$depth class=${node.className} textLength=${node.text?.length ?: 0} " +
                    "uniqueId=$uniqueId row=${item?.rowIndex} rows=${collection?.rowCount} bounds=$bounds " +
                    "visible=${node.isVisibleToUser} clickable=${node.isClickable} " +
                    "actions=${node.actionList.map { it.id }}"
            }
            for (i in 0 until node.childCount.coerceAtMost(100)) {
                val child = node.getChild(i) ?: continue
                try { walk(child, depth + 1) } finally { @Suppress("DEPRECATION") child.recycle() }
            }
        }
        try {
            walk(root, 0)
            val snapshot = ChatGptScreenReader.read(root)
            val version = instrumentation.targetContext.packageManager.getPackageInfo("com.openai.chatgpt", 0).versionName.orEmpty()
            val parsed = ChatGptParser.parse(snapshot.root, version, snapshot.complete)
            assertTrue(parsed.issue ?: "No messages", parsed.recognized)
            lines += "PARSER PASS: roles=${parsed.messages.map { it.role }} lengths=${parsed.messages.map { it.text.length }} nodes=${snapshot.nodeCount}"
        } finally { @Suppress("DEPRECATION") root.recycle() }
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "\nMETADATA ONLY\n" + lines.joinToString("\n") + "\n") })
    }
}
