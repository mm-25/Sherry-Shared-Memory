package dev.sherry.capture.verifier

import java.security.MessageDigest
import java.security.SecureRandom

/** Diagnostic policy, not a capture parser. No private source strings leave the test process. */
class TraceRedaction(private val run: String, private val salt: ByteArray = ByteArray(32).also(SecureRandom()::nextBytes)) {
    init { require(run.matches(Regex("[a-zA-Z0-9-]{1,32}"))) }
    private val replies=listOf("amber notebook","cedar window","linen lantern","silver ladder","cobalt garden")
    private val controls=setOf("New chat","Menu","Edit Menu","Reply to ChatGPT","Ask ChatGPT","Read aloud","Share","More actions","Copy",
        "Send Message","Send","Stop","Stop generating","Stop response","Attachment","Dictation","Start a voice conversation",
        "ChatGPT","Chat","Work","Chats","Library","Projects","Settings","Recent chats","New project","Today","Yesterday","Rename","Rename chat","Rename conversation","Save","Save changes","Done","Cancel","Search","Search chats","Temporary chat","You","Back")
    fun prompt(label: String): String {
        val i="ABCDE".indexOf(label).also { require(it>=0&&label.length==1) }
        return "Sherry reliability $run $label. Reply with exactly: ${replies[i]}."
    }
    fun title(label: String): String { require(label.length==1&&label in "ABCDE");return "Sherry reliability $run $label" }
    fun text(raw: String, privateField: Boolean=false): String {
        if(privateField||raw.isEmpty())return ""
        if(raw in controls || raw in "ABCDE".flatMap { listOf(prompt(it.toString()),title(it.toString())) } ||
            raw=="Sherry Android layout check A. Reply with exactly: amber notebook." ||
            replies.any { raw==it||raw=="$it." })return raw
        return "[redacted]"
    }
    fun identifier(raw: String?,privateField:Boolean=false):String? {
        if(privateField||raw.isNullOrEmpty())return null
        return MessageDigest.getInstance("SHA-256").apply{update(salt)}.digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString(""){"%02x".format(it)}
    }
}
