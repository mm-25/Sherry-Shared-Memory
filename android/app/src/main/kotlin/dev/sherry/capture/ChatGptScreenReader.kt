package dev.sherry.capture

import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import dev.sherry.capture.core.ScreenNode

data class ScreenRead(val root: ScreenNode, val complete: Boolean, val nodeCount: Int)

/** Bounded detached snapshot. Run off the main thread; each child node is released immediately. */
object ChatGptScreenReader {
    fun read(root: AccessibilityNodeInfo): ScreenRead {
        val deadline = SystemClock.elapsedRealtime() + 2500
        var visited = 0
        var textCharacters = 0
        var complete = true
        fun visit(node: AccessibilityNodeInfo, depth: Int): ScreenNode {
            if (++visited > 1600 || depth > 96 || SystemClock.elapsedRealtime() > deadline) {
                complete = false
                return ScreenNode(visible = false)
            }
            val bounds = Rect().also(node::getBoundsInScreen)
            val editable = node.isEditable || node.className?.toString() == "android.widget.EditText"
            val private = editable || node.isPassword
            val visible = node.isVisibleToUser
            val text = if (private || !visible) "" else node.text?.toString().orEmpty()
            textCharacters += text.length
            if (textCharacters > 120_000) { complete = false; return ScreenNode(visible = false) }
            val children = mutableListOf<ScreenNode>()
            // A structural wrapper can report invisible while its message child is
            // explicitly visible. Inspect children, retaining only each visible node's
            // own text. Editable/password subtrees remain entirely excluded.
            if (!private) {
                if (node.childCount > 100) complete = false
                for (i in 0 until node.childCount.coerceAtMost(100)) {
                    if (!complete) break
                    val child = node.getChild(i)
                    if (child == null) { complete = false; break }
                    try { children += visit(child, depth + 1) } finally { @Suppress("DEPRECATION") child.recycle() }
                }
            }
            return ScreenNode(packageName = node.packageName?.toString().orEmpty(), className = node.className?.toString().orEmpty(),
                text = text, description = if (private || !visible) "" else node.contentDescription?.toString().orEmpty(),
                clickable = node.isClickable, editable = editable, password = node.isPassword,
                visible = visible, scrollable = node.isScrollable, selected = node.isSelected, checked = node.isChecked,
                left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom, children = children)
        }
        val snapshot = visit(root, 0)
        return ScreenRead(snapshot, complete, visited)
    }
}
