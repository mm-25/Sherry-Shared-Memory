package dev.sherry.capture.core

/** Detached accessibility data. Never includes editable/password text. */
data class ScreenNode(
    val packageName: String = "com.openai.chatgpt",
    val className: String = "android.view.View",
    val text: String = "",
    val description: String = "",
    val clickable: Boolean = false,
    val editable: Boolean = false,
    val password: Boolean = false,
    val visible: Boolean = true,
    val scrollable: Boolean = false,
    val selected: Boolean = false,
    val checked: Boolean = false,
    val left: Int = 0,
    val top: Int = 0,
    val right: Int = 0,
    val bottom: Int = 0,
    val children: List<ScreenNode> = emptyList(),
) {
    fun descendants(): Sequence<ScreenNode> = sequence {
        yield(this@ScreenNode)
        if (!editable && !password) children.forEach { yieldAll(it.descendants()) }
    }
}

@kotlinx.serialization.Serializable
data class ParsedMessage(val role: String, val text: String, val completeness: String = "unknown")
data class ChatGptRead(val messages: List<ParsedMessage> = emptyList(), val issue: String? = null) {
    val recognized get() = issue == null && messages.isNotEmpty()
}

/** English text-only Pixel layouts with explicit speaker evidence. Fail closed on unknown rows. */
object ChatGptParser {
    const val VERIFIED_VERSION = "1.2026.265"
    const val CURRENT_LAYOUT_VERSION = "1.2026.286"
    // Version is provenance, not proof of layout compatibility. Every read still requires
    // the complete, unambiguous conversation chrome, speaker and privacy checks below.
    fun validVersionMetadata(appVersion: String): Boolean = appVersion.matches(Regex("[0-9]{1,3}\\.[0-9]{4}\\.[0-9]{1,5}(\\.[0-9]{1,5})?"))
    fun parse(root: ScreenNode, appVersion: String, complete: Boolean = true): ChatGptRead {
        if (root.packageName != Provider.CHATGPT.packageName) return ChatGptRead(issue = "Open ChatGPT to inspect its messages.")
        if (!validVersionMetadata(appVersion)) return ChatGptRead(issue = "ChatGPT app version could not be read. Capture will retry.")
        if (!complete) return ChatGptRead(issue = "The screen exceeded the reading limit; no partial message was accepted.")
        val nodes = root.descendants().filter { it.visible && !it.editable && !it.password }.toList()
        val descriptions = nodes.map { it.description }.toSet()
        if (!descriptions.containsAll(setOf("New chat", "Menu", "Edit Menu", "Reply to ChatGPT"))) {
            return ChatGptRead(issue = "Open an ordinary ChatGPT conversation. Menus and other layouts are not supported yet.")
        }
        if (ChatGptScreenSignals.isResponding(root)) {
            return ChatGptRead(issue = "Waiting for ChatGPT to finish responding.")
        }
        val candidates = nodes.filter { node ->
            node.scrollable && node.right - node.left >= (root.right - root.left) * 0.8 &&
                node.descendants().any { it.description == "Read aloud" }
        }
        val transcript = if (candidates.size == 1) candidates.single() else {
            if (candidates.isNotEmpty()) {
                return ChatGptRead(issue = "Could not identify one conversation message list.")
            }
            // This observed layout no longer marks the list scrollable. Require one
            // container with multiple independently recognized rows, outside the composer.
            val structural = nodes.filter { node ->
                node.right - node.left >= (root.right - root.left) * 0.8 &&
                    node.children.count { row -> row.descendants().any {
                        it.visible && !it.editable && !it.password && it.className == "android.widget.TextView" && it.text.isNotBlank()
                    } } >= 2 &&
                    node.descendants().none { it.description == "Reply to ChatGPT" || it.editable || it.password } &&
                    node.descendants().any { it.visible && it.description == "Read aloud" } &&
                    readRows(node, root).recognized
            }
            if (structural.size != 1) return ChatGptRead(issue = "Could not identify one conversation message list.")
            structural.single()
        }
        val messageNodes = transcript.descendants().toList()
        if (nodes.any { node ->
                (node.text.equals("Temporary chat", true) || node.description.equals("Temporary chat", true)) &&
                    messageNodes.none { it === node }
            }) return ChatGptRead(issue = "Temporary chats are not captured.")
        return readRows(transcript, root)
    }

    /** The observed first-response layout: one posted user row followed by an unfinished AI row. */
    fun parseStreamingPrefix(root:ScreenNode,appVersion:String,complete:Boolean=true):ChatGptRead {
        fun unsupported()=ChatGptRead(issue="Waiting for supported posted user text.")
        if(root.packageName!=Provider.CHATGPT.packageName||!validVersionMetadata(appVersion)||!complete)return unsupported()
        val nodes=root.descendants().filter{it.visible&&!it.editable&&!it.password}.toList()
        val descriptions=nodes.map{it.description}.toSet()
        if(!descriptions.containsAll(setOf("New chat","Menu","Edit Menu"))||!ChatGptScreenSignals.isResponding(root)||
            "Read aloud" in descriptions)return unsupported()
        val width=root.right-root.left
        if(width<=0)return unsupported()
        val headerBottom=nodes.filter{it.description in setOf("Menu","New chat","Edit Menu")&&it.top<root.top+width*.35}.maxOfOrNull{it.bottom}?:return unsupported()
        val candidates=nodes.filter { node->
            if(node.right-node.left<width*.8||node.children.size!=2||
                node.descendants().any{it.editable||it.password||it.description=="Reply to ChatGPT"})return@filter false
            val first=node.children[0];val second=node.children[1]
            if(first.top<headerBottom||first.top>headerBottom+width*.2||second.top<first.bottom||
                second.right-second.left<width*.8)return@filter false
            val row=readRows(ScreenNode(children=listOf(first)),root)
            if(!row.recognized||row.messages.size!=1||row.messages.single().role!="user")return@filter false
            val bubble=first.descendants().filter{it.visible&&it.clickable&&!it.editable&&!it.password}.singleOrNull()
                ?:return@filter false
            first.bottom-first.top<=bubble.bottom-bubble.top+width*.15
        }
        if(candidates.size!=1)return unsupported()
        val transcript=candidates.single()
        val inside=transcript.descendants().toList()
        if(nodes.any{n->(n.text.equals("Temporary chat",true)||n.description.equals("Temporary chat",true))&&inside.none{it===n}})
            return ChatGptRead(issue="Temporary chats are not captured.")
        // Never inspect the unknown AI row as a speaker or include progress/partial reply text.
        return readRows(ScreenNode(children=listOf(transcript.children.first())),root)
    }

    private fun readRows(transcript: ScreenNode, root: ScreenNode): ChatGptRead {
        val messages = mutableListOf<ParsedMessage>()
        for (row in transcript.children) {
            val contents = row.descendants().filter { it.visible && !it.editable && !it.password }.toList()
            if (contents.any { it.packageName != Provider.CHATGPT.packageName }) return ChatGptRead(issue = "Unexpected content in the conversation.")
            val textNodes = contents.filter { it.className == "android.widget.TextView" && it.text.isNotBlank() }
            if (textNodes.isEmpty()) continue
            val controls = contents.map { it.description }.filter { it.isNotBlank() }.toSet()
            val role = if (controls.containsAll(setOf("Read aloud", "Share", "More actions"))) {
                "assistant"
            } else {
                // The observed user row has one right-inset clickable text bubble and no action buttons.
                val bubbles = contents.filter { node ->
                    node.clickable && node.left > row.left + (row.right - row.left) * 0.05 &&
                        node.descendants().count { it.className == "android.widget.TextView" && it.text.isNotBlank() } == textNodes.size
                }
                if (controls.isNotEmpty() || contents.any { it.className == "android.widget.Button" } || bubbles.size != 1) {
                    return ChatGptRead(issue = "An unfinished or unfamiliar message is visible. Waiting for a recognized layout.")
                }
                "user"
            }
            val lines = mutableListOf<String>()
            for (node in textNodes) {
                val text = node.text.trim()
                if (lines.lastOrNull()?.matches(Regex("\\d+\\.")) == true) lines[lines.lastIndex] += " $text"
                else lines += text
            }
            val text = lines.joinToString("\n")
            if (text.length > CaptureFactory.MAX_TEXT) return ChatGptRead(issue = "This message exceeds the current capture size limit.")
            val clipped = textNodes.any { it.top < root.top || it.bottom > root.bottom || it.left < root.left || it.right > root.right } ||
                row.descendants().any { !it.visible && it.className == "android.widget.TextView" }
            messages += ParsedMessage(role, text, if (clipped) "possibly_clipped" else "unknown")
        }
        if (messages.isEmpty()) return ChatGptRead(issue = "No complete text messages were recognized.")
        if (messages.size > 100) return ChatGptRead(issue = "Too many messages for this capture proof.")
        return ChatGptRead(messages)
    }
}
