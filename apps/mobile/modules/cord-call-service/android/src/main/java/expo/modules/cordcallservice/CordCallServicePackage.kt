package expo.modules.cordcallservice

import android.app.Activity
import android.content.Context
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Cold start from a ring's full-screen intent: show over the lock screen when the activity is
 * created, not once JS has loaded. JS turns it off again when the incoming or call screen ends
 * (ringPlatform.setShowWhenLocked(false)); warm starts go through the module's OnNewIntent.
 */
class CordCallServicePackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context?,
  ): List<ReactActivityLifecycleListener> = listOf(
    object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        // A recreated activity (rotation, process restore) keeps the old ring intent: skip it.
        if (savedInstanceState == null && Ring.isRingIntent(activity.intent)) {
          Ring.showWhenLocked(activity, true)
        }
      }
    },
  )
}
