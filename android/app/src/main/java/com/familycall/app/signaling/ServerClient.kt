package com.familycall.app.signaling

import com.familycall.app.FamilyCallApp
import com.familycall.app.utils.Constants
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ServerClient private constructor() {

    companion object {
        @Volatile
        private var instance: ServerClient? = null

        fun getInstance(): ServerClient {
            return instance ?: synchronized(this) {
                instance ?: ServerClient().also { instance = it }
            }
        }
    }

    private val jsonMediaType = "application/json".toMediaType()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var messageListener: ((JSONObject) -> Unit)? = null
    private var connectedListener: (() -> Unit)? = null
    private var disconnectListener: (() -> Unit)? = null
    private var baseUrl: String = Constants.SERVER_URL

    fun isConnected(): Boolean = webSocket != null

    fun register(username: String, name: String, password: String, callback: (Boolean, String) -> Unit) {
        val json = JSONObject().apply {
            put("username", username)
            put("name", name)
            put("password", password)
        }
        val request = Request.Builder()
            .url("$baseUrl/api/register")
            .post(json.toString().toRequestBody(jsonMediaType))
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(false, e.message ?: "Network error")
            }
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string() ?: "{}"
                val json = JSONObject(body)
                callback(json.optBoolean("success", false), json.optString("error", ""))
            }
        })
    }

    fun login(username: String, password: String, callback: (Boolean, String) -> Unit) {
        val json = JSONObject().apply {
            put("username", username)
            put("password", password)
        }
        val request = Request.Builder()
            .url("$baseUrl/api/login")
            .post(json.toString().toRequestBody(jsonMediaType))
            .build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(false, e.message ?: "Network error")
            }
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string() ?: "{}"
                val json = JSONObject(body)
                callback(json.optBoolean("success", false), json.optString("error", ""))
            }
        })
    }

    fun getAllUsers(callback: (List<UserInfo>) -> Unit) {
        val request = Request.Builder().url("$baseUrl/api/users").get().build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(emptyList())
            }
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string() ?: "[]"
                val arr = JSONArray(body)
                val users = mutableListOf<UserInfo>()
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    users.add(UserInfo(
                        username = obj.optString("username"),
                        name = obj.optString("name"),
                        online = obj.optBoolean("online")
                    ))
                }
                callback(users)
            }
        })
    }

    fun getUserByUsername(username: String, callback: (UserInfo?) -> Unit) {
        val request = Request.Builder().url("$baseUrl/api/user/$username").get().build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(null)
            }
            override fun onResponse(call: Call, response: Response) {
                if (response.code == 404) { callback(null); return }
                val body = response.body?.string() ?: "{}"
                val obj = JSONObject(body)
                callback(UserInfo(
                    username = obj.optString("username"),
                    name = obj.optString("name"),
                    online = obj.optBoolean("online")
                ))
            }
        })
    }

    fun connectWebSocket(username: String, name: String) {
        if (webSocket != null) return
        val url = "$baseUrl/ws?username=$username&name=${name.replace(" ", "%20")}"
        val wsUrl = url.replace("http://", "ws://").replace("https://", "wss://")

        val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connectedListener?.invoke()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    messageListener?.invoke(json)
                } catch (e: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                this@ServerClient.webSocket = null
                disconnectListener?.invoke()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                this@ServerClient.webSocket = null
                disconnectListener?.invoke()
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    connectWebSocket(username, name)
                }, 3000)
            }
        })
    }

    fun initiateCall(calleeUsername: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "call")
            put("calleeUsername", calleeUsername)
        }.toString())
    }

    fun acceptCall(callId: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "accept_call")
            put("callId", callId)
        }.toString())
    }

    fun rejectCall(callId: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "reject_call")
            put("callId", callId)
        }.toString())
    }

    fun endCall(callId: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "end_call")
            put("callId", callId)
        }.toString())
    }

    fun sendChat(to: String, text: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "chat")
            put("to", to)
            put("text", text)
        }.toString())
    }

    fun getChatMessages(username: String, callback: (List<JSONObject>) -> Unit) {
        val request = Request.Builder().url("$baseUrl/api/messages/$username").get().build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { callback(emptyList()) }
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string() ?: "{}"
                val json = JSONObject(body)
                val myUser = FamilyCallApp.currentUsername
                val key = if (myUser < username) "$myUser:$username" else "$username:$myUser"
                val arr = json.optJSONArray(key) ?: JSONArray()
                val msgs = mutableListOf<JSONObject>()
                for (i in 0 until arr.length()) msgs.add(arr.getJSONObject(i))
                callback(msgs)
            }
        })
    }

    fun sendAudioChunk(callId: String, data: String) {
        webSocket?.send(JSONObject().apply {
            put("type", "audio")
            put("callId", callId)
            put("data", data)
        }.toString())
    }

    fun setMessageListener(listener: ((JSONObject) -> Unit)?) {
        messageListener = listener
    }

    fun setConnectedListener(listener: (() -> Unit)?) {
        connectedListener = listener
    }

    fun setDisconnectListener(listener: (() -> Unit)?) {
        disconnectListener = listener
    }

    fun disconnect() {
        webSocket?.close(1000, "User disconnected")
        webSocket = null
    }
}
