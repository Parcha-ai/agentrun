// display() is adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/wrappers/DisplayManager.java
// (getDisplayInfo through DisplayManagerGlobal) at a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.Device;
import android.content.Context;
import android.graphics.Point;
import android.os.Build;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;

/** The phone, as phoned's core sees it, run as the shell user from app_process. */
public final class AndroidDevice implements Device {
	static final String SECURE_WORDS = "the shell user cannot capture FLAG_SECURE windows on Android 12 and later; their "
			+ "frames are refused as denied";

	private final Facts facts;
	private final Ax ax = new Ax();
	private final Clipboard clipboard = new Clipboard();
	private final PhoneInput input = new PhoneInput(clipboard);
	private final PhoneScreen screen = new PhoneScreen(ax);
	private final PhoneApps apps = new PhoneApps();
	private final Clock clock = new Clock() {
		@Override
		public long now() {
			return SystemClock.uptimeMillis();
		}

		@Override
		public void sleep(long ms) throws InterruptedException {
			if (ms > 0) Thread.sleep(ms);
		}
	};

	public AndroidDevice() {
		String abi = Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
		facts = new Facts(Build.VERSION.RELEASE, Build.VERSION.SDK_INT, Build.MODEL, Build.MANUFACTURER, abi);
	}

	/** Lets go of the accessibility connection, so `uiautomator dump` works again once phoned is gone. */
	public void close() {
		ax.close();
	}

	@Override
	public Facts facts() {
		return facts;
	}

	@Override
	public Display display() {
		try {
			Object global = Class.forName("android.hardware.display.DisplayManagerGlobal").getDeclaredMethod("getInstance")
					.invoke(null);
			Method get = global.getClass().getMethod("getDisplayInfo", int.class);
			Object info = get.invoke(global, 0);
			if (info != null) {
				// logicalWidth and logicalHeight already follow the rotation.
				int w = Hidden.intField(info, "logicalWidth");
				int h = Hidden.intField(info, "logicalHeight");
				int rotation = Hidden.intField(info, "rotation");
				int dpi = Hidden.intField(info, "logicalDensityDpi");
				return new Display(w, h, dpi / 160.0, (rotation & 3) * 90);
			}
		} catch (ReflectiveOperationException | RuntimeException e) {
			Log.w("DisplayManagerGlobal.getDisplayInfo failed, using the public Display API", e);
		}
		return publicDisplay();
	}

	@SuppressWarnings("deprecation")
	private static Display publicDisplay() {
		FakeContext context = FakeContext.get();
		android.hardware.display.DisplayManager dm = context == null ? null
				: (android.hardware.display.DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
		android.view.Display d = dm == null ? null : dm.getDisplay(0);
		if (d == null) throw RpcError.unsupported("the phone's main display is not readable from phoned");
		Point size = new Point();
		d.getRealSize(size);
		DisplayMetrics metrics = new DisplayMetrics();
		d.getRealMetrics(metrics);
		return new Display(size.x, size.y, metrics.densityDpi / 160.0, (d.getRotation() & 3) * 90);
	}

	@Override
	public Map<String, Object> features() {
		Map<String, Object> f = new LinkedHashMap<>();
		Object tree = ax.feature();
		f.put("ui.tree", tree);
		f.put("ui.frames", tree == Boolean.TRUE ? Boolean.TRUE : "window frame stats come from the accessibility "
				+ "connection, which is off: " + tree);
		f.put("input.inject", input.feature());
		f.put("input.clipboard", clipboard.feature());
		f.put("screen.secure", SECURE_WORDS);
		return f;
	}

	@Override
	public Accessibility accessibility() throws RpcError {
		ax.ui(); // connects now, or throws in words
		return ax;
	}

	@Override
	public Input input() {
		return input;
	}

	@Override
	public Screen screen() {
		return screen;
	}

	@Override
	public Apps apps() {
		return apps;
	}

	@Override
	public Clock clock() {
		return clock;
	}
}
