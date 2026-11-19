package dev.sherry.capture.core

import kotlin.test.Test
import kotlin.test.assertEquals

class AutomaticWindowTest {
    @Test fun excludesClippedEdgesWithoutBreakingMessageOrder() {
        val top = ParsedMessage("assistant", "top fragment", "possibly_clipped")
        val user = ParsedMessage("user", "question")
        val assistant = ParsedMessage("assistant", "answer")
        val bottom = ParsedMessage("user", "bottom fragment", "possibly_clipped")
        assertEquals(listOf(user, assistant), AutomaticWindow.completeTurns(listOf(top, user, assistant, bottom)))
        assertEquals(emptyList(), AutomaticWindow.completeTurns(listOf(top, bottom)))
    }

    @Test fun refusesAnInternalFragment() {
        val user = ParsedMessage("user", "question")
        val clipped = ParsedMessage("assistant", "fragment", "possibly_clipped")
        val next = ParsedMessage("user", "next")
        assertEquals(emptyList(), AutomaticWindow.completeTurns(listOf(user, clipped, next)))
    }
}
