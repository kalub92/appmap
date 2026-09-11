// Debug-only router export receiver (01 R6). Declared in src/debug/AndroidManifest.xml.
//
//   adb shell am broadcast -a com.example.app.APPMAP_EXPORT --es path /sdcard/router-export.json [--es git_sha <sha>]
//
// Writes AppMapRouterRegistry.exportJson() to `path`; if that location is not writable under scoped
// storage it falls back to the app-specific external files dir, then to internal files. The path
// actually written is returned as the broadcast result data (`adb` prints `data="…"`) and logged.
package com.example.appmap

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import java.io.IOException

class AppMapExportReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requested = intent.getStringExtra(EXTRA_PATH)
        val gitSha = intent.getStringExtra(EXTRA_GIT_SHA)?.takeIf { it.isNotBlank() }
        val json = try {
            AppMapRouterRegistry.exportJson(context.packageName, AppMapBuildInfo.current(context, gitSha))
        } catch (e: IllegalStateException) {
            Log.e(TAG, "router export refused", e)
            if (isOrderedBroadcast) setResult(Activity.RESULT_CANCELED, e.message, null)
            return
        }

        val candidates = listOfNotNull(
            requested?.takeIf { it.isNotBlank() }?.let(::File),
            context.getExternalFilesDir(null)?.let { File(it, DEFAULT_NAME) },
            File(context.filesDir, DEFAULT_NAME),
        )
        for (target in candidates) {
            try {
                target.parentFile?.mkdirs()
                val tmp = File(target.parentFile, "${target.name}.tmp")
                tmp.writeText(json)
                if (!tmp.renameTo(target)) throw IOException("rename failed for $target")
                Log.i(TAG, "router export written to ${target.absolutePath}")
                if (isOrderedBroadcast) setResult(Activity.RESULT_OK, target.absolutePath, null)
                return
            } catch (e: IOException) {
                Log.w(TAG, "cannot write router export to ${target.absolutePath}: ${e.message}")
            } catch (e: SecurityException) {
                Log.w(TAG, "cannot write router export to ${target.absolutePath}: ${e.message}")
            }
        }
        Log.e(TAG, "router export failed: no writable location")
        if (isOrderedBroadcast) setResult(Activity.RESULT_CANCELED, "no writable location", null)
    }

    private companion object {
        const val TAG = "app-map"
        const val EXTRA_PATH = "path"
        const val EXTRA_GIT_SHA = "git_sha"
        const val DEFAULT_NAME = "router-export.json"
    }
}
