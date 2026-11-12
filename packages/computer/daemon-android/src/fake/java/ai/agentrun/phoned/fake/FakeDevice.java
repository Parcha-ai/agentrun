package ai.agentrun.phoned.fake;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.AxNode;
import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.device.Rect;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;

/**
 * A scripted phone for the JVM: Settings with its "Network & internet" row, which opens the Internet page. phoned's
 * core runs over it in the unit tests, and FakeMain serves it on stdio for the TypeScript side and the live probe's dry
 * run. Its clock is virtual in tests (a sleep moves it on at once) and real under FakeMain.
 */
public final class FakeDevice implements Device {
	public static final String SETTINGS = "com.android.settings";

	public int width = 1080;
	public int height = 2400;
	public double scale = 2.0;
	public final Map<String, Object> features = new LinkedHashMap<>();
	/** Every input and global action, in order, as words: "tap 540,800", "key 4/0", "global back". */
	public final List<String> log = Collections.synchronizedList(new ArrayList<>());
	/** The package whose secure window blanks every shot, or null. */
	public String secure;
	public long events;
	/** Frames each window presented since it was last asked. */
	public final Map<Integer, Integer> frames = new LinkedHashMap<>();
	public final List<FakeWindow> windows = new ArrayList<>();
	public final List<App> apps = new ArrayList<>();
	public final boolean virtual;
	private long now;

	public FakeNode list;
	public FakeNode network;
	public FakeNode wifi;
	public FakeNode search;

	public FakeDevice(boolean virtualClock) {
		this.virtual = virtualClock;
		features.put("ui.tree", Boolean.TRUE);
		features.put("input.inject", Boolean.TRUE);
		features.put("input.clipboard", Boolean.TRUE);
		apps.add(new App(SETTINGS, "Settings", "15"));
		apps.add(new App("com.android.chrome", "Chrome", "130.0"));
		settings();
	}

	/** One window as the scene shows it. */
	public static final class FakeWindow implements AxWindow {
		public final int id;
		public String type = "application";
		public String title;
		public Rect bounds;
		public boolean active = true;
		public FakeNode root;

		public FakeWindow(int id, String title, Rect bounds, FakeNode root) {
			this.id = id;
			this.title = title;
			this.bounds = bounds;
			this.root = root;
		}

		@Override
		public int id() {
			return id;
		}

		@Override
		public String type() {
			return type;
		}

		@Override
		public String title() {
			return title;
		}

		@Override
		public Rect bounds() {
			return bounds;
		}

		@Override
		public boolean active() {
			return active;
		}

		@Override
		public boolean focused() {
			return active;
		}

		@Override
		public AxNode root() {
			return root;
		}
	}

	/** Something on the screen changed: an event, and a frame in each window. */
	public synchronized void changed() {
		events += 3;
		for (FakeWindow w : windows) frames.merge(w.id, 2, Integer::sum);
	}

	private static FakeNode row(String title, String summary, int top, Runnable click) {
		FakeNode row = FakeNode.of("android.widget.LinearLayout").at(0, top, 1080, top + 200).tappable();
		row.on(a -> {
			if (a.equals("ACTION_CLICK")) click.run();
		});
		FakeNode words = FakeNode.of("android.widget.RelativeLayout").at(160, top + 30, 900, top + 170);
		words.add(FakeNode.of("android.widget.TextView").at(160, top + 30, 900, top + 100).text(title).id("android:id/title"));
		if (summary != null) words.add(FakeNode.of("android.widget.TextView").at(160, top + 100, 900, top + 170).text(summary).id("android:id/summary"));
		row.add(FakeNode.of("android.widget.ImageView").at(40, top + 60, 120, top + 140), words);
		return row;
	}

	/** Settings' first page, in front. */
	public synchronized void settings() {
		for (FakeWindow w : windows) w.root.gone();
		windows.clear();
		list = FakeNode.of("androidx.recyclerview.widget.RecyclerView").at(0, 300, 1080, 2400).id("com.android.settings:id/recycler_view");
		list.scrollable = true;
		search = FakeNode.of("android.widget.TextView").at(40, 160, 1040, 280).text("Search settings").id("com.android.settings:id/search_action_bar").tappable();
		network = row("Network & internet", "Mobile, Wi-Fi, hotspot", 300, this::internet);
		FakeNode bluetooth = row("Connected devices", "Bluetooth, pairing", 500, () -> {});
		FakeNode apps = row("Apps", "Assistant, recent apps, default apps", 700, () -> {});
		FakeNode offscreen = row("System", "Languages, gestures, time, backup", 2500, () -> {}).hidden();
		list.add(network, bluetooth, apps, offscreen);
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, 2400);
		root.add(FakeNode.of("android.widget.LinearLayout").at(0, 0, 1080, 0), search, list);
		root.pkg(SETTINGS);
		windows.add(new FakeWindow(10, "Settings", new Rect(0, 0, 1080, 2400), root));
		changed();
	}

	/** The Internet page: a Wi-Fi row with its own switch, and a text field. */
	public synchronized void internet() {
		for (FakeWindow w : windows) w.root.gone();
		windows.clear();
		wifi = FakeNode.of("android.widget.Switch").at(900, 360, 1040, 440).id("android:id/switch_widget");
		wifi.checkable = true;
		wifi.clickable = true;
		wifi.checked = true;
		FakeNode row = FakeNode.of("android.widget.LinearLayout").at(0, 300, 1080, 500).tappable();
		row.add(FakeNode.of("android.widget.TextView").at(160, 330, 800, 400).text("Wi-Fi"), FakeNode.of("android.widget.TextView").at(160, 400, 800, 470).text("Home network"), wifi);
		FakeNode field = FakeNode.of("android.widget.EditText").at(40, 600, 1040, 720).id("com.android.settings:id/name");
		field.editable = true;
		field.hint = "Network name";
		FakeNode secret = FakeNode.of("android.widget.EditText").at(40, 760, 1040, 880).id("com.android.settings:id/password");
		secret.editable = true;
		secret.password = true;
		secret.text = "hunter2";
		secret.hint = "Password";
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, 2400);
		root.add(FakeNode.of("android.widget.TextView").at(40, 120, 1040, 240).text("Internet"), row, field, secret);
		root.pkg(SETTINGS);
		windows.add(new FakeWindow(11, "Internet", new Rect(0, 0, 1080, 2400), root));
		changed();
	}

	/** Back: the Internet page returns to Settings. */
	synchronized void back() {
		if (!windows.isEmpty() && windows.get(0).id == 11) settings();
	}

	/** The deepest live, visible clickable element under a pixel, clicked as the app would on a tap. */
	synchronized void tap(int x, int y) {
		for (FakeWindow w : new ArrayList<>(windows)) {
			FakeNode hit = deepest(w.root, x, y);
			if (hit != null) {
				hit.perform("ACTION_CLICK", null);
				return;
			}
		}
	}

	private static FakeNode deepest(FakeNode n, int x, int y) {
		if (n == null || !n.alive || !n.visible || !n.bounds.contains(x, y)) return null;
		for (int i = n.children.size() - 1; i >= 0; i--) {
			FakeNode hit = deepest(n.children.get(i), x, y);
			if (hit != null) return hit;
		}
		return n.clickable ? n : null;
	}

	private synchronized FakeNode focusedField() {
		for (FakeWindow w : windows) {
			FakeNode f = focused(w.root);
			if (f != null) return f;
		}
		return null;
	}

	private static FakeNode focused(FakeNode n) {
		if (n.editable && n.focused) return n;
		for (FakeNode c : n.children) {
			FakeNode f = focused(c);
			if (f != null) return f;
		}
		return null;
	}

	@Override
	public Facts facts() {
		return new Facts("15", 35, "Pixel 9", "Google", "arm64-v8a");
	}

	@Override
	public Display display() {
		return new Display(width, height, scale, 0);
	}

	@Override
	public Map<String, Object> features() {
		return features;
	}

	@Override
	public Accessibility accessibility() {
		if (!Boolean.TRUE.equals(features.get("ui.tree"))) throw RpcError.unsupported("the accessibility tree is not reachable: " + features.get("ui.tree"));
		return a11y;
	}

	private final Accessibility a11y = new Accessibility() {
		@Override
		public List<AxWindow> windows() {
			synchronized (FakeDevice.this) {
				return new ArrayList<>(windows);
			}
		}

		@Override
		public long events() {
			synchronized (FakeDevice.this) {
				return events;
			}
		}

		@Override
		public int framesSince(int windowId) {
			synchronized (FakeDevice.this) {
				Integer n = frames.remove(windowId);
				return n == null ? 0 : n;
			}
		}

		@Override
		public boolean global(String nav) {
			log.add("global " + nav);
			if (nav.equals("back")) back();
			else if (nav.equals("home")) changed();
			return true;
		}
	};

	@Override
	public Input input() {
		return input;
	}

	private final Input input = new Input() {
		@Override
		public void touch(int[][] points, long ms) {
			StringBuilder s = new StringBuilder(points.length == 1 ? "tap " : "touch ");
			for (int i = 0; i < points.length; i++) s.append(i > 0 ? ";" : "").append(points[i][0]).append(',').append(points[i][1]);
			if (points.length > 1) s.append(' ').append(ms).append("ms");
			log.add(s.toString());
			if (points.length == 1) tap(points[0][0], points[0][1]);
			else changed();
		}

		@Override
		public void pinch(int[][] from, int[][] to, long ms) {
			log.add("pinch " + from[0][0] + "," + from[0][1] + "+" + from[1][0] + "," + from[1][1] + " to " + to[0][0] + "," + to[0][1] + "+" + to[1][0] + "," + to[1][1] + " " + ms + "ms");
		}

		@Override
		public void key(int keyCode, int meta) {
			log.add("key " + keyCode + "/" + meta);
			if (keyCode == 4) back();
		}

		@Override
		public void keyDown(int keyCode, int meta) {
			log.add("down " + keyCode + "/" + meta);
		}

		@Override
		public void keyUp(int keyCode, int meta) {
			log.add("up " + keyCode + "/" + meta);
		}

		@Override
		public boolean typeKeys(String text) {
			log.add("keys " + text);
			typed(text);
			return true;
		}

		@Override
		public void paste(String text) {
			log.add("paste " + text);
			typed(text);
		}

		private void typed(String text) {
			FakeNode f = focusedField();
			if (f != null) f.text = (f.text == null ? "" : f.text) + text;
			changed();
		}
	};

	@Override
	public Screen screen() {
		return (crop, maxEdge, format, quality) -> {
			if (secure != null) return new Shot(new byte[0], 0, 0, secure);
			Rect r = crop == null ? new Rect(0, 0, width, height) : crop;
			int w = r.width();
			int h = r.height();
			if (maxEdge > 0 && Math.max(w, h) > maxEdge) {
				double f = (double) maxEdge / Math.max(w, h);
				w = Math.max(1, (int) Math.round(w * f));
				h = Math.max(1, (int) Math.round(h * f));
			}
			return new Shot(encode(w, h, format, quality), w, h, null);
		};
	}

	/** A frame of the scene: its windows' first letters as shades, so a change of page changes the bytes. */
	private byte[] encode(int w, int h, String format, int quality) {
		BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
		Graphics2D g = image.createGraphics();
		int shade;
		synchronized (this) {
			shade = windows.isEmpty() ? 0 : (windows.get(0).id * 37) % 200;
		}
		g.setColor(new Color(shade, 120, 200 - shade));
		g.fillRect(0, 0, w, h);
		g.dispose();
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		try {
			if (format.equals("png")) {
				ImageIO.write(image, "png", out);
			} else {
				ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
				ImageWriteParam param = writer.getDefaultWriteParam();
				param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
				param.setCompressionQuality(quality / 100f);
				writer.setOutput(ImageIO.createImageOutputStream(out));
				writer.write(null, new IIOImage(image, null, null), param);
				writer.dispose();
			}
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
		return out.toByteArray();
	}

	@Override
	public Apps apps() {
		return new Apps() {
			@Override
			public List<App> list() {
				return apps;
			}

			@Override
			public String foreground() {
				synchronized (FakeDevice.this) {
					return windows.isEmpty() ? null : windows.get(0).root.pkg;
				}
			}

			@Override
			public void launch(String id, String url) {
				log.add("launch " + id + (url == null ? "" : " " + url));
				if (apps.stream().noneMatch(a -> a.id.equals(id))) throw RpcError.notFound("no app " + id + " is installed on this phone");
				if (id.equals(SETTINGS)) settings();
				else changed();
			}

			@Override
			public void terminate(String id) {
				log.add("terminate " + id);
			}
		};
	}

	@Override
	public Clock clock() {
		return clock;
	}

	private final Clock clock = new Clock() {
		@Override
		public long now() {
			if (!virtual) return System.nanoTime() / 1_000_000;
			synchronized (FakeDevice.this) {
				return now;
			}
		}

		@Override
		public void sleep(long ms) throws InterruptedException {
			if (!virtual) {
				if (ms > 0) Thread.sleep(ms);
				return;
			}
			if (Thread.interrupted()) throw new InterruptedException();
			synchronized (FakeDevice.this) {
				now += Math.max(ms, 0);
			}
		}
	};
}
