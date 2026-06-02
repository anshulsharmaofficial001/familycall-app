package com.familycall.app

import android.content.Intent
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.appcompat.app.AppCompatActivity
import com.familycall.app.databinding.ActivityIncomingCallBinding
import com.familycall.app.signaling.ServerClient

class IncomingCallActivity : AppCompatActivity() {

    private lateinit var binding: ActivityIncomingCallBinding
    private lateinit var serverClient: ServerClient
    private var ringtone: Ringtone? = null
    private var callId: String = ""
    private var callerName: String = ""
    private var callerUsername: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityIncomingCallBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true)
        }

        serverClient = ServerClient.getInstance()

        callId = intent?.getStringExtra("callId") ?: ""
        callerName = intent?.getStringExtra("callerName") ?: "Unknown"
        callerUsername = intent?.getStringExtra("callerUsername") ?: ""

        binding.callerName.text = callerName
        binding.callerUsername.text = "@$callerUsername"
        try { binding.callerAvatarLetter.text = callerName.firstOrNull()?.uppercase() ?: "?" } catch(e: Exception) {}

        startRinging()
        startVibration()

        binding.acceptBtn.setOnClickListener {
            stopRinging()
            val intent = Intent(this, CallActivity::class.java).apply {
                putExtra("callId", callId)
                putExtra("calleeUsername", callerUsername)
                putExtra("calleeName", callerName)
                putExtra("isCaller", false)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            finish()
        }

        binding.declineBtn.setOnClickListener {
            stopRinging()
            serverClient.rejectCall(callId)
            finish()
        }
    }

    private fun startRinging() {
        try {
            val notificationUri: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(this, notificationUri)
            ringtone?.play()
        } catch (e: Exception) {}
    }

    private fun stopRinging() {
        ringtone?.stop()
        ringtone = null
    }

    private fun startVibration() {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager = getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager
                manager.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(VIBRATOR_SERVICE) as Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(
                    longArrayOf(0, 1000, 500, 1000, 500),
                    intArrayOf(0, 255, 0, 255, 0), -1
                ))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(longArrayOf(0, 1000, 500, 1000, 500), -1)
            }
        } catch (e: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        stopRinging()
    }
}
