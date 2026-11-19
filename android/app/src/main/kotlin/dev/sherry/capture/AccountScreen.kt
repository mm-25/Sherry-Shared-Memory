package dev.sherry.capture

import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

@Composable internal fun AccountScreen(model:CaptureViewModel,state:CaptureState) {
    var email by remember { mutableStateOf(state.connection?.email ?: "") }
    // A password never enters saved-instance state or the encrypted capture store.
    var password by remember { mutableStateOf("") }
    var confirmSignOut by remember { mutableStateOf(false) }
    val account=state.connection
    if(account!=null&&!account.needsReconnect) {
        ScreenTitle("Connected to Sherry","Your phone’s capture connection.")
        SherryCard(SherryColors.Surface) {
            Text(account.email.ifBlank{"Sherry account"},fontSize=18.sp,fontWeight=FontWeight.SemiBold)
            SmallCopy(account.workspaceName)
            SmallCopy("Messages waiting: ${state.captures.size}. ${if(state.paused)"Uploads are paused." else "Uploads are enabled."}")
        }
        SherryAction("Sign out",enabled=!model.busy){confirmSignOut=true}
        SmallCopy("Signing out pauses capture and uploads. Waiting messages stay on this phone for the same Sherry account.")
    } else {
        ScreenTitle(if(account==null)"Sign in to Sherry" else "Reconnect Sherry","Use the same account as the Sherry website.")
        SmallCopy("Connect this phone so its captured messages can reach your Sherry memories. Your waiting messages stay safe while you sign in.")
        OutlinedTextField(email,{email=it},Modifier.fillMaxWidth(),
            label={Text("Email")},singleLine=true,enabled=!model.busy,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Email))
        OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),
            label={Text("Password")},singleLine=true,enabled=!model.busy,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password))
        SherryAction(if(model.busy)"Connecting…" else "Sign in",true,enabled=!model.busy&&email.isNotBlank()&&password.isNotEmpty()){
            val submitted=password
            password=""
            model.signIn(email.trim(),submitted)
        }
        SmallCopy("Use an existing Sherry email and password. Signing in does not turn capture on or resume paused uploads.")
        SmallCopy("The Website view has its own sign-in for now. Use the same account there.")
    }
    if(confirmSignOut)AlertDialog(onDismissRequest={confirmSignOut=false},title={Text("Sign out of Sherry?")},
        text={Text("Capture and uploads will pause. Waiting messages will stay on this phone. This also clears the Website view’s sign-in on this phone.")},
        confirmButton={TextButton(onClick={
            confirmSignOut=false
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            model.signOut()
        }){Text("Sign out")}},dismissButton={TextButton(onClick={confirmSignOut=false}){Text("Keep signed in")}})
}
