package dev.sherry.capture

import android.provider.Settings
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Canvas
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.caverock.androidsvg.SVG
import dev.sherry.capture.core.Provider
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable internal fun SmallCopy(value: String, modifier: Modifier=Modifier, color: Color=SherryColors.Secondary) {
    Text(value,modifier=modifier,style=MaterialTheme.typography.bodySmall,color=color)
}
@Composable internal fun ScreenTitle(title: String, subtitle: String?=null) {
    Text(title,fontSize=25.sp,lineHeight=35.sp,fontWeight=FontWeight.SemiBold)
    subtitle?.let { Text(it,fontSize=13.sp,lineHeight=19.sp,color=SherryColors.Secondary) }
}
@Composable internal fun SherryCard(color: Color=Color.White, content: @Composable ColumnScope.()->Unit) {
    Surface(Modifier.fillMaxWidth(),color=color,shape=RoundedCornerShape(14.dp),border=androidx.compose.foundation.BorderStroke(1.dp,SherryColors.Border)) {
        Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(10.dp),content=content)
    }
}
@Composable internal fun SherryAction(label: String, primary: Boolean=false, enabled: Boolean=true, onClick: ()->Unit) {
    if(primary) Button(onClick,Modifier.fillMaxWidth().heightIn(min=48.dp),enabled=enabled,shape=RoundedCornerShape(10.dp)){Text(label)}
    else OutlinedButton(onClick,Modifier.fillMaxWidth().heightIn(min=48.dp),enabled=enabled,shape=RoundedCornerShape(10.dp)){Text(label,color=if(enabled)SherryColors.Text else SherryColors.Secondary)}
}

/** Intact Figma artwork inside a real accessible toggle target; SVG dimensions are never rewritten. */
@Composable internal fun SherrySwitch(label:String,checked:Boolean,enabled:Boolean=true,master:Boolean=false,onChange:(Boolean)->Unit) {
    val context=LocalContext.current
    val resource=if(master){if(checked)R.raw.figma_5b7ff else R.raw.figma_cae85}
        else if(!enabled)R.raw.figma_9b499 else if(checked)R.raw.figma_1c071 else R.raw.figma_248a3
    val drawing=remember(resource){SVG.getFromResource(context,resource).renderToPicture()}
    Box(Modifier.size(if(master)56.dp else 54.dp,48.dp)
        .toggleable(value=checked,enabled=enabled,role=Role.Switch,onValueChange=onChange)
        .semantics{contentDescription=label},contentAlignment=Alignment.Center) {
        Canvas(Modifier.size(if(master)48.dp else 42.dp,if(master)28.dp else 22.dp)) {
            val canvas=drawContext.canvas.nativeCanvas
            canvas.save();canvas.scale(size.width/drawing.width,size.height/drawing.height);canvas.drawPicture(drawing);canvas.restore()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun SherryApp(model:CaptureViewModel) {
    val state by model.store.state.collectAsStateWithLifecycle()
    val connected by CaptureAccessibilityService.isConnected.collectAsStateWithLifecycle()
    val snackbar=remember {SnackbarHostState()}
    var switcher by remember {mutableStateOf(false)}
    var disclosure by remember {mutableStateOf(false)}
    val context=LocalContext.current
    LaunchedEffect(model.notice){model.notice?.let{snackbar.showSnackbar(it);model.notice=null}}
    BackHandler(enabled=model.tool!=null){model.tool=null}
    Scaffold(containerColor=Color.White,snackbarHost={SnackbarHost(snackbar)},topBar={
        Column(Modifier.statusBarsPadding().fillMaxWidth().padding(horizontal=20.dp)) {
            Row(Modifier.fillMaxWidth().height(64.dp),verticalAlignment=Alignment.CenterVertically) {
                Text("Sherry",fontFamily=SherryWordmark,fontStyle=FontStyle.Italic,fontSize=28.sp,lineHeight=40.sp,fontWeight=FontWeight.SemiBold,modifier=Modifier.weight(1f))
                Box(Modifier.size(48.dp).clickable(onClick={switcher=true}).semantics{contentDescription="Switch Sherry view"},contentAlignment=Alignment.Center){
                    Box(Modifier.size(36.dp).background(SherryColors.Surface,CircleShape),contentAlignment=Alignment.Center){
                        Text(state.connection?.email?.firstOrNull()?.uppercase() ?: "S",fontSize=12.sp)
                    }
                }
            }
            if(!model.website&&model.tool==null) Row(Modifier.fillMaxWidth().height(48.dp).background(SherryColors.Surface,RoundedCornerShape(12.dp)).padding(4.dp)) {
                listOf("Capture","Test").forEachIndexed { index,label ->
                    Box(Modifier.weight(1f).fillMaxHeight().background(if(model.page==index)Color.White else Color.Transparent,RoundedCornerShape(9.dp))
                        .clickable{model.page=index}.semantics{role=Role.Tab;selected=model.page==index},contentAlignment=Alignment.Center){
                        Text(label,fontSize=13.sp,fontWeight=if(model.page==index)FontWeight.SemiBold else FontWeight.Medium,color=if(model.page==index)SherryColors.Text else SherryColors.Secondary)
                    }
                }
            }
        }
    }) { insets ->
        if(model.website) SherryWebsite(Modifier.fillMaxSize().padding(insets),onExit={model.website=false})
        else Column(Modifier.fillMaxSize().padding(insets).imePadding().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            if(model.tool!=null) TextButton(onClick={model.tool=null}){Text("‹ Back")}
            model.store.storageError?.let{SmallCopy(it,color=MaterialTheme.colorScheme.error)}
            when(model.tool){
                "account"->AccountScreen(model,state)
                "support"->TroubleshootingScreen(model,state,connected)
                "waiting"->WaitingMessagesScreen(model,state)
                "preview"->NativeReaderTools(model)
                "share"->SharedExcerptScreen(model)
                "setup"->PermissionSetup{disclosure=true}
                else->if(model.page==0)CaptureScreen(model,state,connected,{disclosure=true})else TestScreen(model,state)
            }
        }
    }
    if(switcher) ModalBottomSheet(onDismissRequest={switcher=false},containerColor=Color.White) {
        Column(Modifier.padding(horizontal=24.dp).padding(bottom=32.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            Text("Switch Sherry view",fontSize=23.sp,fontWeight=FontWeight.SemiBold)
            for((website,title,desc)in listOf(Triple(false,"Capture","Manage capture and view recent messages"),Triple(true,"Website","Open your Sherry memories"))) {
                Surface(onClick={model.website=website;model.tool=null;switcher=false},color=if(model.website==website)SherryColors.UserBubble else SherryColors.Surface,shape=RoundedCornerShape(12.dp),modifier=Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(4.dp)){Text(title,fontWeight=FontWeight.SemiBold);SmallCopy(desc)}
                }
            }
            SmallCopy("Use the same Sherry account in both views.")
        }
    }
    if(disclosure)AlertDialog(onDismissRequest={disclosure=false},title={Text("Allow Sherry to read ChatGPT?")},
        text={Text("Android Accessibility lets Sherry read supported visible ChatGPT conversations. Settled messages can be saved automatically when you turn capture on. Editable fields and recognized temporary chats are excluded. You can turn access off in Android Settings.")},
        confirmButton={TextButton(onClick={disclosure=false;context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))}){Text("Open Android Settings")}},
        dismissButton={TextButton(onClick={disclosure=false}){Text("Not now")}})
}

internal fun capturedTime(value:String):String=runCatching{DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(value))}.getOrDefault("time unavailable")
