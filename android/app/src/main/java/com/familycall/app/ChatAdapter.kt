package com.familycall.app

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

class ChatAdapter(private val messages: List<Pair<Boolean, String>>) : RecyclerView.Adapter<ChatAdapter.ViewHolder>() {

    class ViewHolder(val view: View) : RecyclerView.ViewHolder(view)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(
            if (viewType == 0) android.R.layout.simple_list_item_1 else android.R.layout.simple_list_item_1,
            parent, false
        )
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val (isMine, text) = messages[position]
        val tv = holder.view.findViewById<TextView>(android.R.id.text1)
        tv.text = if (isMine) "You: $text" else text
        tv.setTextColor(if (isMine) 0xFF43A047.toInt() else 0xFFFFFFFF.toInt())
    }

    override fun getItemCount() = messages.size

    override fun getItemViewType(position: Int): Int {
        return if (messages[position].first) 0 else 1
    }
}
