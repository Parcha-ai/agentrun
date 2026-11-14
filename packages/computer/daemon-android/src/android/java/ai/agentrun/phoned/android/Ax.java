package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.AxRefusal;
import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.device.Rect;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Build;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.SparseArray;
import android.view.WindowContentFrameStats;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The phone's accessibility tree through a UiAutomation built by hand, the way uiautomator does it from an
 * instrumentation (the constructor and connect(int) are hidden). Only one UiAutomation may be registered on a phone at
 * a time, so this one connects on the first ui call, not at start: `uiautomator dump` keeps working until then.
 */
final class Ax implements Device.Accessibility {
	private final AtomicLong events = new AtomicLong();

	// What reflection found, resolved once by probe().
	private boolean probed;
	private String off;
	private Constructor<?> connectionCtor;
	private Constructor<?> looperCtor;
	private Constructor<?> contextCtor;
	private Method connect;

	private HandlerThread thread;
	private volatile UiAutomation ui;

	/** Boolean.TRUE when a UiAutomation can be built here, or the reason it cannot. Does not connect. */
	synchronized Object feature() {
		probe();
		return off == null ? Boolean.TRUE : off;
	}

	private void probe() {
		if (probed) return;
		probed = true;
		try {
			Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
			Class<?> connectionIface = Class.forName("android.app.IUiAutomationConnection");
			connectionCtor = connectionClass.getDeclaredConstructor();
			connectionCtor.setAccessible(true);
			// Looper-based on every release so far (deprecated on Android 14); Context-based from Android 14.
			looperCtor = ctor(UiAutomation.class, Looper.class, connectionIface);
			contextCtor = ctor(UiAutomation.class, Context.class, connectionIface);
			connect = UiAutomation.class.getMethod("connect", int.class);
			if (looperCtor == null && contextCtor == null) {
				off = "this Android build has no UiAutomation constructor phoned knows (Looper or Context based)";
			}
		} catch (ReflectiveOperationException | RuntimeException e) {
			off = "this Android build hides UiAutomation's connection classes (" + e + ")";
		}
	}

	private static Constructor<?> ctor(Class<?> cls, Class<?>... params) {
		try {
			Constructor<?> c = cls.getDeclaredConstructor(params);
			c.setAccessible(true);
			return c;
		} catch (NoSuchMethodException | RuntimeException e) {
			return null;
		}
	}

	/** The connected UiAutomation, connecting on first use. */
	UiAutomation ui() {
		UiAutomation u = ui;
		if (u != null) return u;
		synchronized (this) {
			if (ui == null) ui = connectNow();
			return ui;
		}
	}

	private UiAutomation connectNow() {
		probe();
		if (off != null) throw RpcError.unsupported("the accessibility tree is not reachable: " + off);
		if (thread == null) {
			thread = new HandlerThread("phoned-ax");
			thread.start();
		}
		Looper looper = thread.getLooper();
		UiAutomation u = null;
		try {
			Object connection = connectionCtor.newInstance();
			u = build(looper, connection);
			// A plain connect() would unbind every other accessibility service on the phone (TalkBack, password
			// managers) for as long as phoned runs; this flag keeps them.
			Hidden.call(connect, u, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
		} catch (Throwable t) {
			Log.w("UiAutomation connect failed", t);
			if (u != null) destroy(u);
			throw AxRefusal.of(t);
		}
		try {
			AccessibilityServiceInfo info = u.getServiceInfo();
			if (info != null) {
				info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
						| AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
						| AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
				u.setServiceInfo(info);
			}
			u.setOnAccessibilityEventListener(event -> events.incrementAndGet());
		} catch (RuntimeException e) {
			Log.w("UiAutomation setup failed", e);
			destroy(u);
			throw RpcError.unsupported("connected to the phone's accessibility service but could not ask it for all "
					+ "windows and view ids (" + e + "); try again");
		}
		Log.i("UiAutomation connected");
		return u;
	}

	private UiAutomation build(Looper looper, Object connection) throws Throwable {
		FakeContext base = FakeContext.get();
		if (Build.VERSION.SDK_INT >= 34 && contextCtor != null && base != null) {
			// The Context constructor takes its callback looper from the context: hand it phoned's own thread, since
			// the main thread is busy reading stdin and never loops.
			Context context = new ContextWrapper(base) {
				@Override
				public Looper getMainLooper() {
					return looper;
				}
			};
			try {
				return (UiAutomation) contextCtor.newInstance(context, connection);
			} catch (ReflectiveOperationException | RuntimeException e) {
				if (looperCtor == null) throw e;
				Log.w("UiAutomation(Context) failed, using UiAutomation(Looper)", e);
			}
		}
		if (looperCtor == null) throw new IllegalStateException("no Looper constructor and no system context");
		return (UiAutomation) looperCtor.newInstance(looper, connection);
	}

	private static void destroy(UiAutomation u) {
		try {
			Method m = UiAutomation.class.getMethod("destroy");
			m.invoke(u);
		} catch (Throwable t) {
			// Best effort: a half-built automation holds nothing the phone needs back.
		}
	}

	/** Lets go of the phone's accessibility so `uiautomator dump` works again. Safe to call twice. */
	synchronized void close() {
		UiAutomation u = ui;
		ui = null;
		if (u == null) return;
		try {
			Method m = UiAutomation.class.getMethod("disconnect");
			m.invoke(u);
		} catch (Throwable t) {
			Log.w("UiAutomation disconnect failed", t);
		}
	}

	/** Runs a read against the automation; when the connection dropped, connects again once. */
	private <T> T withUi(java.util.function.Function<UiAutomation, T> read) {
		UiAutomation u = ui();
		try {
			return read.apply(u);
		} catch (IllegalStateException e) {
			Log.w("UiAutomation dropped, reconnecting", e);
			synchronized (this) {
				if (ui == u) ui = null;
			}
			return read.apply(ui());
		}
	}

	@Override
	public List<Device.AxWindow> windows() {
		List<AccessibilityWindowInfo> list = withUi(u -> {
			List<AccessibilityWindowInfo> found = null;
			SparseArray<List<AccessibilityWindowInfo>> all = u.getWindowsOnAllDisplays();
			if (all != null) found = all.get(0);
			if (found == null || found.isEmpty()) found = u.getWindows();
			return found == null ? new ArrayList<>() : new ArrayList<>(found);
		});
		// The phone already reports them top first; sort by layer so it holds whatever the build does.
		Collections.sort(list, (a, b) -> Integer.compare(b.getLayer(), a.getLayer()));
		List<Device.AxWindow> out = new ArrayList<>(list.size());
		for (AccessibilityWindowInfo w : list) out.add(new Window(w));
		return out;
	}

	@Override
	public long events() {
		return events.get();
	}

	@Override
	public int framesSince(int windowId) {
		try {
			UiAutomation u = ui();
			WindowContentFrameStats stats = u.getWindowContentFrameStats(windowId);
			if (stats == null) return -1;
			int frames = stats.getFrameCount();
			u.clearWindowContentFrameStats(windowId);
			return frames;
		} catch (RuntimeException e) {
			return -1;
		}
	}

	@Override
	public boolean global(String nav) {
		int action;
		switch (nav) {
			case "back":
				action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK;
				break;
			case "home":
				action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME;
				break;
			case "app_switch":
				action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS;
				break;
			default:
				throw RpcError.invalid("nav " + nav + " is not back, home or app_switch");
		}
		return withUi(u -> u.performGlobalAction(action));
	}

	/** One window as AccessibilityWindowInfo describes it. */
	private static final class Window implements Device.AxWindow {
		private final AccessibilityWindowInfo w;

		Window(AccessibilityWindowInfo w) {
			this.w = w;
		}

		@Override
		public int id() {
			return w.getId();
		}

		@Override
		public String type() {
			switch (w.getType()) {
				case AccessibilityWindowInfo.TYPE_APPLICATION:
					return "application";
				case AccessibilityWindowInfo.TYPE_INPUT_METHOD:
					return "input_method";
				case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY:
					return "accessibility_overlay";
				case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER:
					return "split_screen_divider";
				case 6: // TYPE_MAGNIFICATION_OVERLAY, Android 13
					return "magnification_overlay";
				default:
					return "system";
			}
		}

		@Override
		public String title() {
			CharSequence t = w.getTitle();
			return t == null ? "" : t.toString();
		}

		@Override
		public Rect bounds() {
			android.graphics.Rect r = new android.graphics.Rect();
			w.getBoundsInScreen(r);
			return new Rect(r.left, r.top, r.right, r.bottom);
		}

		@Override
		public boolean active() {
			return w.isActive();
		}

		@Override
		public boolean focused() {
			return w.isFocused();
		}

		@Override
		public ai.agentrun.phoned.device.AxNode root() {
			try {
				AccessibilityNodeInfo root = w.getRoot();
				return root == null ? null : new Node(root);
			} catch (RuntimeException e) {
				return null;
			}
		}
	}
}
