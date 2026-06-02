package com.familycall.app

import android.content.ClipData
import android.content.ClipboardManager
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.familycall.app.databinding.ActivityCallBinding
import com.familycall.app.service.CallForegroundService
import com.familycall.app.signaling.ServerClient
import com.familycall.app.utils.Constants
import com.familycall.app.webrtc.AudioStreamClient
import org.json.JSONObject

class CallActivity : AppCompatActivity() {

    private lateinit var binding: ActivityCallBinding
    private lateinit var serverClient: ServerClient
    private var audioClient: AudioStreamClient? = null
    private var callId: String = ""
    private var calleeUsername: String = ""
    private var calleeName: String = ""
    private var isCaller: Boolean = true
    private var isWebCall: Boolean = false
    private var isMuted: Boolean = false
    private var isSpeaker: Boolean = false
    private var callTimer: CountDownTimer? = null
    private var secondsElapsed: Long = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCallBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true)
        }

        calleeUsername = intent?.getStringExtra("calleeUsername") ?: ""
        calleeName = intent?.getStringExtra("calleeName") ?: "Unknown"
        isCaller = intent?.getBooleanExtra("isCaller", true) ?: true
        isWebCall = intent?.getBooleanExtra("isWebCall", false) ?: false
        callId = intent?.getStringExtra("callId") ?: ""

        binding.contactName.text = calleeName
        binding.callStatus.text = if (isCaller) "Calling..." else "Connecting..."
        // Set avatar letter
        try { binding.avatarLetter.text = calleeName.firstOrNull()?.uppercase() ?: "?" } catch(e: Exception) {}

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                arrayOf(Manifest.permission.RECORD_AUDIO), 100)
        }

        connectAndCall()
        setupControls()
    }

    private fun connectAndCall() {
        serverClient = ServerClient.getInstance()
        serverClient.setMessageListener { json ->
            handleServerMessage(json)
        }

        if (serverClient.isConnected()) {
            onWebSocketConnected()
        } else {
            serverClient.setConnectedListener {
                runOnUiThread { onWebSocketConnected() }
            }
        }
    }

    private fun onWebSocketConnected() {
        if (isWebCall) {
            showShareLink()
        } else if (isCaller && callId.isEmpty()) {
            initiateCallToUser()
        } else if (!isCaller && callId.isNotEmpty()) {
            serverClient.acceptCall(callId)
            startAudioStream()
        }
    }

    private fun initiateCallToUser() {
        serverClient.initiateCall(calleeUsername)
    }

    private fun showShareLink() {
        val shareUrl = "${Constants.SERVER_URL}/call/$callId"
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Call Link", shareUrl))

        binding.callStatus.text = "Link copied! Share with family"
        Toast.makeText(this, "Call link copied! Send via WhatsApp", Toast.LENGTH_LONG).show()

        val shareIntent = Intent().apply {
            action = Intent.ACTION_SEND
            putExtra(Intent.EXTRA_TEXT, "📞 Join my call: $shareUrl")
            type = "text/plain"
        }
        startActivity(Intent.createChooser(shareIntent, "Send call link to"))
    }

    private var isCallAccepted = false

    private fun handleServerMessage(json: JSONObject) {
        val type = json.optString("type")
        runOnUiThread {
            when (type) {
                "call_created" -> {
                    callId = json.optString("callId")
                    startAudioStream()
                }
                "call_accepted" -> {
                    isCallAccepted = true
                    binding.callStatus.text = "Connected"
                    binding.callStatus.visibility = View.GONE
                    binding.callTimer.visibility = View.VISIBLE
                    startCallTimer()
                }
                "call_ended" -> {
                    Toast.makeText(this, "Call ended", Toast.LENGTH_SHORT).show()
                    finish()
                }
                "audio" -> {
                    audioClient?.onAudioReceived(json.optString("data"))
                }
            }
        }
    }

    private fun startAudioStream() {
        audioClient = AudioStreamClient(this).apply {
            setOnConnected {
                runOnUiThread {
                    binding.callStatus.text = "Connected"
                    binding.callStatus.visibility = View.GONE
                    binding.callTimer.visibility = View.VISIBLE
                    startCallTimer()
                }
            }
            start { chunk ->
                if (callId.isNotEmpty()) {
                    serverClient.sendAudioChunk(callId, chunk)
                }
            }
        }
    }

    private fun setupControls() {
        binding.muteBtn.setOnClickListener {
            isMuted = !isMuted
            audioClient?.setMuted(isMuted)
            binding.muteBtn.setBackgroundResource(
                if (isMuted) R.drawable.ic_mic_off else R.drawable.ic_mic
            )
        }

        binding.speakerBtn.setOnClickListener {
            isSpeaker = !isSpeaker
            audioClient?.toggleSpeaker(isSpeaker)
            binding.speakerBtn.alpha = if (isSpeaker) 1.0f else 0.5f
        }

        binding.endCallBtn.setOnClickListener { endCall() }
    }

    private fun startCallTimer() {
        secondsElapsed = 0
        callTimer = object : CountDownTimer(Long.MAX_VALUE, 1000) {
            override fun onTick(millisUntilFinished: Long) {
                secondsElapsed++
                val minutes = secondsElapsed / 60
                val seconds = secondsElapsed % 60
                binding.callTimer.text = String.format("%02d:%02d", minutes, seconds)
            }
            override fun onFinish() {}
        }.start()
    }

    private fun endCall() {
        callTimer?.cancel()
        audioClient?.dispose()
        serverClient.endCall(callId)
        serverClient.disconnect()
        stopForegroundService()
        finish()
    }

    private fun startForegroundService() {
        val intent = Intent(this, CallForegroundService::class.java).apply {
            putExtra("callId", callId)
            putExtra("callerName", calleeName)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopForegroundService() {
        stopService(Intent(this, CallForegroundService::class.java))
    }

    override fun onBackPressed() {}

    override fun onDestroy() {
        super.onDestroy()
        callTimer?.cancel()
        audioClient?.dispose()
        serverClient.disconnect()
    }
}
