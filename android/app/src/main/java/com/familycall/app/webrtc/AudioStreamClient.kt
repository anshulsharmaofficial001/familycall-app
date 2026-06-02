package com.familycall.app.webrtc

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioAttributes
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

class AudioStreamClient(private val context: Context) {

    private val isRunning = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var audioManager: AudioManager? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var previousSpeakerState: Boolean = false
    private var recordThread: Thread? = null
    private var onConnected: (() -> Unit)? = null

    private val sampleRate = 16000
    private val bufferSize = maxOf(
        AudioRecord.getMinBufferSize(sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
        sampleRate / 5
    )

    fun setOnConnected(callback: () -> Unit) {
        onConnected = callback
    }

    fun start(onAudioChunk: (String) -> Unit): Boolean {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            return false
        }

        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager?.let {
            previousAudioMode = it.mode
            previousSpeakerState = it.isSpeakerphoneOn
            it.mode = AudioManager.MODE_IN_COMMUNICATION
        }

        audioRecord = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)

        audioTrack = if (android.os.Build.VERSION.SDK_INT >= 29) {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setAudioFormat(AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build())
                .setBufferSizeInBytes(bufferSize)
                .build()
        } else {
            @Suppress("DEPRECATION")
            AudioTrack(AudioManager.STREAM_VOICE_CALL, sampleRate,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                bufferSize, AudioTrack.MODE_STREAM)
        }

        isRunning.set(true)

        try {
            audioRecord?.startRecording()
            audioTrack?.play()
        } catch (e: Exception) {
            return false
        }

        onConnected?.invoke()

        recordThread = Thread {
            val buffer = ByteArray(bufferSize)
            while (isRunning.get()) {
                try {
                    val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                    if (read > 0) {
                        val chunk = buffer.copyOf(read)
                        val encoded = Base64.encodeToString(chunk, Base64.NO_WRAP)
                        onAudioChunk(encoded)
                    }
                } catch (e: Exception) { break }
            }
        }.also { it.start() }

        return true
    }

    fun onAudioReceived(encodedData: String) {
        try {
            val bytes = Base64.decode(encodedData, Base64.NO_WRAP)
            audioTrack?.write(bytes, 0, bytes.size)
        } catch (e: Exception) {}
    }

    fun setMuted(muted: Boolean) {
        audioRecord?.let {
            try {
                if (muted) it.stop() else it.startRecording()
            } catch (e: Exception) {}
        }
    }

    fun toggleSpeaker(useSpeaker: Boolean) {
        audioManager?.isSpeakerphoneOn = useSpeaker
    }

    fun dispose() {
        isRunning.set(false)
        recordThread?.join(500)
        try {
            audioRecord?.stop()
            audioTrack?.stop()
        } catch (e: Exception) {}
        audioRecord?.release()
        audioTrack?.release()
        audioRecord = null
        audioTrack = null
        audioManager?.let {
            it.isSpeakerphoneOn = previousSpeakerState
            it.mode = previousAudioMode
        }
        audioManager = null
    }
}
