// Adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/wrappers/ClipboardManager.java at
// 665ccb32f5306ebd866dc0d99f4d08ed2aeb91c3 (v2.7, the IClipboard version), Apache-2.0.
package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import android.content.ClipData;
import android.os.PersistableBundle;
import java.lang.reflect.Method;

/**
 * The phone's clipboard through IClipboard, as package com.android.shell (the clipboard checks the package belongs
 * to the caller's uid). scrcpy kept a table of the signatures each release and vendor build gave getPrimaryClip and
 * setPrimaryClip; here the widest method by that name is taken and its arguments filled by type, which covers every
 * row of that table and the device id Android 14 added: the first String is the package, any other String (the
 * attribution tag) is null, ints (user id, device id) are 0, a boolean (some vendors' "userOperate") is true.
 */
final class Clipboard {
	// SystemUI skips its "copied" overlay for clips from com.android.shell that carry this extra (Android 13+).
	private static final String SUPPRESS_OVERLAY = "com.android.systemui.SUPPRESS_CLIPBOARD_OVERLAY";
	private static final Class<?>[] ARG_TYPES = {ClipData.class, String.class, int.class, boolean.class};

	private boolean resolved;
	private String off;
	private Object service;
	private Method get;
	private Method set;
	private Method clear;

	/** Boolean.TRUE when setPrimaryClip resolved, or the reason it did not. */
	synchronized Object feature() {
		resolve();
		return off == null ? Boolean.TRUE : off;
	}

	private void resolve() {
		if (resolved) return;
		resolved = true;
		service = Hidden.service("clipboard", "android.content.IClipboard");
		if (service == null) {
			off = "this phone has no clipboard service phoned can reach";
			return;
		}
		get = Hidden.widest(service.getClass(), "getPrimaryClip", ARG_TYPES);
		set = Hidden.widest(service.getClass(), "setPrimaryClip", ARG_TYPES);
		clear = Hidden.widest(service.getClass(), "clearPrimaryClip", ARG_TYPES);
		if (set == null) off = "this Android build's IClipboard.setPrimaryClip has a signature phoned does not know";
	}

	private static Object[] args(Method m, ClipData clip) {
		Class<?>[] types = m.getParameterTypes();
		Object[] a = new Object[types.length];
		boolean packageGiven = false;
		for (int i = 0; i < types.length; i++) {
			Class<?> t = types[i];
			if (t == ClipData.class) {
				a[i] = clip;
			} else if (t == String.class) {
				a[i] = packageGiven ? null : FakeContext.PACKAGE_NAME;
				packageGiven = true;
			} else if (t == int.class) {
				a[i] = 0;
			} else if (t == boolean.class) {
				a[i] = Boolean.TRUE;
			}
		}
		return a;
	}

	/** The clip on the clipboard now, or null when it is empty or unreadable. */
	synchronized ClipData read() {
		resolve();
		if (get == null) return null;
		try {
			return (ClipData) Hidden.call(get, service, args(get, null));
		} catch (Throwable t) {
			Log.w("clipboard read failed", t);
			return null;
		}
	}

	synchronized void write(ClipData clip) {
		resolve();
		if (off != null) throw RpcError.unsupported("cannot paste: " + off);
		quiet(clip);
		try {
			Hidden.call(set, service, args(set, clip));
		} catch (Throwable t) {
			throw RpcError.denied("the phone refused to set its clipboard (" + t + ")");
		}
	}

	/** Empties the clipboard; when the phone has no clear call, leaves an empty text clip. */
	synchronized void clear() {
		resolve();
		try {
			if (clear != null) {
				Hidden.call(clear, service, args(clear, null));
				return;
			}
		} catch (Throwable t) {
			Log.w("clipboard clear failed, writing an empty clip", t);
		}
		write(ClipData.newPlainText(null, ""));
	}

	private static void quiet(ClipData clip) {
		try {
			PersistableBundle had = clip.getDescription().getExtras();
			PersistableBundle extras = had == null ? new PersistableBundle() : new PersistableBundle(had);
			extras.putBoolean(SUPPRESS_OVERLAY, true);
			clip.getDescription().setExtras(extras);
		} catch (RuntimeException e) {
			// Only the overlay shows; the paste still works.
		}
	}
}
