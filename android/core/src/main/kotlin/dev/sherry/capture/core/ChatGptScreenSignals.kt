package dev.sherry.capture.core

/** Positive public screen evidence; an offered Temporary chat button is not an active mode. */
object ChatGptScreenSignals {
    private fun nodes(root:ScreenNode)=root.descendants().filter{it.visible&&!it.editable&&!it.password}.toList()
    /** Observed side panel, not chat titles or labels quoted inside a message. */
    fun isHistoryMenu(root:ScreenNode,complete:Boolean=true):Boolean {
        if(!complete||root.packageName!=Provider.CHATGPT.packageName)return false
        val width=root.right-root.left;val height=root.bottom-root.top
        if(width<=0||height<=0)return false
        val all=nodes(root)
        if(all.any{it.packageName!=Provider.CHATGPT.packageName||
                it.description in setOf("Reply to ChatGPT","Ask ChatGPT","Read aloud","Edit Menu")})return false
        return all.any { panel->
            val panelWidth=panel.right-panel.left
            if(panel.left!=root.left||panelWidth !in (width*.65).toInt()..(width*.9).toInt()||
                panel.bottom-panel.top<height*.9)return@any false
            val contents=nodes(panel)
            val headers=contents.filter{it.top>=root.top&&it.bottom<root.top+height*.25}
            headers.any{it.clickable&&it.description=="New chat"}&&
                headers.any{it.description=="Search"}&&
                contents.any{it.scrollable&&it.descendants().any{label->label.visible&&!label.editable&&!label.password&&label.text=="Chats"}}
        }
    }
    fun isConversationChrome(root:ScreenNode,complete:Boolean=true):Boolean {
        if(!complete||root.packageName!=Provider.CHATGPT.packageName)return false
        val descriptions=nodes(root).map{it.description}.toSet()
        return descriptions.containsAll(setOf("New chat","Menu","Edit Menu","Reply to ChatGPT"))
    }
    /** The generating control belongs to the composer; message text is not a control. */
    fun isResponding(root:ScreenNode):Boolean {
        val width=root.right-root.left
        if(root.packageName!=Provider.CHATGPT.packageName||width<=0)return false
        val hints=setOf("Reply to ChatGPT","Ask ChatGPT")
        return root.descendants().any { area->
            if(area.right-area.left<width*.5||area.bottom-area.top>width*.75)return@any false
            val descendants=area.descendants().toList()
            val public=descendants.filter{it.visible&&!it.editable&&!it.password}
            descendants.any{it.editable&&!it.password}&&
                public.none{it.description=="Read aloud"||it.className=="android.widget.TextView"&&it.text.isNotBlank()&&it.text !in hints}&&
                public.any{it.description.equals("Stop",true)||it.description.equals("Stop generating",true)||it.description.equals("Stop response",true)}
        }
    }
    fun isEmptyHome(root:ScreenNode,complete:Boolean):Boolean {
        if(!complete||root.packageName!=Provider.CHATGPT.packageName)return false
        val all=nodes(root);val descriptions=all.map{it.description}.toSet()
        if(!descriptions.containsAll(setOf("Menu","Ask ChatGPT")))return false
        if(all.none{it.text=="Chat"}||all.none{it.text=="Work"})return false
        if(descriptions.any{it in setOf("Reply to ChatGPT","Read aloud","Edit Menu","Stop","Stop generating","Stop response")})return false
        return all.none{(it.text.equals("Temporary chat",true)||it.description.equals("Temporary chat",true))&&(it.selected||it.checked)}
    }
}
