package dev.sherry.capture

import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.sherry.capture.core.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class CaptureViewModel(application: Application) : AndroidViewModel(application) {
    val store = (application as SherryApplication).store
    val accounts = (application as SherryApplication).accountManager
    var website by mutableStateOf(false)
    var tool by mutableStateOf<String?>(null)
    var testProvider by mutableStateOf(Provider.CHATGPT)
    var text by mutableStateOf("")
    var title by mutableStateOf("")
    var provider by mutableStateOf(Provider.CHATGPT)
    var role by mutableStateOf("unknown")
    var page by mutableIntStateOf(0)
    var busy by mutableStateOf(false)
    var notice by mutableStateOf<String?>(null)
    var shared by mutableStateOf(false)

    fun receive(intent: Intent) {
        val incoming = when (intent.action) {
            Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            else -> null
        } ?: return
        if (incoming.length > CaptureFactory.MAX_TEXT) {
            notice = "This share is too large. Share a smaller excerpt (up to 60,000 characters)."
            return
        }
        text = incoming.toString()
        title = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(200) ?: ""
        shared = true
        website = false
        tool = "share"
        page = 0
    }

    fun act(block: () -> Unit) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            try { withContext(Dispatchers.IO) { block() } }
            catch (error: Exception) { notice = error.message ?: "Something went wrong. Your saved captures were kept." }
            finally { busy = false }
        }
    }

    fun savePreview(preview: NativePreview) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            try {
                val added = withContext(Dispatchers.IO) { store.saveNativePreview(preview.id, preview.messages, preview.appVersion, preview.observedAt, preview.sessionId) }
                CaptureAccessibilityService.consumePreview(preview.id)
                notice = "Saved $added new messages; ${preview.messages.size - added} already captured."
                page = 1; tool = null
                SyncScheduler.enqueue(getApplication())
            } catch (error: Exception) { notice = error.message ?: "Could not save this preview." }
            finally { busy = false }
        }
    }

    fun signIn(email: String, password: String) {
        act { accounts.signIn(email, password); tool = null; notice = "Connected. Resume uploads when you are ready." }
    }

    fun signOut() {
        val previous = store.state.value.connection
        act { store.disconnect(); SyncScheduler.cancel(getApplication()); previous?.let { accounts.revoke(it) }; tool = null; notice = "Signed out. Waiting messages are safe on this phone." }
    }

    fun save() {
        if (busy) return
        val capture = try { CaptureFactory.share(provider, text, title.ifBlank { "${provider.label} shared excerpt" }, role) }
        catch (error: IllegalArgumentException) { notice = error.message; return }
        busy = true
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { store.add(capture) }
                text = ""; title = ""; role = "unknown"; shared = false
                notice = "Saved on this phone."
                page = 1; tool = null
                SyncScheduler.enqueue(getApplication())
            } catch (error: Exception) { notice = error.message ?: "Could not save this capture." }
            finally { busy = false }
        }
    }
}

