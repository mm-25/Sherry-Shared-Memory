package dev.sherry.capture.core

/** Keep one contiguous run of complete-looking visible turns. Never auto-save edge fragments. */
object AutomaticWindow {
    fun completeTurns(messages: List<ParsedMessage>): List<ParsedMessage> {
        val first = messages.indexOfFirst { it.completeness != "possibly_clipped" }
        val last = messages.indexOfLast { it.completeness != "possibly_clipped" }
        if (first < 0 || last < first) return emptyList()
        val middle = messages.subList(first, last + 1)
        return if (middle.any { it.completeness == "possibly_clipped" }) emptyList() else middle
    }
}
