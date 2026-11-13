// The injection wrapper is adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/wrappers/InputManager.java
// at 665ccb32f5306ebd866dc0d99f4d08ed2aeb91c3 (v2.7, InputManagerGlobal on Android 14+), and the key and text paths
// from device/Device.java and control/Controller.java at a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.Device;
import android.content.ClipData;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;

/** Touches and keys injected into the phone's input system on display 0, as `input` does it. */
final class PhoneInput implements Device.Input {
	private static final int MODE_ASYNC = 0;
	// The call returns once the app has handled the event: a tap has landed when touch() returns.
	private static final int MODE_WAIT_FOR_FINISH = 2;
	// One MOVE about every 10 ms, so a swipe reads as a finger to the app's velocity tracker.
	private static final long STEP_MS = 10;
	private static final long PASTE_SETTLE_MS = 100;

	private final Clipboard clipboard;
	private final Map<Integer, Long> keyDownTimes = new HashMap<>();

	private boolean resolved;
	private String off;
	private Object manager;
	private Method inject;
	private Method setDisplayId;

	PhoneInput(Clipboard clipboard) {
		this.clipboard = clipboard;
	}

	/** Boolean.TRUE when injectInputEvent resolved, or the reason it did not. */
	synchronized Object feature() {
		resolve();
		return off == null ? Boolean.TRUE : off;
	}

	private void resolve() {
		if (resolved) return;
		resolved = true;
		try {
			Class<?> cls;
			try {
				// Android 14 moved injection to InputManagerGlobal.
				cls = Class.forName("android.hardware.input.InputManagerGlobal");
			} catch (ClassNotFoundException e) {
				cls = android.hardware.input.InputManager.class;
			}
			Method getInstance = cls.getDeclaredMethod("getInstance");
			getInstance.setAccessible(true);
			manager = getInstance.invoke(null);
			inject = manager.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);
			setDisplayId = Hidden.method(InputEvent.class, "setDisplayId", int.class);
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.w("input injection is not reachable", e);
			off = "this Android build hides InputManager.injectInputEvent (" + e + ")";
		}
	}

	private synchronized void inject(InputEvent event, int mode) {
		resolve();
		if (off != null) throw RpcError.unsupported("cannot inject input: " + off);
		if (setDisplayId != null) {
			try {
				setDisplayId.invoke(event, 0);
			} catch (ReflectiveOperationException | RuntimeException e) {
				// Display 0 is the default target anyway.
			}
		}
		boolean ok;
		try {
			ok = (Boolean) Hidden.call(inject, manager, event, mode);
		} catch (SecurityException e) {
			throw RpcError.denied(refusedWords() + " (" + e.getMessage() + ")");
		} catch (Throwable t) {
			throw RpcError.denied("the phone's input system failed to take the event (" + t + ")");
		}
		if (!ok) throw RpcError.denied(refusedWords());
	}

	private static String refusedWords() {
		return "the phone refused the injected input; on Xiaomi, Redmi and POCO phones turn on \"USB debugging "
				+ "(Security settings)\" in Developer options, and check that no secure prompt (a PIN pad, a permission "
				+ "dialog) is in front";
	}

	// ---- touch ----

	@Override
	public void touch(int[][] points, long ms) {
		checkPoints(points, "touch");
		int n = points.length;
		float[] cum = new float[n];
		for (int i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(points[i - 1], points[i]);
		float total = cum[n - 1];

		long down = SystemClock.uptimeMillis();
		injectMotion(down, MotionEvent.ACTION_DOWN, xy(points[0]));
		float[] last = xy(points[0]);
		try {
			if (ms <= 0) {
				for (int i = 1; i < n; i++) {
					last = xy(points[i]);
					injectMotion(down, MotionEvent.ACTION_MOVE, last);
				}
			} else if (total > 0) {
				long steps = Math.max(1, ms / STEP_MS);
				for (long k = 1; k <= steps; k++) {
					sleepUntil(down + ms * k / steps);
					last = along(points, cum, total * k / steps);
					injectMotion(down, MotionEvent.ACTION_MOVE, last);
				}
			} else {
				sleepUntil(down + ms); // a press held in place
			}
		} catch (RuntimeException e) {
			// A cancel or a refused move ends the touch: the app must not keep a finger held down.
			releaseAfterFailure(down, MotionEvent.ACTION_CANCEL, last);
			throw e;
		}
		injectMotion(down, MotionEvent.ACTION_UP, xy(points[n - 1]));
	}

	/** Best effort: end a touch the request could not finish, so the app sees a cancel, not a press held forever. */
	private void releaseAfterFailure(long down, int action, float[] at) {
		try {
			injectMotion(down, action, at);
		} catch (RuntimeException e) {
			Log.w("could not cancel an interrupted gesture", e);
		}
	}

	private void injectMotion(long down, int action, float[] at) {
		MotionEvent.PointerProperties[] props = {finger(0)};
		MotionEvent.PointerCoords[] coords = {coords(at)};
		boolean edge = action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_UP;
		motion(down, action, props, coords, edge ? MODE_WAIT_FOR_FINISH : MODE_ASYNC);
	}

	@Override
	public void pinch(int[][] from, int[][] to, long ms) {
		if (from == null || to == null || from.length != 2 || to.length != 2) {
			throw RpcError.invalid("a pinch takes two start points and two end points");
		}
		checkPoints(from, "pinch");
		checkPoints(to, "pinch");
		MotionEvent.PointerProperties[] one = {finger(0)};
		MotionEvent.PointerProperties[] two = {finger(0), finger(1)};
		int second = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;

		long down = SystemClock.uptimeMillis();
		motion(down, MotionEvent.ACTION_DOWN, one, new MotionEvent.PointerCoords[] {coords(xy(from[0]))},
				MODE_WAIT_FOR_FINISH);
		motion(down, MotionEvent.ACTION_POINTER_DOWN | second, two,
				new MotionEvent.PointerCoords[] {coords(xy(from[0])), coords(xy(from[1]))}, MODE_ASYNC);
		long steps = Math.max(1, Math.max(0, ms) / STEP_MS);
		try {
			for (long k = 1; k <= steps; k++) {
				if (ms > 0) sleepUntil(down + ms * k / steps);
				float f = (float) k / steps;
				motion(down, MotionEvent.ACTION_MOVE, two,
						new MotionEvent.PointerCoords[] {coords(lerp(from[0], to[0], f)), coords(lerp(from[1], to[1], f))},
						MODE_ASYNC);
			}
		} catch (RuntimeException e) {
			// Both fingers end in a cancel, so the app does not keep a pinch held.
			try {
				motion(down, MotionEvent.ACTION_CANCEL, two,
						new MotionEvent.PointerCoords[] {coords(xy(from[0])), coords(xy(from[1]))}, MODE_ASYNC);
			} catch (RuntimeException inner) {
				Log.w("could not cancel an interrupted pinch", inner);
			}
			throw e;
		}
		motion(down, MotionEvent.ACTION_POINTER_UP | second, two,
				new MotionEvent.PointerCoords[] {coords(xy(to[0])), coords(xy(to[1]))}, MODE_ASYNC);
		motion(down, MotionEvent.ACTION_UP, one, new MotionEvent.PointerCoords[] {coords(xy(to[0]))},
				MODE_WAIT_FOR_FINISH);
	}

	private void motion(
			long down, int action, MotionEvent.PointerProperties[] props, MotionEvent.PointerCoords[] coords, int mode) {
		long now = SystemClock.uptimeMillis();
		MotionEvent e = MotionEvent.obtain(down, now, action, props.length, props, coords, 0, 0, 1f, 1f, 0, 0,
				InputDevice.SOURCE_TOUCHSCREEN, 0);
		try {
			inject(e, mode);
		} finally {
			e.recycle();
		}
	}

	private static MotionEvent.PointerProperties finger(int id) {
		MotionEvent.PointerProperties p = new MotionEvent.PointerProperties();
		p.id = id;
		p.toolType = MotionEvent.TOOL_TYPE_FINGER;
		return p;
	}

	private static MotionEvent.PointerCoords coords(float[] at) {
		MotionEvent.PointerCoords c = new MotionEvent.PointerCoords();
		c.x = at[0];
		c.y = at[1];
		c.pressure = 1f;
		c.size = 1f;
		return c;
	}

	private static void checkPoints(int[][] points, String what) {
		if (points == null || points.length == 0) throw RpcError.invalid(what + " needs at least one point");
		for (int[] p : points) {
			if (p == null || p.length != 2) throw RpcError.invalid(what + " points are [x, y] pairs in screen pixels");
		}
	}

	private static float[] xy(int[] p) {
		return new float[] {p[0], p[1]};
	}

	private static float dist(int[] a, int[] b) {
		return (float) Math.hypot(b[0] - a[0], b[1] - a[1]);
	}

	private static float[] lerp(int[] a, int[] b, float f) {
		return new float[] {a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f};
	}

	/** The point at distance d along the path through points (cum holds each point's distance from the start). */
	private static float[] along(int[][] points, float[] cum, float d) {
		for (int i = 1; i < points.length; i++) {
			if (d <= cum[i] || i == points.length - 1) {
				float seg = cum[i] - cum[i - 1];
				float f = seg <= 0 ? 1f : Math.min(1f, Math.max(0f, (d - cum[i - 1]) / seg));
				return lerp(points[i - 1], points[i], f);
			}
		}
		return xy(points[points.length - 1]);
	}

	private static void sleepUntil(long uptime) {
		long wait = uptime - SystemClock.uptimeMillis();
		if (wait <= 0) return;
		try {
			Thread.sleep(wait);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw RpcError.aborted("the gesture was interrupted");
		}
	}

	// ---- keys ----

	@Override
	public void key(int keyCode, int meta) {
		keyDown(keyCode, meta);
		keyUp(keyCode, meta);
	}

	@Override
	public void keyDown(int keyCode, int meta) {
		checkKey(keyCode);
		long now = SystemClock.uptimeMillis();
		synchronized (keyDownTimes) {
			keyDownTimes.put(keyCode, now);
		}
		injectKey(now, now, KeyEvent.ACTION_DOWN, keyCode, meta);
	}

	@Override
	public void keyUp(int keyCode, int meta) {
		checkKey(keyCode);
		long now = SystemClock.uptimeMillis();
		Long down;
		synchronized (keyDownTimes) {
			down = keyDownTimes.remove(keyCode);
		}
		injectKey(down == null ? now : down, now, KeyEvent.ACTION_UP, keyCode, meta);
	}

	private void injectKey(long down, long when, int action, int keyCode, int meta) {
		KeyEvent e = new KeyEvent(down, when, action, keyCode, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0,
				InputDevice.SOURCE_KEYBOARD);
		inject(e, MODE_WAIT_FOR_FINISH);
	}

	private static void checkKey(int keyCode) {
		if (keyCode <= KeyEvent.KEYCODE_UNKNOWN || keyCode > KeyEvent.getMaxKeyCode()) {
			throw RpcError.invalid("key code " + keyCode + " is not an Android KEYCODE_ value (1 to "
					+ KeyEvent.getMaxKeyCode() + " on this phone)");
		}
	}

	@Override
	public boolean typeKeys(String text) {
		if (text == null || text.isEmpty()) return true;
		KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
		if (events == null) return false; // a character the keyboard map cannot spell: nothing was typed
		for (KeyEvent e : events) {
			e.setSource(InputDevice.SOURCE_KEYBOARD);
			inject(e, MODE_WAIT_FOR_FINISH);
		}
		return true;
	}

	@Override
	public void paste(String text) {
		ClipData old = clipboard.read();
		clipboard.write(ClipData.newPlainText(null, text == null ? "" : text));
		try {
			key(KeyEvent.KEYCODE_PASTE, 0);
			sleepUntil(SystemClock.uptimeMillis() + PASTE_SETTLE_MS);
		} finally {
			try {
				if (old != null && old.getItemCount() > 0) {
					clipboard.write(old);
				} else {
					clipboard.clear();
				}
			} catch (RuntimeException e) {
				Log.w("could not put the clipboard back after a paste", e);
			}
		}
	}
}
