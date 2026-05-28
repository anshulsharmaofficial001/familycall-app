package com.familycall.app

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.familycall.app.databinding.ActivityChatBinding
import com.familycall.app.signaling.ServerClient
import org.json.JSONArray
import org.json.JSONObject

class ChatActivity : AppCompatActivity() {

    private lateinit var binding: ActivityChatBinding
    private var chatUsername: String = ""
    private var chatName: String = ""
    private var messages = mutableListOf<Pair<Boolean, String>>() // isMine, text

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityChatBinding.inflate(layoutInflater)
        setContentView(binding.root)

        chatUsername = intent?.getStringExtra("chatUsername") ?: ""
        chatName = intent?.getStringExtra("chatName") ?: chatUsername

        supportActionBar?.title = chatName
        supportActionBar?.setDisplayHomeAsUpEnabled(true)

        binding.chatRecycler.layoutManager = LinearLayoutManager(this)

        binding.sendBtn.setOnClickListener {
            val text = binding.messageInput.text.toString().trim()
            if (text.isNotEmpty()) {
                sendMessage(text)
                binding.messageInput.text?.clear()
            }
        }

        loadMessages()
    }

    private fun sendMessage(text: String) {
        val client = ServerClient.getInstance()
        client.sendChat(chatUsername, text)
        messages.add(Pair(true, text))
        refreshMessages()
    }

    private fun loadMessages() {
        val client = ServerClient.getInstance()
        client.getChatMessages(chatUsername) { msgs ->
            runOnUiThread {
                messages.clear()
                for (msg in msgs) {
                    val from = msg.optString("from")
                    val text = msg.optString("text")
                    messages.add(Pair(from == FamilyCallApp.currentUsername, text))
                }
                refreshMessages()
            }
        }
    }

    private fun refreshMessages() {
        val adapter = ChatAdapter(messages)
        binding.chatRecycler.adapter = adapter
        if (messages.isNotEmpty()) {
            binding.chatRecycler.smoothScrollToPosition(messages.size - 1)
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}
