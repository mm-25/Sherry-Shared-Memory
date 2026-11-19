package dev.sherry.capture

import androidx.core.view.WindowCompat
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34],qualifiers="night",application=UiTestApplication::class)
class SystemBarUiTest {
    @Test fun lightSherrySurfaceKeepsDarkSystemIconsWhenPhoneUsesDarkTheme() {
        Robolectric.buildActivity(MainActivity::class.java).setup().use { controller ->
            val activity=controller.get()
            val bars=WindowCompat.getInsetsController(activity.window,activity.window.decorView)
            assertTrue("Dark status icons must remain readable on Sherry's white surface",bars.isAppearanceLightStatusBars)
            assertTrue("Dark navigation controls must remain readable on Sherry's white surface",bars.isAppearanceLightNavigationBars)
        }
    }
}
