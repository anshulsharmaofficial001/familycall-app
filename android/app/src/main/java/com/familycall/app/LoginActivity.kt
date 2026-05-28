package com.familycall.app

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.familycall.app.databinding.ActivityLoginBinding
import com.familycall.app.signaling.ServerClient

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private var isRegisterMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = getSharedPreferences("familycall", MODE_PRIVATE)
        val savedUser = prefs.getString("username", "")
        val savedPass = prefs.getString("password", "")
        if (savedUser!!.isNotEmpty() && savedPass!!.isNotEmpty()) {
            tryAutoLogin(savedUser, savedPass)
            return
        }

        binding.nameLayout.visibility = android.view.View.GONE
        binding.actionBtn.text = "Sign In"
        binding.toggleMode.text = "Don't have an account? Sign Up"

        binding.toggleMode.setOnClickListener {
            isRegisterMode = !isRegisterMode
            binding.nameLayout.visibility = if (isRegisterMode) android.view.View.VISIBLE else android.view.View.GONE
            binding.actionBtn.text = if (isRegisterMode) "Sign Up" else "Sign In"
            binding.toggleMode.text = if (isRegisterMode) "Already have an account? Sign In" else "Don't have an account? Sign Up"
        }

        binding.actionBtn.setOnClickListener {
            val username = binding.usernameInput.text.toString().trim().lowercase()
            val name = binding.nameInput.text.toString().trim()
            val password = binding.passwordInput.text.toString().trim()

            if (username.isEmpty() || password.isEmpty()) {
                Toast.makeText(this, "Enter username and password", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (isRegisterMode && name.isEmpty()) {
                Toast.makeText(this, "Enter your name", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            binding.progressBar.visibility = android.view.View.VISIBLE

            val client = ServerClient.getInstance()
            if (isRegisterMode) {
                client.register(username, name, password) { success, error ->
                    runOnUiThread {
                        binding.progressBar.visibility = android.view.View.GONE
                        if (success) {
                            FamilyCallApp.currentUserName = name
                            FamilyCallApp.currentUsername = username
                            prefs.edit().putString("username", username).putString("password", password).putString("name", name).apply()
                            navigateToMain()
                        } else {
                            Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                        }
                    }
                }
            } else {
                client.login(username, password) { success, error ->
                    runOnUiThread {
                        binding.progressBar.visibility = android.view.View.GONE
                        if (success) {
                            FamilyCallApp.currentUsername = username
                            prefs.edit().putString("username", username).putString("password", password).apply()
                            navigateToMain()
                        } else {
                            Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }
    }

    private fun tryAutoLogin(username: String, password: String) {
        binding.progressBar.visibility = android.view.View.VISIBLE
        ServerClient.getInstance().login(username, password) { success, _ ->
            runOnUiThread {
                binding.progressBar.visibility = android.view.View.GONE
                if (success) {
                    FamilyCallApp.currentUsername = username
                    val savedName = getSharedPreferences("familycall", MODE_PRIVATE).getString("name", "")
                    FamilyCallApp.currentUserName = savedName ?: username
                    navigateToMain()
                }
            }
        }
    }

    private fun navigateToMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
