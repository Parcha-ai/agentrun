// Adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/wrappers/ServiceManager.java at
// a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import android.os.IBinder;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

/**
 * Small reflection helpers for the hidden framework APIs phoned reaches as the shell user. Nothing here throws a
 * checked exception at a caller that has not asked for one: lookups return null when the API is missing.
 */
final class Hidden {
	private Hidden() {}

	/** A system service's AIDL interface (ServiceManager.getService then Stub.asInterface), or null. */
	static Object service(String name, String aidl) {
		try {
			Method get = Class.forName("android.os.ServiceManager").getMethod("getService", String.class);
			IBinder binder = (IBinder) get.invoke(null, name);
			if (binder == null) return null;
			Method asInterface = Class.forName(aidl + "$Stub").getMethod("asInterface", IBinder.class);
			return asInterface.invoke(null, binder);
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.w("service " + name + " (" + aidl + ") is not reachable", e);
			return null;
		}
	}

	/** A public method by exact signature, or null. */
	static Method method(Class<?> cls, String name, Class<?>... params) {
		try {
			return cls.getMethod(name, params);
		} catch (NoSuchMethodException | RuntimeException e) {
			return null;
		}
	}

	/**
	 * The public instance method called name with the most parameters, all of them of the allowed types, or null.
	 * AIDL proxies grow a parameter every few releases (attribution tag, device id); this finds whichever one this
	 * phone has, and the caller fills the arguments by type.
	 */
	static Method widest(Class<?> cls, String name, Class<?>... allowed) {
		Method best = null;
		for (Method m : cls.getMethods()) {
			if (!m.getName().equals(name) || Modifier.isStatic(m.getModifiers())) continue;
			if (!onlyOf(m.getParameterTypes(), allowed)) continue;
			if (best == null || m.getParameterTypes().length > best.getParameterTypes().length) best = m;
		}
		if (best != null) {
			try {
				best.setAccessible(true);
			} catch (RuntimeException e) {
				// The proxy class is private on some builds; the method is public on its interface anyway.
			}
		}
		return best;
	}

	private static boolean onlyOf(Class<?>[] types, Class<?>[] allowed) {
		outer:
		for (Class<?> t : types) {
			for (Class<?> a : allowed) {
				if (t == a) continue outer;
			}
			return false;
		}
		return true;
	}

	/** Calls m and gives back what the framework threw, not the reflection wrapper around it. */
	static Object call(Method m, Object target, Object... args) throws Throwable {
		try {
			return m.invoke(target, args);
		} catch (InvocationTargetException e) {
			throw e.getCause() != null ? e.getCause() : e;
		}
	}

	/** An int field of obj by name, read even when it is not public. */
	static int intField(Object obj, String name) throws ReflectiveOperationException {
		java.lang.reflect.Field f = obj.getClass().getDeclaredField(name);
		f.setAccessible(true);
		return f.getInt(obj);
	}
}
