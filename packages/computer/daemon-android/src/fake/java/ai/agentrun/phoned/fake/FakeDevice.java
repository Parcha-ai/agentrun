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
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;

/**
 * A scripted phone for the JVM: a launcher; Settings, whose list scrolls, whose "Network & internet" row opens the
 * Internet page and whose search entry opens a search field; and the ui fixture (the conformance suite's
 * ui-fixture.ts, as its Android app shows it). phoned's core runs over it in the unit tests, and FakeMain serves it on
 * stdio for the TypeScript side, the conformance suite and the live probe's dry run. Its clock is virtual in tests (a
 * sleep moves it on at once) and real under FakeMain; an app's delayed effects happen when the clock reaches them.
 */
public final class FakeDevice implements Device {
	public static final String SETTINGS = "com.android.settings";
	public static final String LAUNCHER = "com.google.android.apps.nexuslauncher";
	public static final String CHROME = "com.android.chrome";
	/** The ui fixture's app id, as the conformance suite names it (src/conformance/ui-fixture.ts). */
	public static final String FIXTURE = "ai.agentrun.ui-fixture";
	/** The fixture's window, in points (ui-fixture.ts size), and its delays (SAVED_MS, NEXT_MS, NEXT_ANIMATE_MS). */
	public static final int FIXTURE_WIDTH = 480;
	public static final int FIXTURE_HEIGHT = 320;
	public static final long SAVED_MS = 300;
	public static final long NEXT_MS = 200;
	public static final long NEXT_ANIMATE_MS = 300;

	static final int HOME_WINDOW = 1;
	static final int SETTINGS_WINDOW = 10;
	static final int INTERNET_WINDOW = 11;
	static final int SEARCH_WINDOW = 12;
	static final int CHROME_WINDOW = 20;
	static final int FIXTURE_WINDOW = 30;
	static final int SECOND_WINDOW = 31;

	/** Settings' rows, top to bottom: the list shows the first ten or so, and scrolls to the rest. */
	private static final String[][] ROWS = {
		{"Network & internet", "Mobile, Wi-Fi, hotspot"}, {"Connected devices", "Bluetooth, pairing"},
		{"Apps", "Assistant, recent apps, default apps"}, {"Notifications", "Notification history, conversations"},
		{"Battery", "100%"}, {"Storage", "34% used"}, {"Sound & vibration", "Volume, haptics, Do Not Disturb"},
		{"Display", "Dark theme, font size, brightness"}, {"Wallpaper & style", "Colors, themed icons"},
		{"Accessibility", "Display, interaction, audio"}, {"Security & privacy", "App security, device lock"},
		{"Location", "On"}, {"Safety & emergency", "Emergency SOS, medical info"},
		{"Passwords & accounts", "Saved passwords, autofill"}, {"System", "Languages, gestures, time, backup"},
	};
	private static final int ROW_HEIGHT = 200;
	private static final int LIST_TOP = 300;

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
	/** The windows on the screen, the one in front first. */
	public final List<FakeWindow> windows = new ArrayList<>();
	public final List<App> apps = new ArrayList<>();
	public final boolean virtual;
	private long now;
	/** What an app does later, by when: run as the clock reaches it. */
	private final List<Later> later = new ArrayList<>();

	public FakeNode list;
	public FakeNode network;
	public FakeNode wifi;
	public FakeNode search;
	/** The fixture's canvas: its state counts the taps that reached it. */
	public FakeNode canvas;

	public FakeDevice(boolean virtualClock) {
		this.virtual = virtualClock;
		features.put("ui.tree", Boolean.TRUE);
		features.put("input.inject", Boolean.TRUE);
		features.put("input.clipboard", Boolean.TRUE);
		apps.add(new App(SETTINGS, "Settings", "15"));
		apps.add(new App(CHROME, "Chrome", "130.0"));
		apps.add(new App(FIXTURE, "UI fixture", "1"));
		settings();
	}

	private static final class Later {
		final long at;
		final Runnable run;

		Later(long at, Runnable run) {
			this.at = at;
			this.run = run;
		}
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

	/** Runs what is due by now, in order. */
	private synchronized void due() {
		long t = clock.now();
		for (;;) {
			Later next = null;
			for (Later l : later) if (l.at <= t && (next == null || l.at < next.at)) next = l;
			if (next == null) return;
			later.remove(next);
			next.run.run();
		}
	}

	private synchronized void after(long ms, Runnable run) {
		later.add(new Later(clock.now() + ms, run));
	}

	/** One window in front, the rest gone: an app's page replaces the one before it. */
	private synchronized void show(int id, String title, Rect bounds, FakeNode root, String pkg) {
		for (FakeWindow w : windows) w.root.gone();
		windows.clear();
		later.clear();
		root.pkg(pkg);
		windows.add(new FakeWindow(id, title, bounds, root));
		changed();
	}

	private synchronized String front() {
		return windows.isEmpty() ? null : windows.get(0).root.pkg;
	}

	private synchronized int frontWindow() {
		return windows.isEmpty() ? -1 : windows.get(0).id;
	}

	private static FakeNode text(String words, int left, int top, int right, int bottom) {
		return FakeNode.of("android.widget.TextView").at(left, top, right, bottom).text(words);
	}

	/** The home screen: the launcher's icons, each opening its app. */
	public synchronized void home() {
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, width, height);
		root.add(icon("Settings", SETTINGS, 120), icon("Chrome", CHROME, 400));
		show(HOME_WINDOW, "Home", new Rect(0, 0, width, height), root, LAUNCHER);
	}

	private FakeNode icon(String name, String app, int left) {
		FakeNode icon = FakeNode.of("android.widget.TextView").at(left, 1900, left + 220, 2160).text(name).tappable();
		icon.on(a -> {
			if (a.equals("ACTION_CLICK")) open(app);
		});
		return icon;
	}

	private static FakeNode row(String title, String summary, int top, Runnable click) {
		FakeNode row = FakeNode.of("android.widget.LinearLayout").at(0, top, 1080, top + ROW_HEIGHT).tappable();
		row.on(a -> {
			if (a.equals("ACTION_CLICK")) click.run();
		});
		FakeNode words = FakeNode.of("android.widget.RelativeLayout").at(160, top + 30, 900, top + 170);
		words.add(text(title, 160, top + 30, 900, top + 100).id("android:id/title"));
		if (summary != null) words.add(text(summary, 160, top + 100, 900, top + 170).id("android:id/summary"));
		row.add(FakeNode.of("android.widget.ImageView").at(40, top + 60, 120, top + 140), words);
		return row;
	}

	/** Settings' first page, in front, its list at the top. */
	public synchronized void settings() {
		list = FakeNode.of("androidx.recyclerview.widget.RecyclerView").at(0, LIST_TOP, 1080, height).id("com.android.settings:id/recycler_view");
		list.scrollable = true;
		list.on(a -> {
			if (a.equals("ACTION_SCROLL_FORWARD")) scrollList(height * 6 / 10);
			else if (a.equals("ACTION_SCROLL_BACKWARD")) scrollList(-height * 6 / 10);
		});
		search = text("Search settings", 40, 160, 1040, 280).id("com.android.settings:id/search_action_bar").tappable();
		search.on(a -> {
			if (a.equals("ACTION_CLICK")) searchPage();
		});
		for (int i = 0; i < ROWS.length; i++) {
			FakeNode row = row(ROWS[i][0], ROWS[i][1], LIST_TOP + i * ROW_HEIGHT, i == 0 ? this::internet : () -> {});
			if (i == 0) network = row;
			list.add(row);
		}
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, height);
		root.add(FakeNode.of("android.widget.LinearLayout").at(0, 0, 1080, 0), search, list);
		show(SETTINGS_WINDOW, "Settings", new Rect(0, 0, 1080, height), root, SETTINGS);
		clip(list, list.bounds);
	}

	/** Moves the list's rows up by dy pixels (down when below 0), as far as they go; true when they moved. */
	private synchronized boolean scrollList(int dy) {
		if (list == null || !list.alive || list.children.isEmpty()) return false;
		int top = list.children.get(0).bounds.top;
		int bottom = list.children.get(list.children.size() - 1).bounds.bottom;
		int most = Math.max(0, bottom - list.bounds.bottom);
		int scrolled = list.bounds.top - top;
		int to = Math.max(0, Math.min(most, scrolled + dy));
		if (to == scrolled) return false;
		for (FakeNode row : list.children) shift(row, scrolled - to);
		clip(list, list.bounds);
		changed();
		return true;
	}

	private static void shift(FakeNode n, int dy) {
		n.bounds = new Rect(n.bounds.left, n.bounds.top + dy, n.bounds.right, n.bounds.bottom + dy);
		for (FakeNode c : n.children) shift(c, dy);
	}

	/** Under a list, what shows inside it is visible to the user, and what scrolled out is not. */
	private static void clip(FakeNode n, Rect area) {
		for (FakeNode c : n.children) {
			c.visible = c.bounds.top < area.bottom && c.bounds.bottom > area.top;
			clip(c, area);
		}
	}

	/** The Internet page: a Wi-Fi row with its own switch, and a text field. */
	public synchronized void internet() {
		wifi = FakeNode.of("android.widget.Switch").at(900, 360, 1040, 440).id("android:id/switch_widget");
		wifi.checkable = true;
		wifi.clickable = true;
		wifi.checked = true;
		FakeNode row = FakeNode.of("android.widget.LinearLayout").at(0, 300, 1080, 500).tappable();
		row.add(text("Wi-Fi", 160, 330, 800, 400), text("Home network", 160, 400, 800, 470), wifi);
		FakeNode field = FakeNode.of("android.widget.EditText").at(40, 600, 1040, 720).id("com.android.settings:id/name");
		field.editable = true;
		field.hint = "Network name";
		FakeNode secret = FakeNode.of("android.widget.EditText").at(40, 760, 1040, 880).id("com.android.settings:id/password");
		secret.editable = true;
		secret.password = true;
		secret.text = "hunter2";
		secret.hint = "Password";
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, height);
		// Its title is the row's that opened it, as a live Settings page's toolbar says it.
		root.add(text("Network & internet", 40, 20, 1040, 110), text("Internet", 40, 120, 1040, 240), row, field, secret);
		show(INTERNET_WINDOW, "Internet", new Rect(0, 0, 1080, height), root, SETTINGS);
	}

	/** Settings' search: a SearchView whose field has the focus, so what is typed goes into it. */
	public synchronized void searchPage() {
		FakeNode field = FakeNode.of("android.widget.AutoCompleteTextView").at(160, 160, 1000, 280).id("com.android.settings:id/search_src_text");
		field.editable = true;
		field.focused = true;
		field.hint = "Search settings";
		FakeNode view = FakeNode.of("android.widget.SearchView").at(40, 160, 1040, 280).id("com.android.settings:id/search_view");
		view.add(field);
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, height);
		root.add(view);
		show(SEARCH_WINDOW, "Search", new Rect(0, 0, 1080, height), root, SETTINGS);
	}

	/** Chrome's window: a page with its address. */
	public synchronized void chrome(String url) {
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, height);
		FakeNode bar = FakeNode.of("android.widget.EditText").at(40, 120, 1040, 240).id("com.android.chrome:id/url_bar");
		bar.editable = true;
		bar.text = url == null ? "" : url;
		root.add(bar);
		show(CHROME_WINDOW, "Chrome", new Rect(0, 0, 1080, height), root, CHROME);
	}

	// --- the ui fixture -------------------------------------------------------------------------------------------

	/** The fixture's window on the screen, in pixels: a dialog of FIXTURE_WIDTH by FIXTURE_HEIGHT points, centred. */
	private Rect fixtureBounds() {
		int w = (int) Math.round(FIXTURE_WIDTH * scale);
		int h = (int) Math.round(FIXTURE_HEIGHT * scale);
		int left = (width - w) / 2;
		int top = (height - h) / 2;
		return new Rect(left, top, left + w, top + h);
	}

	/** An element of the fixture at window points (x, y, w, h), as screen pixels. */
	private FakeNode at(FakeNode n, int x, int y, int w, int h) {
		Rect b = fixtureBounds();
		return n.at(b.left + (int) Math.round(x * scale), b.top + (int) Math.round(y * scale), b.left + (int) Math.round((x + w) * scale), b.top + (int) Math.round((y + h) * scale));
	}

	private static String fixtureId(String id) {
		return FIXTURE + ":id/" + id;
	}

	private FakeNode button(String words, String id, int x, int y, Runnable click) {
		FakeNode b = at(FakeNode.of("android.widget.Button"), x, y, 80, 28).text(words).id(fixtureId(id)).tappable();
		b.on(a -> {
			if (a.equals("ACTION_CLICK")) click.run();
		});
		return b;
	}

	private FakeNode heading(String words) {
		FakeNode h = at(FakeNode.of("android.widget.TextView"), 16, 16, 300, 24).text(words);
		h.heading = true;
		return h;
	}

	/**
	 * The fixture's home window: a heading, the Name field, the Wi-Fi switch (a row the app marks a Switch, its two texts
	 * its name and its secondary text), Save, Next, and the Canvas, which no accessibility action reaches: its state is
	 * the number of taps that reached it.
	 */
	public synchronized void fixture() {
		FakeNode name = at(FakeNode.of("android.widget.EditText"), 16, 56, 200, 28).id(fixtureId("name"));
		name.editable = true;
		name.hint = "Name";
		FakeNode wifiRow = at(FakeNode.of("android.widget.Switch"), 16, 96, 60, 28).id(fixtureId("wifi")).tappable();
		wifiRow.checkable = true;
		wifiRow.add(at(text("Wi-Fi", 0, 0, 0, 0), 16, 96, 60, 14), at(text("Networks nearby", 0, 0, 0, 0), 16, 110, 60, 14));
		FakeNode root = at(FakeNode.of("android.widget.FrameLayout"), 0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT);
		FakeNode save = button("Save", "save", 16, 136, () -> after(SAVED_MS, this::saved));
		FakeNode next = button("Next", "next", 112, 136, () -> after(NEXT_MS, this::second));
		canvas = at(FakeNode.of("android.widget.ImageView"), 16, 180, 200, 100).desc("Canvas").id(fixtureId("canvas"));
		canvas.state = "0";
		canvas.counts = true;
		root.add(heading("UI fixture"), name, wifiRow, save, next, canvas);
		show(FIXTURE_WINDOW, "UI fixture", fixtureBounds(), root, FIXTURE);
	}

	/** Save's effect: the text Saved beside it, on the same window. */
	private synchronized void saved() {
		if (frontWindow() != FIXTURE_WINDOW) return;
		FakeNode note = at(text("Saved", 0, 0, 0, 0), 208, 136, 80, 28);
		note.pkg = FIXTURE;
		windows.get(0).root.add(note);
		changed();
	}

	/** Next's effect: the second page, drawn through a transition of NEXT_ANIMATE_MS (frames, nothing else). */
	private synchronized void second() {
		FakeNode root = at(FakeNode.of("android.widget.FrameLayout"), 0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT);
		root.add(heading("Second page"), button("Back", "back", 16, 56, this::fixture));
		show(SECOND_WINDOW, "Second page", fixtureBounds(), root, FIXTURE);
		for (long t = 50; t <= NEXT_ANIMATE_MS; t += 50) after(t, this::changed);
	}

	// --- navigation -----------------------------------------------------------------------------------------------

	/** An app's first window, in front, fresh. */
	private synchronized void open(String app) {
		if (app.equals(SETTINGS)) settings();
		else if (app.equals(FIXTURE)) fixture();
		else if (app.equals(CHROME)) chrome(null);
		else changed();
	}

	/** Back: a page returns to the one that opened it, and an app's first page to the home screen. */
	synchronized void back() {
		switch (frontWindow()) {
			case INTERNET_WINDOW:
			case SEARCH_WINDOW:
				settings();
				break;
			case SECOND_WINDOW:
				fixture();
				break;
			case HOME_WINDOW:
				changed();
				break;
			default:
				home();
		}
	}

	/** A tap at a pixel: the deepest live, visible element there that takes one, as the app would take it. */
	synchronized void tap(int x, int y) {
		for (FakeWindow w : new ArrayList<>(windows)) {
			FakeNode hit = deepest(w.root, x, y);
			if (hit == null) continue;
			if (hit.counts) {
				hit.state = String.valueOf(Integer.parseInt(hit.state == null ? "0" : hit.state) + 1);
				changed();
			} else if (hit.editable) {
				unfocus(w.root);
				hit.focused = true;
				changed();
			} else {
				hit.perform("ACTION_CLICK", null);
			}
			return;
		}
	}

	private static void unfocus(FakeNode n) {
		n.focused = false;
		for (FakeNode c : n.children) unfocus(c);
	}

	private static FakeNode deepest(FakeNode n, int x, int y) {
		if (n == null || !n.alive || !n.visible || !n.bounds.contains(x, y)) return null;
		for (int i = n.children.size() - 1; i >= 0; i--) {
			FakeNode hit = deepest(n.children.get(i), x, y);
			if (hit != null) return hit;
		}
		return n.clickable || n.counts || n.editable ? n : null;
	}

	/** A finger's path: one that starts in Settings' list and moves up or down scrolls it by as much. */
	private synchronized void swipe(int[][] points) {
		int[] from = points[0];
		int[] to = points[points.length - 1];
		if (list != null && list.alive && frontWindow() == SETTINGS_WINDOW && list.bounds.contains(from[0], from[1]) && scrollList(from[1] - to[1])) return;
		changed();
	}

	private synchronized FakeNode focusedField() {
		for (FakeWindow w : windows) {
			FakeNode f = focused(w.root);
			if (f != null) return f;
		}
		return null;
	}

	private static FakeNode focused(FakeNode n) {
		if (n.editable && n.focused && n.alive) return n;
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
				due();
				return new ArrayList<>(windows);
			}
		}

		@Override
		public long events() {
			synchronized (FakeDevice.this) {
				due();
				return events;
			}
		}

		@Override
		public int framesSince(int windowId) {
			synchronized (FakeDevice.this) {
				due();
				Integer n = frames.remove(windowId);
				return n == null ? 0 : n;
			}
		}

		@Override
		public boolean global(String nav) {
			log.add("global " + nav);
			if (nav.equals("back")) back();
			else if (nav.equals("home")) home();
			else changed();
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
			else swipe(points);
		}

		@Override
		public void pinch(int[][] from, int[][] to, long ms) {
			log.add("pinch " + from[0][0] + "," + from[0][1] + "+" + from[1][0] + "," + from[1][1] + " to " + to[0][0] + "," + to[0][1] + "+" + to[1][0] + "," + to[1][1] + " " + ms + "ms");
		}

		@Override
		public void key(int keyCode, int meta) {
			log.add("key " + keyCode + "/" + meta);
			if (keyCode == 4) back();
			else if (keyCode == 3) home();
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
			synchronized (FakeDevice.this) {
				FakeNode f = focusedField();
				if (f != null) f.text = (f.text == null ? "" : f.text) + text;
				changed();
			}
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

	/** A frame of the scene: the front window's id as a shade, so a change of page changes the bytes. */
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
					due();
					return front();
				}
			}

			@Override
			public void launch(String id, String url) {
				log.add("launch " + id + (url == null ? "" : " " + url));
				if (apps.stream().noneMatch(a -> a.id.equals(id))) throw RpcError.notFound("no app " + id + " is installed on this phone");
				if (id.equals(CHROME)) chrome(url);
				else open(id);
			}

			@Override
			public void terminate(String id) {
				log.add("terminate " + id);
				synchronized (FakeDevice.this) {
					// Its windows go, and with them what it was about to do: the home screen shows where it was.
					for (Iterator<FakeWindow> it = windows.iterator(); it.hasNext();) {
						FakeWindow w = it.next();
						if (!id.equals(w.root.pkg)) continue;
						w.root.gone();
						it.remove();
					}
					if (windows.isEmpty()) home();
				}
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
