@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
package dev.sherry.capture

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.unit.sp

object SherryColors {
    val Purple=Color(0xFF7170FF)
    val PurpleText=Color(0xFF5049BB)
    val Surface=Color(0xFFF4F2F4)
    val UserBubble=Color(0xFFEEECFF)
    val Text=Color(0xFF080808)
    val Secondary=Color(0xFF6B6B6B)
    val Border=Color(0xFFE5E3E8)
    val Warning=Color(0xFFFFF6E8)
    val WarningText=Color(0xFF875619)
}
val SherryInter=FontFamily(
    Font(R.font.inter_variable,FontWeight.Normal,variationSettings=FontVariation.Settings(FontVariation.weight(400))),
    Font(R.font.inter_variable,FontWeight.Medium,variationSettings=FontVariation.Settings(FontVariation.weight(500))),
    Font(R.font.inter_variable,FontWeight.SemiBold,variationSettings=FontVariation.Settings(FontVariation.weight(600))),
    Font(R.font.inter_variable,FontWeight.Bold,variationSettings=FontVariation.Settings(FontVariation.weight(700))),
)
val SherryWordmark=FontFamily(Font(R.font.lora_italic_variable,FontWeight.SemiBold,FontStyle.Italic,
    variationSettings=FontVariation.Settings(FontVariation.weight(600))))

@Composable fun SherryTheme(content: @Composable ()->Unit) {
    val t=Typography()
    val typography=Typography(
        displayLarge=t.displayLarge.copy(fontFamily=SherryInter,letterSpacing=0.sp),displayMedium=t.displayMedium.copy(fontFamily=SherryInter,letterSpacing=0.sp),displaySmall=t.displaySmall.copy(fontFamily=SherryInter,letterSpacing=0.sp),
        headlineLarge=t.headlineLarge.copy(fontFamily=SherryInter,letterSpacing=0.sp),headlineMedium=t.headlineMedium.copy(fontFamily=SherryInter,letterSpacing=0.sp),headlineSmall=t.headlineSmall.copy(fontFamily=SherryInter,letterSpacing=0.sp),
        titleLarge=t.titleLarge.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=22.sp),titleMedium=t.titleMedium.copy(fontFamily=SherryInter,letterSpacing=0.sp),titleSmall=t.titleSmall.copy(fontFamily=SherryInter,letterSpacing=0.sp),
        bodyLarge=t.bodyLarge.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=14.sp,lineHeight=20.sp),bodyMedium=t.bodyMedium.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=14.sp,lineHeight=20.sp),
        bodySmall=t.bodySmall.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=12.sp,lineHeight=17.sp),labelLarge=t.labelLarge.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=14.sp),
        labelMedium=t.labelMedium.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=12.sp,lineHeight=17.sp),labelSmall=t.labelSmall.copy(fontFamily=SherryInter,letterSpacing=0.sp,fontSize=12.sp,lineHeight=17.sp),
    )
    MaterialTheme(colorScheme=lightColorScheme(primary=SherryColors.Purple,onPrimary=Color.White,
        primaryContainer=SherryColors.UserBubble,onPrimaryContainer=SherryColors.PurpleText,
        background=Color.White,onBackground=SherryColors.Text,surface=Color.White,onSurface=SherryColors.Text,
        surfaceVariant=SherryColors.Surface,onSurfaceVariant=SherryColors.Secondary,outline=SherryColors.Border,outlineVariant=SherryColors.Border),
        typography=typography,content=content)
}
