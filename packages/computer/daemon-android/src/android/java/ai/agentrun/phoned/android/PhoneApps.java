// The IActivityManager calls (startActivityAsUser, forceStopPackage) are adapted from scrcpy
// server/src/main/java/com/genymobile/scrcpy/wrappers/ActivityManager.java, and the launch intent from
// device/Device.java, at a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.Device;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The apps on the phone: listed through PackageManager, started and stopped through IActivityManager. */
final class PhoneApps implements Device.Apps {
	// UserHandle.USER_CURRENT, as scrcpy and `am` use it: the user in front.
	private static final int USER_CURRENT = -2;
	private static final Pattern PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");
	private static final Pattern RESUMED = Pattern.compile(
			"(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=]\\s*ActivityRecord\\{\\S+ u\\d+ ([^\\s/}]+)/");

	private boolean resolved;
	private Object am;
	private Method startActivityAsUser;
	private Method forceStopPackage;

	private synchronized void resolve() {
		if (resolved) return;
		resolved = true;
		try {
			Method getDefault = Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault");
			am = getDefault.invoke(null);
		} catch (ReflectiveOperationException | RuntimeException e) {
			am = Hidden.service("activity", "android.app.IActivityManager");
		}
		if (am == null) {
			Log.w("IActivityManager is not reachable; launching falls back to `am`", null);
			return;
		}
		try {
			Class<?> thread = Class.forName("android.app.IApplicationThread");
			Class<?> profiler = Class.forName("android.app.ProfilerInfo");
			startActivityAsUser = am.getClass().getMethod("startActivityAsUser", thread, String.class, Intent.class,
					String.class, IBinder.class, String.class, int.class, int.class, profiler, Bundle.class, int.class);
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.w("startActivityAsUser is not reachable; launching falls back to `am start`", e);
		}
		forceStopPackage = Hidden.method(am.getClass(), "forceStopPackage", String.class, int.class);
	}

	private static PackageManager pm() {
		FakeContext context = FakeContext.get();
		if (context == null) {
			throw RpcError.unsupported("the phone's package manager is not reachable from phoned (no system context); "
					+ "see phoned's log on the phone");
		}
		return context.getPackageManager();
	}

	@Override
	public List<Device.App> list() {
		PackageManager pm = pm();
		Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
		Map<String, Device.App> apps = new TreeMap<>();
		for (ResolveInfo ri : pm.queryIntentActivities(launcher, 0)) {
			if (ri.activityInfo == null) continue;
			String id = ri.activityInfo.packageName;
			if (apps.containsKey(id)) continue;
			String name = id;
			String version = null;
			try {
				CharSequence label = ri.activityInfo.applicationInfo.loadLabel(pm);
				if (label != null) name = label.toString();
				PackageInfo info = pm.getPackageInfo(id, 0);
				version = info.versionName;
			} catch (PackageManager.NameNotFoundException | RuntimeException e) {
				// keep the id as its name
			}
			apps.put(id, new Device.App(id, name, version));
		}
		return new ArrayList<>(apps.values());
	}

	@Override
	public String foreground() {
		String top = topTask();
		if (top != null) return top;
		try {
			Matcher m = RESUMED.matcher(Shell.run(5000, "dumpsys", "activity", "activities").output);
			return m.find() ? m.group(1) : null;
		} catch (Exception e) {
			Log.w("dumpsys activity failed", e);
			return null;
		}
	}

	/** The top task's package on display 0, through IActivityTaskManager.getTasks; null when unreachable. */
	private static String topTask() {
		Object atm = Hidden.service("activity_task", "android.app.IActivityTaskManager");
		if (atm == null) return null;
		Method getTasks = Hidden.widest(atm.getClass(), "getTasks", int.class, boolean.class);
		if (getTasks == null) return null;
		// getTasks(maxNum) on Android 11, then (maxNum, filterOnlyVisibleRecents, keepIntentExtra) and, from
		// Android 14, a trailing displayId.
		Class<?>[] types = getTasks.getParameterTypes();
		Object[] args = new Object[types.length];
		boolean first = true;
		for (int i = 0; i < types.length; i++) {
			if (types[i] == int.class) {
				args[i] = first ? 1 : 0;
				first = false;
			} else {
				args[i] = Boolean.FALSE;
			}
		}
		try {
			@SuppressWarnings("unchecked")
			List<ActivityManager.RunningTaskInfo> tasks = (List<ActivityManager.RunningTaskInfo>) Hidden.call(getTasks,
					atm, args);
			if (tasks == null || tasks.isEmpty()) return null;
			ComponentName top = tasks.get(0).topActivity;
			return top == null ? null : top.getPackageName();
		} catch (Throwable t) {
			Log.w("getTasks failed", t);
			return null;
		}
	}

	@Override
	public void launch(String id, String url) {
		checkId(id);
		PackageManager pm = pm();
		installed(pm, id);
		Intent intent;
		if (url == null) {
			intent = pm.getLaunchIntentForPackage(id);
			if (intent == null) intent = pm.getLeanbackLaunchIntentForPackage(id);
			if (intent == null) throw RpcError.notFound(id + " is installed but has no launcher activity to start");
			// A cleared task starts the app itself, not whatever its task last held (Settings' search, on Android 15).
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
		} else {
			// A deep link is one VIEW intent: the app opens at the page it names.
			intent = new Intent(Intent.ACTION_VIEW);
			intent.setData(Uri.parse(url));
			intent.setPackage(id);
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			if (pm.queryIntentActivities(intent, 0).isEmpty()) throw RpcError.notFound(id + " has no activity that opens that url");
		}
		resolve();
		if (startActivityAsUser != null) {
			int code;
			try {
				code = (Integer) Hidden.call(startActivityAsUser, am, null, FakeContext.PACKAGE_NAME, intent, null, null,
						null, 0, 0, null, null, USER_CURRENT);
			} catch (SecurityException e) {
				throw RpcError.denied("the phone refused to start " + id + " (" + e.getMessage() + ")");
			} catch (Throwable t) {
				Log.w("startActivityAsUser failed, using `am start`", t);
				amStart(id, intent);
				return;
			}
			checkStart(id, code);
			return;
		}
		amStart(id, intent);
	}

	// ActivityManager.START_* results: 0 to 3 started or brought the task forward; -100 to -89 are fatal; 100 and up
	// mean the phone held the start back.
	private static void checkStart(String id, int code) {
		if (code >= 0 && code < 100) return;
		switch (code) {
			case -91: // START_INTENT_NOT_RESOLVED
			case -92: // START_CLASS_NOT_FOUND
				throw RpcError.notFound(id + " has no activity for that intent");
			case -94: // START_PERMISSION_DENIED
				throw RpcError.denied(id + "'s activity is not exported to other apps, so it cannot be started from outside");
			case -98: // START_NOT_CURRENT_USER_ACTIVITY
				throw RpcError.denied(id + " belongs to a user who is not in front on the phone");
			case 100: // START_SWITCHES_CANCELED
				throw RpcError.denied("the phone held back starting " + id + " (app switches pause for a few seconds "
						+ "after Home is pressed); try again shortly");
			case 101: // START_RETURN_LOCK_TASK_MODE_VIOLATION
				throw RpcError.denied("the phone is pinned to one app (lock task mode), so " + id + " cannot start");
			default:
				throw RpcError.denied("the phone refused to start " + id + " (ActivityManager result " + code + ")");
		}
	}

	/** The same start through `am start -W`, as an argv list: the url and action are never parsed by a shell. */
	private static void amStart(String id, Intent intent) {
		List<String> argv = new ArrayList<>();
		argv.add("am");
		argv.add("start");
		argv.add("-W");
		argv.add("-f");
		argv.add(String.valueOf(intent.getFlags()));
		if (intent.getComponent() != null) {
			argv.add("-n");
			argv.add(intent.getComponent().flattenToString());
		} else {
			argv.add("-a");
			argv.add(intent.getAction());
			if (intent.getData() != null) {
				argv.add("-d");
				argv.add(intent.getData().toString());
			}
			argv.add("-p");
			argv.add(id);
		}
		Shell.Result r;
		try {
			r = Shell.run(30000, argv.toArray(new String[0]));
		} catch (Exception e) {
			throw RpcError.unsupported("could not run `am start` for " + id + " (" + e.getMessage() + ")");
		}
		if (r.exit != 0 || r.output.contains("Error:") || r.output.contains("Error type")) {
			String words = r.output.trim();
			if (words.length() > 300) words = words.substring(0, 300);
			if (words.contains("unable to resolve") || words.contains("does not exist")) {
				throw RpcError.notFound(id + " has no activity for that intent: " + words);
			}
			throw RpcError.denied("`am start` could not start " + id + ": " + words);
		}
	}

	@Override
	public void terminate(String id) {
		checkId(id);
		installed(pm(), id);
		resolve();
		if (forceStopPackage != null) {
			try {
				Hidden.call(forceStopPackage, am, id, USER_CURRENT);
				return;
			} catch (SecurityException e) {
				throw RpcError.denied("the phone refused to stop " + id + " (" + e.getMessage() + ")");
			} catch (Throwable t) {
				Log.w("forceStopPackage failed, using `am force-stop`", t);
			}
		}
		Shell.Result r;
		try {
			r = Shell.run(15000, "am", "force-stop", id);
		} catch (Exception e) {
			throw RpcError.unsupported("could not run `am force-stop " + id + "` (" + e.getMessage() + ")");
		}
		if (r.exit != 0) throw RpcError.denied("`am force-stop " + id + "` failed: " + r.output.trim());
	}

	private static void checkId(String id) {
		if (id == null || !PACKAGE.matcher(id).matches()) {
			throw RpcError.invalid("\"" + id + "\" is not an Android package name (like com.android.settings)");
		}
	}

	private static void installed(PackageManager pm, String id) {
		try {
			pm.getPackageInfo(id, 0);
		} catch (PackageManager.NameNotFoundException e) {
			throw RpcError.notFound("no app " + id + " is installed on this phone");
		}
	}
}
