package dev.sherry.capture

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ShareFlowTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun sharedTextRequiresSaveAndSurvivesActivityRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as SherryApplication
        val originalCount = app.store.state.value.captures.size
        val text = "Android share flow verification ${java.util.UUID.randomUUID()}"
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_SEND
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            compose.onNodeWithText(text).assertExists()
            assertEquals(originalCount, app.store.state.value.captures.size)
            scenario.recreate()
            compose.onNodeWithText(text).assertExists()
            compose.onNodeWithText("Save capture").performScrollTo().performClick()
            compose.waitUntil(10_000) { app.store.state.value.captures.size == originalCount + 1 }
            compose.onNodeWithText("Safe on this phone.").assertExists()
            val saved = app.store.state.value.captures.last()
            assertEquals(text, saved.event.text)
            assertEquals("unknown", saved.event.role)
            assertTrue(app.store.state.value.paused)
            assertNull(app.store.state.value.connection)
            app.store.remove(saved.id)
        }
    }
}
