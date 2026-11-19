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

@Composable
internal fun SharedExcerptScreen(model: CaptureViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Share an excerpt", style = MaterialTheme.typography.headlineMedium)
        Text("Save something from your AI conversations, ready for Sherry to remember.",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.secondaryContainer) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (model.shared) "Shared with Sherry" else "Start in ChatGPT", style = MaterialTheme.typography.titleMedium)
            Text("Select or copy a response, then share it to Sherry. Review the text here before saving.")
            Text("A shared link saves the link itself. It does not import the conversation behind it.", style = MaterialTheme.typography.bodySmall)
        }
    }
    Text("From", style = MaterialTheme.typography.titleSmall)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Provider.entries.forEach { provider ->
            FilterChip(selected = model.provider == provider, onClick = { model.provider = provider }, label = { Text(provider.label) })
        }
    }
    OutlinedTextField(value = model.title, onValueChange = { if (it.length <= 200) model.title = it },
        label = { Text("Title (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = model.text, onValueChange = { if (it.length <= CaptureFactory.MAX_TEXT) model.text = it },
        label = { Text("Conversation excerpt") }, minLines = 6, maxLines = 14, modifier = Modifier.fillMaxWidth(),
        supportingText = { Text("Only the text you save is captured. Review it for anything private.") })
    Text("Who wrote this?", style = MaterialTheme.typography.titleSmall)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("unknown" to "Mixed / unsure", "user" to "Me", "assistant" to "AI").forEach { (role, label) ->
            FilterChip(selected = model.role == role, onClick = { model.role = role }, label = { Text(label) })
        }
    }
    Button(onClick = model::save, enabled = model.text.isNotBlank() && !model.busy && model.store.storageError == null,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text(if (model.busy) "Saving…" else "Save capture") }
    Text("This saves only the text you choose, not the full original conversation.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}


@Composable
internal fun WaitingMessagesScreen(model: CaptureViewModel, state: CaptureState) {
    val context = LocalContext.current
    var remove by remember { mutableStateOf<String?>(null) }
    Text("Safe on this phone.", style = MaterialTheme.typography.headlineMedium)
    Text(state.syncMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text("${state.captures.size} pending", style = MaterialTheme.typography.titleMedium)
        OutlinedButton(onClick = { SyncScheduler.enqueue(context) }, enabled = !state.paused && state.connection != null) { Text("Sync now") }
    }
    if (state.captures.isEmpty()) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Nothing waiting", style = MaterialTheme.typography.titleLarge)
                Text("New captures appear here until Sherry confirms they’re saved. Uploaded captures are available in Sherry on the web.")
            }
        }
    }
    state.captures.asReversed().forEach { capture ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(capture.provider.label + " · " + if (capture.status == "rejected") "Needs attention" else "Waiting to sync",
                    style = MaterialTheme.typography.labelMedium)
                Text(capture.event.chatTitle, style = MaterialTheme.typography.titleMedium)
                if (capture.reason == "accessibility") Text((if (capture.event.role == "user") "You" else "ChatGPT") + " · partial capture", style = MaterialTheme.typography.labelMedium)
                if (capture.reason == "accessibility") Text("Observed ${capture.event.capturedAt} · original date unknown", style = MaterialTheme.typography.bodySmall)
                Text(capture.event.text.take(240), maxLines = 4, style = MaterialTheme.typography.bodyMedium)
                capture.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = { remove = capture.id }, enabled = !model.busy && state.paused) { Text("Remove local capture") }
            }
        }
    }
    if (state.captures.isNotEmpty()) Text("Pause sync before removing a capture. Removal only affects this phone; an upload already accepted by Sherry must be deleted in Sherry.", style = MaterialTheme.typography.bodySmall)
    if (remove != null) AlertDialog(onDismissRequest = { remove = null },
        title = { Text("Remove this saved message?") }, text = { Text("This removes the waiting message and its recent Test copy from this phone. It does not delete anything already uploaded to Sherry.") },
        confirmButton = { TextButton(onClick = { val id = remove!!; remove = null; model.act { model.store.remove(id) } }) { Text("Remove") } },
        dismissButton = { TextButton(onClick = { remove = null }) { Text("Keep") } })
}


@Composable
internal fun NativeReaderTools(model: CaptureViewModel) {
    val context = LocalContext.current
    val state by model.store.state.collectAsStateWithLifecycle()
    val connected by CaptureAccessibilityService.isConnected.collectAsStateWithLifecycle()
    val preview by CaptureAccessibilityService.preview.collectAsStateWithLifecycle()
    val status by CaptureAccessibilityService.status.collectAsStateWithLifecycle()
    val automaticStatus by CaptureAccessibilityService.automaticCaptureStatus.collectAsStateWithLifecycle()
    val ready = connected && Provider.CHATGPT in state.proofProviders && model.store.storageError == null
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (state.captureEnabled) "Automatic ChatGPT capture" else "Read from ChatGPT",
                style = MaterialTheme.typography.titleLarge)
            if (state.captureEnabled) {
                Text("Use ChatGPT normally. Sherry saves settled, complete-looking visible messages on this phone while ChatGPT is open. Check the queue for what was captured; long messages may still need sharing manually.")
                Text(automaticStatus, style = MaterialTheme.typography.bodySmall,
                    color = if (automaticStatus.startsWith("Capture needs review")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${state.nativeSessions.firstOrNull { it.id == state.currentNativeSessionId }?.turns?.size ?: 0} messages in the current local conversation · ${state.captures.size} waiting to sync",
                    style = MaterialTheme.typography.bodySmall)
                if (automaticStatus.startsWith("Capture needs review")) {
                    Text("If you switched chats, start a separate capture here, then reopen that chat. Do not use this for another part of the same chat; scroll to show previously captured messages instead.", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(onClick = {
                        model.act {
                            model.store.startSeparateNativeSession()
                            CaptureAccessibilityService.clearAutomaticIssue()
                        }
                    }, enabled = !model.busy) { Text("Start a separate conversation") }
                }
                if (!ready) OutlinedButton(onClick = { model.tool = "setup" }) { Text("Set up or resume capture") }
            } else {
                Text("Open ChatGPT and wait for its messages to settle. Sherry refreshes the visible preview while you are there. Return here to review; nothing is saved until you choose Save. Keep private or temporary chats out of this test.")
                Text(status, style = MaterialTheme.typography.bodySmall)
                if (!ready) {
                OutlinedButton(onClick = { model.tool = "setup" }) { Text("Set up ChatGPT preview") }
                } else {
                fun read(sessionId: String?) {
                    val launch = context.packageManager.getLaunchIntentForPackage(Provider.CHATGPT.packageName)
                    if (launch == null) model.notice = "Install ChatGPT to use this preview."
                    else if (CaptureAccessibilityService.requestPreview(sessionId)) {
                        try { context.startActivity(launch) }
                        catch (_: Exception) { CaptureAccessibilityService.discardPreview(); model.notice = "Open ChatGPT and try again." }
                    }
                }
                val session = state.nativeSessions.firstOrNull { it.id == state.currentNativeSessionId }
                if (session != null) {
                    Text("Current capture: ${session.turns.size} messages · started ${session.createdAt}", style = MaterialTheme.typography.bodySmall)
                    Text("Continue only if you are still reading the same ChatGPT conversation. Keep at least two saved messages visible so Sherry can match the overlap.")
                    Button(onClick = { read(session.id) }, enabled = !model.busy) { Text("Read more from this conversation") }
                }
                OutlinedButton(onClick = { read(null) }, enabled = !model.busy) { Text("Start a separate capture") }
                }
            }
            preview?.let { current ->
                Text("${current.messages.size} visible messages · partial conversation", style = MaterialTheme.typography.titleMedium)
                Text("Observed ${current.observedAt}. Original message dates are unknown. Earlier messages and content outside the screen may be missing.", style = MaterialTheme.typography.bodySmall)
                val merge = remember(current, state.nativeSessions) { runCatching {
                    model.store.previewMerge(current.id, current.messages, current.observedAt, current.sessionId)
                } }
                Text(merge.fold({ "${it.additions.size} new messages · ${it.duplicates} already captured" }, { it.message ?: "Cannot safely join this read." }),
                    color = if (merge.isSuccess) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
                current.messages.forEach { message ->
                    Text(if (message.role == "user") "You" else "ChatGPT", style = MaterialTheme.typography.labelLarge)
                    Text(message.text)
                    Text(if (message.completeness == "possibly_clipped") "May be clipped at the screen edge" else "Full message completeness unverified", style = MaterialTheme.typography.bodySmall)
                }
                Button(onClick = { model.savePreview(current) }, enabled = !model.busy && merge.isSuccess) { Text("Save new messages") }
                TextButton(onClick = { CaptureAccessibilityService.discardPreview() }, enabled = !model.busy) { Text("Discard preview") }
            }
        }
    }
}
