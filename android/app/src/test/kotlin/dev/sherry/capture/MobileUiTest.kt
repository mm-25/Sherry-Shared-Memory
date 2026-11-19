package dev.sherry.capture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.inspector.WindowInspector
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import dev.sherry.capture.core.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[34],qualifiers="w412dp-h844dp-mdpi",application=UiTestApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MobileUiTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
    private fun model()=CaptureViewModel(RuntimeEnvironment.getApplication())
    private fun shot(name:String) {
        lateinit var bitmap:Bitmap
        compose.runOnIdle {
            val view=WindowInspector.getGlobalWindowViews().lastOrNull{it.isShown&&it.width>0}
                ?: compose.activity.window.decorView
            bitmap=Bitmap.createBitmap(view.width,view.height,Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
        }
        val file=File("build/reports/mobile-ui/$name.png").apply{parentFile!!.mkdirs()}
        file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
        assertTrue(bitmap.width>300&&bitmap.height>600)
    }

    @Test fun providerSwitchesExposeSupportedAndDisabledStatesAndCaptureDoesNotNeedWebsite() {
        val model=model()
        compose.setContent{SherryTheme{SherryApp(model)}}
        compose.onNodeWithContentDescription("Capture new messages").assertIsOff().assertIsEnabled()
        compose.onNodeWithContentDescription("ChatGPT capture").assertIsOff().assertIsEnabled()
        compose.onNodeWithContentDescription("Gemini capture").assertIsOff().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Claude capture").assertIsOff().assertIsNotEnabled()
        shot("capture-paused")
        compose.onNodeWithContentDescription("Switch Sherry view").performClick()
        compose.onNodeWithText("Switch Sherry view").assertIsDisplayed()
        compose.onNodeWithText("Website").assertIsDisplayed()
        shot("profile-switcher")
    }

    @Test fun testShowsBothRolesWithNoReceiptBadgeAndSignInStartsDisabled() {
        val model=model()
        val recent=listOf(
            RecentCapture("one",Provider.CHATGPT,"test-conversation","Invented test chat","user","Sherry Android layout check. Reply with amber notebook.","2026-10-27T12:00:00Z",sequence=0),
            RecentCapture("two",Provider.CHATGPT,"test-conversation","Invented test chat","assistant","amber notebook","2026-10-27T12:00:01Z",delivery="committed",sequence=1))
        var login by mutableStateOf(false)
        compose.setContent{SherryTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)){
            if(login)AccountScreen(model,CaptureState())else TestScreen(model,CaptureState(recentCaptures=recent))
        }}}
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithText("amber notebook").assertIsDisplayed()
        compose.onNodeWithText("Received by Sherry").assertDoesNotExist()
        val user=compose.onNodeWithText("You").fetchSemanticsNode().boundsInRoot
        val assistant=compose.onAllNodesWithText("ChatGPT").fetchSemanticsNodes().last().boundsInRoot
        assertTrue("User bubble must begin to the right of the AI bubble",user.left>assistant.left)
        shot("test-bubbles")
        compose.runOnIdle{login=true}
        compose.onNode(hasText("Sign in") and hasClickAction()).assertIsNotEnabled()
        compose.onNodeWithText("Email").performTextInput("designer@example.com")
        compose.onNodeWithText("Password").performTextInput("invented-only")
        compose.onNode(hasText("Sign in") and hasClickAction()).assertIsEnabled()
        shot("sign-in")
    }

    @Test fun conversationWithTheLatestCapturedMessageAppearsFirstEvenWhenOldQueueRowsArriveLast() {
        val model=model()
        val recent=listOf(
            RecentCapture("a1",Provider.CHATGPT,"a","Active chat","user","First question in active chat","2026-10-28T10:00:00Z",sequence=0),
            RecentCapture("b1",Provider.CHATGPT,"b","Another chat","user","Another question","2026-10-28T10:30:00Z",sequence=0),
            RecentCapture("a2",Provider.CHATGPT,"a","Active chat","assistant","Latest answer in active chat","2026-10-28T07:00:00-04:00",sequence=1),
            RecentCapture("c1",Provider.CHATGPT,"c","Legacy waiting chat","user","Older message\n".repeat(40),"2026-10-02T10:00:00Z",sequence=0))
        compose.setContent{SherryTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)){
            TestScreen(model,CaptureState(recentCaptures=recent))
        }}}
        compose.onNodeWithText("Active chat").assertIsDisplayed()
        val active=compose.onNodeWithText("Active chat").fetchSemanticsNode().boundsInRoot
        val other=compose.onNodeWithText("Another chat").fetchSemanticsNode().boundsInRoot
        assertTrue("The most recently active conversation must be first",active.top<other.top)
        val question=compose.onNodeWithText("First question in active chat").fetchSemanticsNode().boundsInRoot
        val answer=compose.onNodeWithText("Latest answer in active chat").fetchSemanticsNode().boundsInRoot
        assertTrue("Test shows the newest message above its earlier question",answer.top<question.top)
        shot("test-recent-conversation-first")
    }

    @Test fun accessibleToggleChangesWithoutOpeningPopupOrGrantingPermission() {
        var checked by mutableStateOf(false)
        compose.setContent{SherryTheme{SherrySwitch("Example switch",checked,onChange={checked=it})}}
        compose.onNodeWithContentDescription("Example switch").assertIsOff().performClick().assertIsOn()
        compose.runOnIdle{assertTrue(checked)}
    }

    @Test fun automaticCaptureRecoveryRemainsReachableWhileCaptureIsOn() {
        val model=model()
        compose.setContent{SherryTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)){
            TroubleshootingScreen(model,CaptureState(automaticChatGptCapture=true,captureControlVersion=1),true)
        }}}
        compose.onNode(hasText("Review automatic capture") and hasClickAction()).performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle{assertEquals("preview",model.tool)}
    }

    @Test fun recoveryRequiresTheExplicitDifferentChatAction() {
        var starts=0;var troubleshooting=0
        compose.setContent{SherryTheme{Column(Modifier.fillMaxSize().padding(20.dp)){
            CaptureRecoveryCard(enabled=true,onDifferentChat={starts++},onTroubleshooting={troubleshooting++})
        }}}
        compose.onNodeWithText("More troubleshooting").performClick()
        compose.runOnIdle{assertEquals(0,starts);assertEquals(1,troubleshooting)}
        compose.onNode(hasText("Capture this as a different chat") and hasClickAction()).performClick()
        compose.runOnIdle{assertEquals(1,starts)}
        shot("conversation-recovery")
    }
}

// UI checks neither schedule real upload work nor contact Sherry.
class UiTestApplication:SherryApplication(){override fun onCreate(){}}
