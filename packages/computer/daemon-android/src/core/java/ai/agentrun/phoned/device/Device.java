package ai.agentrun.phoned.device;

import ai.agentrun.phoned.RpcError;
import java.util.List;
import java.util.Map;

/**
 * Everything phoned needs from the phone, behind small interfaces: the Android layer implements them with the
 * platform's APIs, and the JVM tests with fakes. Each call throws RpcError in words when the phone cannot do it.
 */
public interface Device {
	/** What the phone is, read once. */
	Facts facts();

	/** The screen now: it turns, so it is read each time. */
	Display display();

	/**
	 * What works on this phone and what does not, with the reason: feature name to Boolean.TRUE, or to a String that
	 * says why it is off. hello carries it.
	 */
	Map<String, Object> features();

	Accessibility accessibility() throws RpcError;

	Input input();

	Screen screen();

	Apps apps();

	Clock clock();

	/** The phone's static facts. */
	final class Facts {
		public final String release;
		public final int sdk;
		public final String model;
		public final String maker;
		/** The primary ABI as Android names it: arm64-v8a, x86_64. */
		public final String abi;

		public Facts(String release, int sdk, String model, String maker, String abi) {
			this.release = release;
			this.sdk = sdk;
			this.model = model;
			this.maker = maker;
			this.abi = abi;
		}
	}

	/** The screen as it is now: pixels in its current orientation, and density as dp scale (dpi / 160). */
	final class Display {
		public final int width;
		public final int height;
		public final double scale;
		/** 0, 90, 180 or 270. */
		public final int rotation;

		public Display(int width, int height, double scale, int rotation) {
			this.width = width;
			this.height = height;
			this.scale = scale;
			this.rotation = rotation;
		}
	}

	/** The accessibility tree, its windows, and its event stream. */
	interface Accessibility {
		/** The windows on the phone's main display, top first. */
		List<AxWindow> windows();

		/** How many accessibility events the phone has sent so far: a count that only grows. */
		long events();

		/**
		 * How many frames the window presented since the last call, or -1 when the phone cannot say. The settle rule
		 * uses it beside the event stream.
		 */
		int framesSince(int windowId);

		/** The system's own navigation as an accessibility global action: back, home or app_switch. False when refused. */
		boolean global(String nav);
	}

	/** One window on the screen. */
	interface AxWindow {
		int id();

		/** application, input_method, system, accessibility_overlay, split_screen_divider, magnification_overlay. */
		String type();

		String title();

		Rect bounds();

		boolean active();

		boolean focused();

		/** Its root element, or null when the window holds none the phone will give. */
		AxNode root();
	}

	/** Input as the phone's own input system takes it: injected, on the main display. */
	interface Input {
		/**
		 * One finger along points: down at the first, through each, up at the last, over ms in all (0: a tap). Each point
		 * is {x, y} in screen pixels.
		 */
		void touch(int[][] points, long ms);

		/** Two fingers from two points to two others over ms: a pinch. */
		void pinch(int[][] from, int[][] to, long ms);

		/** One key pressed and let go, with meta (Android's META_* bits). */
		void key(int keyCode, int meta);

		void keyDown(int keyCode, int meta);

		void keyUp(int keyCode, int meta);

		/** Types text the keyboard map can spell (ASCII), as key events; false when it cannot spell it all. */
		boolean typeKeys(String text);

		/** Types any text: onto the clipboard, pasted, and the clipboard put back as it was. */
		void paste(String text);
	}

	/** The screen's pixels. */
	interface Screen {
		/**
		 * One frame of the screen, cut to crop (null: all of it), scaled down so its longer edge is at most maxEdge
		 * (0: as it is), encoded as format ("png" or "jpeg", quality 1 to 100 for jpeg).
		 */
		Shot shot(Rect crop, int maxEdge, String format, int quality);
	}

	/** One encoded frame. */
	final class Shot {
		public final byte[] bytes;
		/** The image's own pixels. */
		public final int width;
		public final int height;
		/**
		 * The package whose window blocks capture (FLAG_SECURE), when the frame came back blank because of it; null
		 * otherwise. The driver refuses such a shot as denied.
		 */
		public final String secure;

		public Shot(byte[] bytes, int width, int height, String secure) {
			this.bytes = bytes;
			this.width = width;
			this.height = height;
			this.secure = secure;
		}
	}

	/** The apps on the phone. */
	interface Apps {
		List<App> list();

		/** The package in front, or null. */
		String foreground();

		/** Starts id's launcher activity in a cleared task; with url, opens the url (a deep link) in id. */
		void launch(String id, String url);

		void terminate(String id);
	}

	final class App {
		public final String id;
		public final String name;
		public final String version;

		public App(String id, String name, String version) {
			this.id = id;
			this.name = name;
			this.version = version;
		}
	}

	/** Time, as the driver waits on it: a monotonic clock in ms. */
	interface Clock {
		long now();

		void sleep(long ms) throws InterruptedException;
	}
}
