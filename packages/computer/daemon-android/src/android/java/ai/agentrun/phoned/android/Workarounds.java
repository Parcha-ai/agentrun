// Adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/Workarounds.java and Server.java (prepareMainLooper)
// at a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import android.app.Application;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Looper;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Makes an app_process look enough like an app for the framework classes phoned uses: a main looper, an
 * ActivityThread, and a system context. Each step that fails is logged and skipped; the features that need it then
 * turn off with a reason instead of the process dying.
 */
final class Workarounds {
	private static Class<?> activityThreadClass;
	private static Object activityThread;
	private static Context systemContext;

	private Workarounds() {}

	/** Like Looper.prepareMainLooper(), but with quit allowed, as scrcpy does it. */
	static void prepareMainLooper() {
		Looper.prepare();
		synchronized (Looper.class) {
			try {
				Field field = Looper.class.getDeclaredField("sMainLooper");
				field.setAccessible(true);
				field.set(null, Looper.myLooper());
			} catch (ReflectiveOperationException | RuntimeException e) {
				Log.w("could not set the main looper", e);
			}
		}
	}

	/** Builds the ActivityThread and its system context. Call on the main thread after prepareMainLooper(). */
	static void apply() {
		try {
			activityThreadClass = Class.forName("android.app.ActivityThread");
			Constructor<?> ctor = activityThreadClass.getDeclaredConstructor();
			ctor.setAccessible(true);
			activityThread = ctor.newInstance();
			Field current = activityThreadClass.getDeclaredField("sCurrentActivityThread");
			current.setAccessible(true);
			current.set(null, activityThread);
			Field system = activityThreadClass.getDeclaredField("mSystemThread");
			system.setAccessible(true);
			system.setBoolean(activityThread, true);
		} catch (Throwable t) {
			Log.w("could not build an ActivityThread; app listing and launching by intent turn off", t);
			activityThread = null;
			return;
		}
		if (Build.VERSION.SDK_INT >= 31) fillConfigurationController();
		if (!"ONYX".equalsIgnoreCase(Build.BRAND)) fillAppInfo();
		try {
			Method get = activityThreadClass.getDeclaredMethod("getSystemContext");
			systemContext = (Context) get.invoke(activityThread);
		} catch (Throwable t) {
			Log.w("could not get the system context", t);
		}
		fillAppContext();
	}

	/** The system context, or null when apply() could not build one. */
	static Context systemContext() {
		return systemContext;
	}

	private static void fillAppInfo() {
		try {
			Class<?> bindDataClass = Class.forName("android.app.ActivityThread$AppBindData");
			Constructor<?> ctor = bindDataClass.getDeclaredConstructor();
			ctor.setAccessible(true);
			Object bindData = ctor.newInstance();
			ApplicationInfo info = new ApplicationInfo();
			info.packageName = FakeContext.PACKAGE_NAME;
			Field appInfo = bindDataClass.getDeclaredField("appInfo");
			appInfo.setAccessible(true);
			appInfo.set(bindData, info);
			Field bound = activityThreadClass.getDeclaredField("mBoundApplication");
			bound.setAccessible(true);
			bound.set(activityThread, bindData);
		} catch (Throwable t) {
			Log.w("could not fill app info (not needed on most phones)", t);
		}
	}

	private static void fillAppContext() {
		FakeContext context = FakeContext.get();
		if (context == null) return;
		try {
			Application app = Instrumentation.newApplication(Application.class, context);
			Field initial = activityThreadClass.getDeclaredField("mInitialApplication");
			initial.setAccessible(true);
			initial.set(activityThread, app);
		} catch (Throwable t) {
			Log.w("could not fill the app context (not needed on most phones)", t);
		}
	}

	// Some Samsung builds read the configuration through ActivityThread on Android 12 and later.
	private static void fillConfigurationController() {
		try {
			Class<?> controllerClass = Class.forName("android.app.ConfigurationController");
			Class<?> internalClass = Class.forName("android.app.ActivityThreadInternal");
			Constructor<?> ctor = controllerClass.getDeclaredConstructor(internalClass);
			ctor.setAccessible(true);
			Object controller = ctor.newInstance(activityThread);
			Field field = activityThreadClass.getDeclaredField("mConfigurationController");
			field.setAccessible(true);
			field.set(activityThread, controller);
		} catch (Throwable t) {
			Log.w("could not fill the configuration controller (not needed on most phones)", t);
		}
	}
}
