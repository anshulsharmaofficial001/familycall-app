package com.familycall.app

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.familycall.app.databinding.ActivityMainBinding
import com.familycall.app.signaling.ServerClient
import com.familycall.app.signaling.UserInfo
import com.familycall.app.utils.UpdateChecker
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var serverClient: ServerClient
    private lateinit var adapter: ContactsAdapter
    private var contacts = mutableListOf<UserInfo>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(binding.toolbar)
        serverClient = ServerClient.getInstance()

        // Show creator badge if superadmin
        if (FamilyCallApp.currentRole == "superadmin") {
            supportActionBar?.title = "✦ Anshul Sharma — Creator"
        } else {
            supportActionBar?.title = "FamilyCall — ${FamilyCallApp.currentUserName}"
        }

        // Check for updates on startup (silent, non-blocking)
        UpdateChecker.checkForUpdate(this)

        adapter = ContactsAdapter(contacts,
            onCallClick = { contact -> initiateCall(contact) },
            onChatClick = { contact -> openChat(contact) }
        )
        binding.contactsRecycler.layoutManager = LinearLayoutManager(this)
        binding.contactsRecycler.adapter = adapter

        binding.addContactFab.setOnClickListener {
            val options = arrayOf("Add Family Member", "Call via Link (No App Needed)")
            MaterialAlertDialogBuilder(this)
                .setTitle("Choose Action")
                .setItems(options) { _, which ->
                    when (which) {
                        0 -> showAddContactDialog()
                        1 -> showCallViaLinkDialog()
                    }
                }
                .show()
        }

        connectToServer()
        loadContacts()
        listenForIncomingCalls()
    }

    private fun connectToServer() {
        val username = FamilyCallApp.currentUsername
        val name = FamilyCallApp.currentUserName
        if (username.isEmpty()) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        serverClient.connectWebSocket(username, name)
    }

    private fun listenForIncomingCalls() {
        serverClient.setMessageListener { json ->
            val type = json.optString("type")
            if (type == "incoming_call") {
                runOnUiThread {
                    val intent = Intent(this, IncomingCallActivity::class.java).apply {
                        putExtra("callId", json.optString("callId"))
                        putExtra("callerName", json.optString("callerName"))
                        putExtra("callerUsername", json.optString("callerUsername"))
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(intent)
                }
            }
        }
    }

    private fun loadContacts() {
        serverClient.getAllUsers { users ->
            runOnUiThread {
                val myUsername = FamilyCallApp.currentUsername
                contacts.clear()
                contacts.addAll(users.filter { it.username != myUsername })
                adapter.updateContacts(contacts)

                if (contacts.isEmpty()) {
                    binding.emptyText.visibility = android.view.View.VISIBLE
                    binding.contactsRecycler.visibility = android.view.View.GONE
                } else {
                    binding.emptyText.visibility = android.view.View.GONE
                    binding.contactsRecycler.visibility = android.view.View.VISIBLE
                }            }
        }
    }

    private fun showAddContactDialog() {
        val input = TextInputEditText(this).apply {
            hint = "Enter username"
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }

        MaterialAlertDialogBuilder(this)
            .setTitle("Add Family Member")
            .setMessage("Enter their username")
            .setView(input)
            .setPositiveButton("Add") { _, _ ->
                val username = input.text.toString().trim().lowercase()
                if (username.isNotEmpty()) {
                    serverClient.getUserByUsername(username) { user ->
                        runOnUiThread {
                            if (user != null) {
                                Toast.makeText(this, "${user.name} added!", Toast.LENGTH_SHORT).show()
                                loadContacts()
                            } else {
                                Toast.makeText(this, "User not found. Ask them to install FamilyCall first!", Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showCallViaLinkDialog() {
        val input = TextInputEditText(this).apply {
            hint = "Who are you calling?"
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Call via Link")
            .setMessage("Send a call link via WhatsApp. Receiver just needs internet + Chrome.")
            .setView(input)
            .setPositiveButton("Generate Link") { _, _ ->
                val name = input.text.toString().trim().ifEmpty { "Family Member" }
                callViaLink(name)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun initiateCall(contact: UserInfo) {
        val intent = Intent(this, CallActivity::class.java).apply {
            putExtra("calleeUsername", contact.username)
            putExtra("calleeName", contact.name)
            putExtra("isCaller", true)
            putExtra("isWebCall", false)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
    }

    private fun openChat(contact: UserInfo) {
        val intent = Intent(this, ChatActivity::class.java).apply {
            putExtra("chatUsername", contact.username)
            putExtra("chatName", contact.name)
        }
        startActivity(intent)
    }

    private fun callViaLink(name: String) {
        val intent = Intent(this, CallActivity::class.java).apply {
            putExtra("calleeName", name)
            putExtra("isCaller", true)
            putExtra("isWebCall", true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
    }
}
