package dev.sherry.capture

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sherry.capture.core.*

@Composable internal fun TestScreen(model:CaptureViewModel,state:CaptureState) {
    ScreenTitle("Recent captured messages","Newest conversations and messages first.")
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        Provider.entries.forEach { p->FilterChip(selected=model.testProvider==p,onClick={model.testProvider=p},label={Text(p.label,fontSize=12.sp)}) }
    }
    val recent=rememberRecent(state.recentCaptures,state.captures,state.connection?.workspaceId)
        .filter{it.provider==model.testProvider&&(it.workspaceId==null||it.workspaceId==state.connection?.workspaceId)}
    if(recent.isEmpty())SherryCard(SherryColors.Surface){
        Text("No captured messages yet",fontSize=18.sp,fontWeight=FontWeight.SemiBold)
        Text(if(model.testProvider==Provider.CHATGPT)"Turn capture on, open ChatGPT and send a message. You do not need to keep Sherry open."
            else "The ${model.testProvider.label} phone reader is not available yet. Manually shared excerpts can still appear here.")
    }
    recentConversationGroups(recent).forEach { messages->
        // Keep the latest captured title even when source turn order is reversed.
        Text(recent.last{it.conversationId==messages.first().conversationId}.title,fontSize=14.sp,fontWeight=FontWeight.Medium)
        messages.forEach { item->ChatBubble(item) }
    }
    TextButton(onClick={model.tool="support"}){Text("Troubleshooting",fontSize=12.sp)}
    SmallCopy("Recent phone captures only. Upload status is shown in Capture. Original message dates may be unknown.")
}

@Composable internal fun ChatBubble(message:RecentCapture) {
    val user=message.role=="user"
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(user)Arrangement.End else Arrangement.Start) {
        BoxWithConstraints(Modifier.fillMaxWidth(.82f)) {
            Surface(color=if(user)SherryColors.UserBubble else SherryColors.Surface,shape=RoundedCornerShape(16.dp),modifier=Modifier.widthIn(max=maxWidth)) {
                Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text(if(user)"You" else if(message.role=="assistant")message.provider.label else "Shared excerpt",fontSize=12.sp,fontWeight=FontWeight.SemiBold,color=if(user)SherryColors.PurpleText else SherryColors.Secondary)
                    Text(message.text,fontSize=14.sp,lineHeight=20.sp,color=SherryColors.Text)
                    SmallCopy("Captured ${capturedTime(message.capturedAt)}")
                }
            }
        }
    }
}
