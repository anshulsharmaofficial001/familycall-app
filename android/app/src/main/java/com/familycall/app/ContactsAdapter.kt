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
        val colors = listOf(0xFF4A90D9, 0xFF43A047, 0xFFE53935, 0xFFFF9800, 0xFF9C27B0, 0xFF00ACC1)
        val color = colors[contact.name.hashCode().and(0x7FFFFFFF) % colors.size].toInt()
        holder.binding.apply {
            contactName.text = contact.name
            contactPhone.text = if (contact.online) "● Online" else "○ Offline"
            contactPhone.setTextColor(if (contact.online) 0xFF22C55E.toInt() else 0xFF9E9E9E.toInt())
            avatarText.text = contact.name.firstOrNull()?.uppercase() ?: "?"
            avatarText.backgroundTintList = android.content.res.ColorStateList.valueOf(color)
            onlineDot.visibility = if (contact.online) android.view.View.VISIBLE else android.view.View.GONE
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
