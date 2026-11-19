package dev.sherry.capture

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.*
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.sherry.capture.core.SHERRY_WEBSITE
import dev.sherry.capture.core.trustedWebsiteUrl

/** Hosts the existing website. No native token, page-reading bridge or file access is exposed. */
@SuppressLint("SetJavaScriptEnabled")
@Composable internal fun SherryWebsite(modifier:Modifier=Modifier,onExit:()->Unit) {
    val context=LocalContext.current
    var browser by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var canGoBack by remember { mutableStateOf(false) }
    BackHandler{if(canGoBack)browser?.goBack()else onExit()}
    Column(modifier) {
        SmallCopy("Website view · use the same Sherry account. Mobile layout improvements follow later.",Modifier.padding(horizontal=20.dp,vertical=8.dp))
        if(loading)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(failed)Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            Text("Sherry could not load. Check your connection and try again.")
            SherryAction("Try again"){failed=false;browser?.loadUrl(SHERRY_WEBSITE)}
        }
        AndroidView(modifier=Modifier.weight(1f).fillMaxWidth(),factory={
            WebView(it).apply {
                browser=this
                settings.javaScriptEnabled=true
                settings.domStorageEnabled=true
                settings.allowFileAccess=false
                settings.allowContentAccess=false
                settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.setSupportMultipleWindows(false)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this,false)
                webViewClient=object:WebViewClient(){
                    override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean {
                        if(trustedWebsiteUrl(request.url.toString()))return false
                        if(request.isForMainFrame&&request.hasGesture()&&request.url.scheme=="https") {
                            try{context.startActivity(Intent(Intent.ACTION_VIEW,request.url))}catch(_:ActivityNotFoundException){failed=true}
                        }
                        return true
                    }
                    override fun onPageStarted(view:WebView,url:String?,favicon:android.graphics.Bitmap?){loading=true;failed=false}
                    override fun onPageFinished(view:WebView,url:String?){loading=false;canGoBack=view.canGoBack()}
                    override fun onReceivedError(view:WebView,request:WebResourceRequest,error:WebResourceError){if(request.isForMainFrame){failed=true;loading=false}}
                    override fun onReceivedHttpError(view:WebView,request:WebResourceRequest,response:WebResourceResponse){if(request.isForMainFrame&&response.statusCode>=400){failed=true;loading=false}}
                    override fun onReceivedSslError(view:WebView,handler:android.webkit.SslErrorHandler,error:android.net.http.SslError){handler.cancel();failed=true;loading=false}
                }
                loadUrl(SHERRY_WEBSITE)
            }
        })
    }
    DisposableEffect(Unit){onDispose{browser?.apply{stopLoading();destroy()};browser=null}}
}
