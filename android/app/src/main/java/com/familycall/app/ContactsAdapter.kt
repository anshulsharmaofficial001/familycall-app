package com.familycall.app

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.familycall.app.databinding.ItemContactBinding
import com.familycall.app.signaling.UserInfo

class ContactsAdapter(
    private var contacts: List<UserInfo>,
    private val onCallClick: (UserInfo) -> Unit,
    private val onChatClick: (UserInfo) -> Unit
) : RecyclerView.Adapter<ContactsAdapter.ViewHolder>() {

    class ViewHolder(val binding: ItemContactBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemContactBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val contact = contacts[position]
        holder.binding.apply {
            contactName.text = contact.name
            contactPhone.text = "@${contact.username}"
            avatarText.text = contact.name.firstOrNull()?.uppercase() ?: "?"
            callBtn.setOnClickListener { onCallClick(contact) }
            chatBtn.setOnClickListener { onChatClick(contact) }
        }
    }

    override fun getItemCount() = contacts.size

    fun updateContacts(newContacts: List<UserInfo>) {
        contacts = newContacts
        notifyDataSetChanged()
    }
}
