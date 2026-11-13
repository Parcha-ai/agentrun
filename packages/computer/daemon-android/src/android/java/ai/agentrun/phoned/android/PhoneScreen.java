package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.device.Rect;
import android.graphics.Bitmap;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Screenshots through the same UiAutomation as the tree (UiAutomation.takeScreenshot). The shell user cannot capture
 * FLAG_SECURE windows on Android 12 and later: they come back black. A black frame is checked against `dumpsys window`
 * and, when the focused window is secure, the Shot says which package blocked it.
 */
final class PhoneScreen implements Device.Screen {
	private static final int GRID = 16;
	private static final Pattern FOCUS = Pattern.compile("mCurrentFocus=Window\\{(\\S+) u\\d+ ([^\\s/}]+)");
	private static final Pattern FLAGS = Pattern.compile("(?:^|\\s)fl=([^\\n]*)");

	private final Ax ax;

	PhoneScreen(Ax ax) {
		this.ax = ax;
	}

	@Override
	public Device.Shot shot(Rect crop, int maxEdge, String format, int quality) {
		Bitmap.CompressFormat encoding = encoding(format);
		if (encoding == Bitmap.CompressFormat.JPEG && (quality < 1 || quality > 100)) {
			throw RpcError.invalid("jpeg quality is 1 to 100, not " + quality);
		}
		Bitmap frame;
		try {
			frame = ax.ui().takeScreenshot();
		} catch (IllegalStateException e) {
			ax.close();
			frame = ax.ui().takeScreenshot();
		}
		if (frame == null) {
			String secure = secureFocus();
			if (secure != null) return new Device.Shot(new byte[0], 0, 0, secure);
			throw RpcError.unsupported("the phone gave no screenshot; it may be locked with the screen off, or busy: "
					+ "wake it and try again");
		}
		if (frame.getConfig() == Bitmap.Config.HARDWARE) {
			// Android 11 to 13 hand back a hardware bitmap, whose pixels cannot be read in place.
			Bitmap soft = frame.copy(Bitmap.Config.ARGB_8888, false);
			frame.recycle();
			if (soft == null) throw RpcError.unsupported("the phone's screenshot could not be copied out of graphics memory");
			frame = soft;
		}
		try {
			if (allBlack(frame, appArea(frame))) {
				String secure = secureFocus();
				if (secure != null) return new Device.Shot(new byte[0], 0, 0, secure);
			}
			Bitmap cropped = cut(frame, crop);
			Bitmap out = scale(cropped, maxEdge);
			try {
				ByteArrayOutputStream bytes = new ByteArrayOutputStream();
				if (!out.compress(encoding, encoding == Bitmap.CompressFormat.PNG ? 100 : quality, bytes)) {
					throw RpcError.unsupported("the phone could not encode the screenshot as " + format);
				}
				return new Device.Shot(bytes.toByteArray(), out.getWidth(), out.getHeight(), null);
			} finally {
				if (out != cropped) out.recycle();
				if (cropped != frame) cropped.recycle();
			}
		} finally {
			frame.recycle();
		}
	}

	private static Bitmap.CompressFormat encoding(String format) {
		if ("png".equals(format)) return Bitmap.CompressFormat.PNG;
		if ("jpeg".equals(format)) return Bitmap.CompressFormat.JPEG;
		throw RpcError.invalid("screenshot format is \"png\" or \"jpeg\", not \"" + format + "\"");
	}

	private static Bitmap cut(Bitmap frame, Rect crop) {
		if (crop == null) return frame;
		Rect inside = crop.intersect(new Rect(0, 0, frame.getWidth(), frame.getHeight()));
		if (inside.empty()) {
			throw RpcError.invalid("the crop " + crop + " lies outside the screen (" + frame.getWidth() + "x"
					+ frame.getHeight() + ")");
		}
		if (inside.width() == frame.getWidth() && inside.height() == frame.getHeight()) return frame;
		return Bitmap.createBitmap(frame, inside.left, inside.top, inside.width(), inside.height());
	}

	private static Bitmap scale(Bitmap in, int maxEdge) {
		int longer = Math.max(in.getWidth(), in.getHeight());
		if (maxEdge <= 0 || longer <= maxEdge) return in;
		double f = (double) maxEdge / longer;
		int w = Math.max(1, (int) Math.round(in.getWidth() * f));
		int h = Math.max(1, (int) Math.round(in.getHeight() * f));
		return Bitmap.createScaledBitmap(in, w, h, true);
	}

	/**
	 * Where the focused app draws: a secure window is black while the status and navigation bars still draw, so the
	 * check looks inside the app's window. The whole frame when the window list is not to be had.
	 */
	private Rect appArea(Bitmap frame) {
		Rect all = new Rect(0, 0, frame.getWidth(), frame.getHeight());
		try {
			List<AccessibilityWindowInfo> windows = ax.ui().getWindows();
			for (AccessibilityWindowInfo w : windows) {
				if (w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION || !(w.isFocused() || w.isActive())) continue;
				// The window's own bounds can lie in another space than the screen's pixels (UiDriver.boundsOf); its
				// root's are the screen's, so they stand first.
				android.graphics.Rect r = new android.graphics.Rect();
				android.view.accessibility.AccessibilityNodeInfo root = w.getRoot();
				if (root != null) {
					root.getBoundsInScreen(r);
					root.recycle();
				} else {
					w.getBoundsInScreen(r);
				}
				Rect in = new Rect(r.left, r.top, r.right, r.bottom).intersect(all);
				if (!in.empty()) return in;
			}
		} catch (RuntimeException e) {
			// fall back to the whole frame
		}
		return all;
	}

	/** Every pixel of a 16 by 16 grid over area is pure black. */
	private static boolean allBlack(Bitmap frame, Rect area) {
		for (int i = 0; i < GRID; i++) {
			int y = area.top + (int) ((i + 0.5) * area.height() / GRID);
			for (int j = 0; j < GRID; j++) {
				int x = area.left + (int) ((j + 0.5) * area.width() / GRID);
				if ((frame.getPixel(x, y) & 0xFFFFFF) != 0) return false;
			}
		}
		return true;
	}

	/** The package of the focused window when that window has FLAG_SECURE, else null. */
	static String secureFocus() {
		String dump;
		try {
			dump = Shell.run(5000, "dumpsys", "window", "windows").output;
		} catch (Exception e) {
			Log.w("dumpsys window failed", e);
			return null;
		}
		Matcher focus = FOCUS.matcher(dump);
		if (!focus.find()) return null;
		String token = focus.group(1);
		String pkg = focus.group(2);
		// The window's own section starts at "Window #N Window{token ..." and runs to the next "Window #".
		int start = dump.indexOf("Window{" + token + " ");
		while (start >= 0) {
			int lineStart = dump.lastIndexOf('\n', start) + 1;
			if (dump.substring(lineStart, start).trim().startsWith("Window #")) break;
			start = dump.indexOf("Window{" + token + " ", start + 1);
		}
		if (start < 0) return null;
		int end = dump.indexOf("Window #", start);
		String section = dump.substring(start, end < 0 ? dump.length() : end);
		Matcher flags = FLAGS.matcher(section);
		while (flags.find()) {
			for (String flag : flags.group(1).trim().split("\\s+")) {
				if (flag.equals("SECURE")) return pkg;
			}
		}
		return null;
	}
}
