package com.familycall.app.utils

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

object UpdateChecker {

    private const val VERSION_URL = "${Constants.SERVER_URL}/api/version"

    fun checkForUpdate(activity: Activity) {
        Thread {
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(10, TimeUnit.SECONDS)
                    .build()

                val request = Request.Builder().url(VERSION_URL).build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: return@Thread
                val json = JSONObject(body)

                val latestVersionCode = json.optInt("versionCode", 0)
                val latestVersionName = json.optString("versionName", "")
                val apkUrl = json.optString("apkUrl", "")
                val releaseNotes = json.optString("releaseNotes", "New features available!")

                val currentVersionCode = activity.packageManager
                    .getPackageInfo(activity.packageName, 0)
                    .let {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                            it.longVersionCode.toInt()
                        else
                            @Suppress("DEPRECATION") it.versionCode
                    }

                if (latestVersionCode > currentVersionCode && apkUrl.isNotEmpty()) {
                    activity.runOnUiThread {
                        showUpdateDialog(activity, latestVersionName, releaseNotes, apkUrl)
                    }
                }
            } catch (e: Exception) {
                // Silent fail — update check is non-critical
            }
        }.start()
    }

    private fun showUpdateDialog(
        activity: Activity,
        versionName: String,
        releaseNotes: String,
        apkUrl: String
    ) {
        AlertDialog.Builder(activity)
            .setTitle("🎉 Update Available — v$versionName")
            .setMessage("$releaseNotes\n\nDownload and install the latest version?")
            .setPositiveButton("Update Now") { _, _ ->
                downloadAndInstall(activity, apkUrl, versionName)
            }
            .setNegativeButton("Later", null)
            .setCancelable(false)
            .show()
    }

    private fun downloadAndInstall(activity: Activity, apkUrl: String, versionName: String) {
        try {
            val fileName = "FamilyCall_v${versionName}.apk"
            val downloadManager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

            // Remove old APK if exists
            val oldFile = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
            if (oldFile.exists()) oldFile.delete()

            val request = DownloadManager.Request(Uri.parse(apkUrl)).apply {
                setTitle("FamilyCall Update")
                setDescription("Downloading v$versionName...")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalFilesDir(
                    activity,
                    Environment.DIRECTORY_DOWNLOADS,
                    fileName
                )
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
            }

            val downloadId = downloadManager.enqueue(request)

            // Listen for download completion
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (id == downloadId) {
                        activity.unregisterReceiver(this)
                        val apkFile = File(
                            activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                            fileName
                        )
                        if (apkFile.exists()) {
                            installApk(activity, apkFile)
                        }
                    }
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.registerReceiver(
                    receiver,
                    IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                    Context.RECEIVER_NOT_EXPORTED
                )
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                activity.registerReceiver(
                    receiver,
                    IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
                )
            }

            android.widget.Toast.makeText(
                activity,
                "Downloading update... You'll be notified when done.",
                android.widget.Toast.LENGTH_LONG
            ).show()

        } catch (e: Exception) {
            android.widget.Toast.makeText(
                activity,
                "Download failed: ${e.message}",
                android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun installApk(activity: Activity, apkFile: File) {
        try {
            val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                FileProvider.getUriForFile(
                    activity,
                    "${activity.packageName}.fileprovider",
                    apkFile
                )
            } else {
                Uri.fromFile(apkFile)
            }

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            // Check if we can install unknown apps
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (!activity.packageManager.canRequestPackageInstalls()) {
                    val settingsIntent = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    AlertDialog.Builder(activity)
                        .setTitle("Permission Required")
                        .setMessage("Allow FamilyCall to install updates. Go to Settings and enable 'Install Unknown Apps' for FamilyCall.")
                        .setPositiveButton("Open Settings") { _, _ ->
                            activity.startActivity(settingsIntent)
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                    return
                }
            }

            activity.startActivity(installIntent)
        } catch (e: Exception) {
            android.widget.Toast.makeText(
                activity,
                "Install failed: ${e.message}",
                android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }
}
