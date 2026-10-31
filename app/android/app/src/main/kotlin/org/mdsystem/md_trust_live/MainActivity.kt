package org.mdsystem.md_trust_live

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.content.Intent
import android.os.Build
import android.Manifest
import android.content.pm.PackageManager
import java.util.concurrent.Executors

class MainActivity: FlutterActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        // Network pairing runs off the UI thread; results return on the UI thread.
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.mdsystem.md_trust_live/control").setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "getLanguage" -> result.success(getSharedPreferences("mdtl", MODE_PRIVATE).getString("language", "auto"))
                    "setLanguage" -> {
                        // Keep language preference independent from pairing and device keys.
                        val language = call.argument<String>("language") ?: "auto"
                        require(language in listOf("auto", "en", "es", "de", "fr", "ru", "uk", "ja")) { "Unsupported language" }
                        getSharedPreferences("mdtl", MODE_PRIVATE).edit().putString("language", language).apply()
                        if (LiveService.active) startService(Intent(this, LiveService::class.java).setAction("LANGUAGE_CHANGED"))
                        result.success(null)
                    }
                    "status" -> result.success(TrustProtocol(this).snapshot())
                    "pair" -> {
                        val url = call.argument<String>("url") ?: ""
                        val code = call.argument<String>("code") ?: ""
                        worker.execute {
                            try { TrustProtocol(this).pair(url, code); runOnUiThread { result.success(null) } }
                            catch (error: Exception) { runOnUiThread { result.error("PAIR_FAILED", error.message, null) } }
                        }
                    }
                    "start" -> {
                        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2101)
                            result.error("NOTIFICATION_PERMISSION", "Enable notifications, then press Start again", null)
                        } else { startForegroundService(Intent(this, LiveService::class.java)); result.success(null) }
                    }
                    "stop" -> { startService(Intent(this, LiveService::class.java).setAction("STOP")); result.success(null) }
                    "giveawayOpen", "giveawayLock", "giveawayDraw" -> {
                        require(LiveService.active) { "Start a live session first" }
                        startService(Intent(this, LiveService::class.java).setAction(call.method).putExtra("prize", call.argument<String>("prize") ?: ""))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (error: Exception) { result.error("DEVICE_ERROR", error.message, null) }
        }
    }
    override fun onDestroy() {
        // Foreground service lifetime is independent from the activity.
        worker.shutdown(); super.onDestroy()
    }
}
