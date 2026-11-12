package ai.agentrun.phoned;

import ai.agentrun.phoned.device.AxNode;
import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.device.Rect;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The ui group: ui.observe and ui.act, under the rules every driver keeps (spec/computer/wire.md, "The ui group"; the
 * TypeScript UiEngine keeps the same ones). A ref stays good while its element exists: the driver keeps the AxNode
 * behind each ref, the same element gets the same ref in every later observe, and a step naming a ref whose element is
 * gone is refused as stale. A point is bound to the state it was read from. Every act settles before it answers, and
 * an expect is polled here, on the phone. Coordinates are window points, origin at the window's top left.
 *
 * On a phone a step runs by one of two routes: semantic, an accessibility action on the element (it moves nothing the
 * user holds), or foreground, the phone's own input injected at the element (only when the call passes foreground).
 */
public final class UiDriver {
	/** protocol.ts UI_STATES_KEPT, MAX_STEPS, MAX_BATCH_WAIT_MS, DEFAULT_EXPECT_MS, MAX_EXPECT_MS, MAX_SETTLE_MS. */
	static final int KEPT_STATES = 32;
	static final int MAX_STEPS = 100;
	static final long MAX_DRAG_MS = 300_000;
	static final long DEFAULT_EXPECT_MS = 5_000;
	static final long MAX_EXPECT_MS = 60_000;
	static final long MAX_SETTLE_MS = 3_000;
	/** How often an expect looks again. */
	static final long EXPECT_POLL_MS = 100;
	/** A ref not seen in this many observes is let go, so a long session holds a bounded set of elements. */
	static final int REF_LIFETIME = 64;
	/** Room a reply keeps for everything but its nodes and image. */
	static final int REPLY_ROOM = 16 * 1024;
	/** How long a drag takes when it names no ms, and a scroll's swipe at least. */
	static final long DRAG_MS = 300;
	/** How long a call waits for the window of a named app that is in front (see start). */
	static final long APP_WINDOW_MS = 3_000;
	/** How often it looks for that window. */
	static final long APP_WINDOW_POLL_MS = 50;
	/** The windows a not_found names, at most. */
	static final int WINDOWS_NAMED = 6;

	private final Device device;
	private final Shots shots;
	private final Supplier<Map<String, Object>> features;
	/** One look or act at a time, shared with input.actions: two would interleave their input on the phone. */
	final Object hands;

	private final Map<Object, String> refOfKey = new HashMap<>();
	private final Map<String, AxNode> nodeOfRef = new HashMap<>();
	private final Map<String, Integer> seenAt = new HashMap<>();
	private final LinkedHashMap<String, State> states = new LinkedHashMap<>();
	private int nextRef = 1;
	private int nextState = 1;

	public UiDriver(Device device, Shots shots, Supplier<Map<String, Object>> features, Object hands) {
		this.device = device;
		this.shots = shots;
		this.features = features;
		this.hands = hands;
	}

	/** One observation, kept for since and for points. */
	static final class State {
		String id;
		int number;
		String app;
		int windowId;
		Rect windowBounds;
		/** ref to signature, in walk order. */
		final Map<String, String> signatures = new LinkedHashMap<>();
		List<Outline.Hit> hits;
	}

	/** Which app and window a call means; neither: the app in front. */
	static final class Target {
		String app;
		String window;
	}

	/** One look at the target's window. */
	final class Look {
		final Device.AxWindow window;
		final Rect bounds;
		final AxNode root;
		final String app;
		final Outline.Frame frame;
		final Outline outline;

		Look(Device.AxWindow window, boolean full) {
			this.window = window;
			this.bounds = window.bounds();
			this.root = window.root();
			String pkg = root == null ? null : root.packageName();
			this.app = pkg == null ? "" : pkg;
			this.frame = new Outline.Frame(bounds.left, bounds.top, device.display().scale);
			this.outline = Outline.of(root, full);
		}

		/** What a person would see of it: the window, its size, and its elements. */
		String fingerprint() {
			StringBuilder s = new StringBuilder();
			s.append(window.id()).append('|').append(bounds.width()).append('x').append(bounds.height()).append('\n');
			for (Outline.Entry e : outline.entries) s.append(e.key).append('=').append(e.signature()).append('\n');
			return s.toString();
		}
	}

	// --- ui.observe ------------------------------------------------------------------------------------------------

	public Map<String, Object> observe(Params p, Wire.Cancel cancel) throws InterruptedException {
		p.only("target", "full", "image", "since");
		Target target = target(p);
		boolean full = p.bool("full", false);
		String since = p.str("since", null);
		int maxEdge = imageEdge(p);
		// The window's image comes from the window's bounds the tree gives, so here the tree off is the image off too:
		// observe has nothing to answer (wire.md: refused denied with both reasons).
		String treeOff = off("ui.tree");
		String imageOff = off("ui.image");
		if (treeOff != null && imageOff != null) throw RpcError.denied("ui.observe: " + treeOff + "; " + imageOff);
		if (maxEdge > 0 && imageOff != null) throw RpcError.unsupported("ui.observe: " + imageOff);
		synchronized (hands) {
			cancel.check();
			Device.Accessibility a11y = device.accessibility();
			Look look = new Look(start(a11y, target, cancel), full);
			Map<String, Object> image = maxEdge > 0 ? shots.image(look.bounds, maxEdge) : null;
			cancel.check();
			State before = since == null ? null : states.get(since);
			State state = record(look);
			List<Object> nodes = new ArrayList<>(look.outline.entries.size());
			for (Outline.Entry e : look.outline.entries) nodes.add(e.json(look.frame));
			boolean truncated = look.outline.truncated;
			// The reply stays within the line limit: the image is whole, so nodes give way.
			int room = Wire.MAX_LINE_BYTES - REPLY_ROOM - (image == null ? 0 : ((String) image.get("data")).length());
			while (!nodes.isEmpty() && Json.write(nodes).getBytes(StandardCharsets.UTF_8).length > room) {
				nodes = new ArrayList<>(nodes.subList(0, nodes.size() * 9 / 10));
				truncated = true;
			}
			Outline.Frame screen = new Outline.Frame(0, 0, look.frame.scale);
			String title = look.window.title();
			boolean titled = title != null && !title.isEmpty();
			return Json.obj(
					"state", state.id,
					"app", Json.obj("id", look.app, "name", titled ? title : look.app),
					"window", Json.obj("id", String.valueOf(look.window.id()), "title", titled ? title : Json.OMIT, "bounds", screen.points(look.bounds)),
					"nodes", nodes,
					"diff", before == null ? Json.OMIT : diff(before, state),
					"image", image == null ? Json.OMIT : image,
					"truncated", truncated);
		}
	}

	/** image: true (DEFAULT_EDGE), { maxEdge }, or false/absent (0: none). */
	private static int imageEdge(Params p) {
		Object image = p.raw("image");
		if (image == null || Boolean.FALSE.equals(image)) return 0;
		if (Boolean.TRUE.equals(image)) return Shots.DEFAULT_EDGE;
		if (!(image instanceof Map)) throw RpcError.invalid("ui.observe: image is true, false or { maxEdge }");
		Params edge = Params.of(image, "params.image");
		edge.only("maxEdge");
		Object v = edge.raw("maxEdge");
		if (!(v instanceof Long)) throw RpcError.invalid("ui.observe: image is true, false or { maxEdge }");
		long n = (Long) v;
		if (n < Shots.MIN_EDGE || n > Shots.MAX_EDGE) throw RpcError.limit("ui.observe: image.maxEdge " + n + " is outside " + Shots.MIN_EDGE + " to " + Shots.MAX_EDGE + " pixels");
		return (int) n;
	}

	/** Why a feature is off, in words, or null when it is on. */
	private String off(String name) {
		Object v = features.get().get(name);
		if (Boolean.TRUE.equals(v)) return null;
		return v == null ? "this phone does not offer " + name : name + " is off here: " + v;
	}

	private static Target target(Params p) {
		Target t = new Target();
		if (!p.has("target")) return t;
		Params target = p.obj("target");
		target.only("app", "window");
		t.app = target.str("app", null);
		t.window = target.str("window", null);
		return t;
	}

	/** The window a call means: the one named, the app's top one, or the app window in front. */
	Device.AxWindow window(Device.Accessibility a11y, Target target) {
		List<Device.AxWindow> windows = a11y.windows();
		if (target.window != null) {
			for (Device.AxWindow w : windows) {
				if (!String.valueOf(w.id()).equals(target.window)) continue;
				if (target.app != null && !target.app.equals(appOf(w))) throw RpcError.notFound("window " + target.window + " is not " + target.app + "'s: observe again for its windows");
				return w;
			}
			throw RpcError.notFound("window " + target.window + " is not on the screen: observe again for the windows there");
		}
		if (target.app != null) {
			for (Device.AxWindow w : windows) if (target.app.equals(appOf(w))) return w;
			throw RpcError.notFound(target.app + " has no window on the screen (" + shown(windows) + "): open it with apps.launch first");
		}
		for (Device.AxWindow w : windows) if ("application".equals(w.type()) && w.active()) return w;
		for (Device.AxWindow w : windows) if ("application".equals(w.type()) && w.focused()) return w;
		for (Device.AxWindow w : windows) if ("application".equals(w.type())) return w;
		for (Device.AxWindow w : windows) if (w.active()) return w;
		if (!windows.isEmpty()) return windows.get(0);
		throw RpcError.unsupported("the phone shows no window its accessibility tree can read (is the screen off or locked?)");
	}

	/**
	 * The window a look or an act starts from. On a phone an app's task is in front a few hundred ms before its window
	 * reaches the accessibility tree, so apps.list can already name an app that ui.observe finds no window of. A named
	 * app that is in front is waited for, up to APP_WINDOW_MS; one that is not is not_found at once.
	 */
	Device.AxWindow start(Device.Accessibility a11y, Target target, Wire.Cancel cancel) throws InterruptedException {
		try {
			return window(a11y, target);
		} catch (RpcError e) {
			if (!"not_found".equals(e.kind) || target.app == null || target.window != null || !inFront(target.app)) throw e;
		}
		Device.Clock clock = device.clock();
		long begun = clock.now();
		for (;;) {
			cancel.check();
			clock.sleep(APP_WINDOW_POLL_MS);
			List<Device.AxWindow> windows = a11y.windows();
			for (Device.AxWindow w : windows) if (target.app.equals(appOf(w))) return w;
			if (clock.now() - begun >= APP_WINDOW_MS) {
				throw RpcError.notFound(target.app + " is in front, but its window did not reach the accessibility tree within "
						+ APP_WINDOW_MS + " ms (" + shown(windows) + ")");
			}
		}
	}

	private boolean inFront(String app) {
		try {
			return app.equals(device.apps().foreground());
		} catch (RuntimeException e) {
			return false;
		}
	}

	/** The windows the tree shows, for a not_found: the accessibility tree shows window 3 application "Home" of com.x. */
	private static String shown(List<Device.AxWindow> windows) {
		if (windows.isEmpty()) return "the accessibility tree shows no window";
		StringBuilder s = new StringBuilder("the accessibility tree shows ");
		for (int i = 0; i < windows.size() && i < WINDOWS_NAMED; i++) {
			Device.AxWindow w = windows.get(i);
			if (i > 0) s.append("; ");
			String title = w.title();
			s.append("window ").append(w.id()).append(' ').append(w.type());
			if (title != null && !title.isEmpty()) s.append(" \"").append(title.length() > 40 ? title.substring(0, 40) + "..." : title).append('"');
			String app = appOf(w);
			s.append(app == null ? " with no root" : " of " + app);
		}
		if (windows.size() > WINDOWS_NAMED) s.append("; and ").append(windows.size() - WINDOWS_NAMED).append(" more");
		return s.toString();
	}

	/**
	 * The window to read once steps ran: the target's, else (it closed, or the steps left its app) the app's, else the
	 * one in front. Steps may close what they acted on, and the act still answers what the phone shows.
	 */
	Device.AxWindow after(Device.Accessibility a11y, Target target) {
		try {
			return window(a11y, target);
		} catch (RpcError e) {
			if (!"not_found".equals(e.kind)) throw e;
		}
		if (target.window != null && target.app != null) {
			Target app = new Target();
			app.app = target.app;
			try {
				return window(a11y, app);
			} catch (RpcError e) {
				if (!"not_found".equals(e.kind)) throw e;
			}
		}
		return window(a11y, new Target());
	}

	private static String appOf(Device.AxWindow w) {
		AxNode root = w.root();
		return root == null ? null : root.packageName();
	}

	/** Gives the look's entries their refs (the same element keeps its ref), and keeps the state. */
	private State record(Look look) {
		State state = new State();
		state.number = nextState++;
		state.id = "s" + state.number;
		state.app = look.app;
		state.windowId = look.window.id();
		state.windowBounds = look.bounds;
		for (Outline.Entry e : look.outline.entries) {
			String ref = refOf(e.key, e.node);
			e.ref = ref;
			seenAt.put(ref, state.number);
			state.signatures.put(ref, e.signature());
		}
		state.hits = look.outline.hits;
		states.put(state.id, state);
		Iterator<String> old = states.keySet().iterator();
		while (states.size() > KEPT_STATES && old.hasNext()) {
			old.next();
			old.remove();
		}
		Iterator<Map.Entry<String, Integer>> seen = seenAt.entrySet().iterator();
		while (seen.hasNext()) {
			Map.Entry<String, Integer> s = seen.next();
			if (state.number - s.getValue() <= REF_LIFETIME) continue;
			AxNode gone = nodeOfRef.remove(s.getKey());
			if (gone != null) refOfKey.remove(gone.key());
			seen.remove();
		}
		return state;
	}

	private String refOf(Object key, AxNode node) {
		String ref = refOfKey.get(key);
		if (ref == null) {
			ref = "@e" + nextRef++;
			refOfKey.put(key, ref);
		}
		nodeOfRef.put(ref, node);
		return ref;
	}

	private static Map<String, Object> diff(State before, State now) {
		List<Object> added = new ArrayList<>();
		List<Object> removed = new ArrayList<>();
		List<Object> changed = new ArrayList<>();
		for (Map.Entry<String, String> e : now.signatures.entrySet()) {
			String was = before.signatures.get(e.getKey());
			if (was == null) added.add(e.getKey());
			else if (!was.equals(e.getValue())) changed.add(e.getKey());
		}
		for (String ref : before.signatures.keySet()) if (!now.signatures.containsKey(ref)) removed.add(ref);
		return Json.obj("added", added, "removed", removed, "changed", changed);
	}

	// --- ui.act ----------------------------------------------------------------------------------------------------

	/** One step, read and checked before any step runs. */
	static final class Step {
		String kind;
		String ref;
		long[] point;
		String text;
		String action;
		boolean right;
		int count = 1;
		long dx;
		long dy;
		long[][] path;
		long ms = DRAG_MS;
		int[][] keys;
		String nav;
	}

	static final class Expect {
		String text;
		String ref;
		boolean gone;
		long timeoutMs = DEFAULT_EXPECT_MS;
	}

	/** A step's refusal: it ends the steps, and the act still answers. */
	static final class Refused extends Exception {
		final String kind;

		Refused(String kind, String message) {
			super(message, null, false, false);
			this.kind = kind;
		}

		static Refused of(RpcError e) {
			return new Refused(e.kind, e.getMessage());
		}
	}

	private static final String[][] STEP_FIELDS = {
		{"press"}, {"set", "value"}, {"perform", "action"}, {"click", "button", "count"}, {"type", "into"}, {"key"},
		{"nav"}, {"scroll", "dx", "dy"}, {"drag", "ms"},
	};

	public Map<String, Object> act(Params p, Wire.Cancel cancel) throws InterruptedException {
		p.only("target", "state", "steps", "expect", "foreground");
		Target target = target(p);
		String stateId = p.str("state", null);
		boolean foreground = p.bool("foreground", false);
		List<Object> raw = p.list("steps");
		if (raw.size() > MAX_STEPS) throw RpcError.limit("ui.act: " + raw.size() + " steps, more than the " + MAX_STEPS + " one act holds");
		List<Step> steps = new ArrayList<>(raw.size());
		long dragMs = 0;
		for (int i = 0; i < raw.size(); i++) {
			Step s = step(raw.get(i), "steps[" + i + "]");
			if (s.kind.equals("drag")) dragMs += s.ms;
			if (s.point != null && stateId == null) throw RpcError.invalid("ui.act: steps[" + i + "] is at a point, and a point needs the state it was read from: pass state");
			steps.add(s);
		}
		if (dragMs > MAX_DRAG_MS) throw RpcError.limit("ui.act: the drags ask for " + dragMs + " ms, more than the " + MAX_DRAG_MS + " ms one act may");
		Expect expect = p.has("expect") ? expect(p.obj("expect")) : null;
		if (steps.isEmpty() && expect == null) throw RpcError.invalid("ui.act has no steps and no expect: nothing to do");
		Device.Clock clock = device.clock();
		synchronized (hands) {
			cancel.check();
			// A ref this connection never gave is the caller's mistake; one let go of is stale, like one whose element left.
			for (Step s : steps) knownRef(s.ref);
			if (expect != null) knownRef(expect.ref);
			State held = stateId == null ? null : states.get(stateId);
			// The state's app, not its window: an activity the steps open is a new window of the same app.
			if (target.app == null && target.window == null && held != null && !held.app.isEmpty()) target.app = held.app;
			Device.Accessibility a11y = device.accessibility();
			String first = new Look(start(a11y, target, cancel), false).fingerprint();
			List<Object> answers = new ArrayList<>(steps.size());
			boolean refused = false;
			for (Step s : steps) {
				cancel.check();
				try {
					answers.add(run(s, stateId, held, target, foreground, a11y, cancel));
				} catch (Refused r) {
					answers.add(Json.obj("error", Json.obj("kind", r.kind, "message", r.getMessage())));
					refused = true;
					break;
				}
			}
			Settle.quiet(a11y, clock, after(a11y, target).id(), MAX_SETTLE_MS, cancel);
			String met = null;
			if (expect != null && !refused) met = holdsWithin(expect, a11y, target, clock, cancel) ? "met" : "unmet";
			Look last = new Look(after(a11y, target), false);
			State now = record(last);
			return Json.obj("steps", answers, "state", now.id, "changed", !first.equals(last.fingerprint()), "expect", met == null ? Json.OMIT : met);
		}
	}

	private void knownRef(String ref) {
		if (ref == null) return;
		int n;
		try {
			n = ref.startsWith("@e") ? Integer.parseInt(ref.substring(2)) : -1;
		} catch (RuntimeException e) {
			n = -1;
		}
		if (n < 1 || n >= nextRef) throw RpcError.invalid("ui.act: " + ref + " is not a ref this connection was given: observe first");
	}

	private static Step step(Object raw, String at) {
		if (!(raw instanceof Map)) throw RpcError.invalid("ui.act: " + at + " is not a step object");
		Params p = Params.of(raw, at);
		Step s = new Step();
		String[] fields = null;
		int named = 0;
		for (String[] f : STEP_FIELDS) {
			if (!p.has(f[0])) continue;
			named++;
			s.kind = f[0];
			fields = f;
		}
		if (named != 1) throw RpcError.invalid("ui.act: " + at + " names " + (named == 0 ? "no step" : named + " steps") + ": a step is exactly one of press, set, perform, click, type, key, nav, scroll, drag");
		p.only(fields);
		switch (s.kind) {
			case "press":
				s.ref = ref(p, "press");
				break;
			case "set":
				s.ref = ref(p, "set");
				s.text = p.str("value");
				break;
			case "perform":
				s.ref = ref(p, "perform");
				s.action = p.str("action");
				break;
			case "click": {
				refOrPoint(p, "click", s);
				String button = p.str("button", "left");
				if (!button.equals("left") && !button.equals("right")) throw RpcError.invalid("ui.act: " + at + ".button is " + Json.write(button) + ": \"left\" or \"right\"");
				s.right = button.equals("right");
				s.count = (int) p.whole("count", 1, 1, 3);
				break;
			}
			case "type":
				s.text = p.str("type");
				if (p.has("into")) s.ref = ref(p, "into");
				break;
			case "key":
				s.text = p.str("key");
				s.keys = Keys.chord(s.text);
				break;
			case "nav":
				s.nav = p.str("nav");
				if (!s.nav.equals("back") && !s.nav.equals("home") && !s.nav.equals("app_switch")) throw RpcError.invalid("ui.act: " + at + ".nav is " + Json.write(s.nav) + ": \"back\", \"home\" or \"app_switch\"");
				break;
			case "scroll":
				refOrPoint(p, "scroll", s);
				s.dx = p.whole("dx", 0, -1_000_000, 1_000_000);
				s.dy = p.whole("dy", 0, -1_000_000, 1_000_000);
				break;
			case "drag": {
				List<Object> points = p.list("drag");
				if (points.size() < 2) throw RpcError.invalid("ui.act: " + at + ".drag is not 2 or more points [x, y] of whole window points");
				s.path = new long[points.size()][];
				for (int i = 0; i < points.size(); i++) s.path[i] = Params.wholePointOf(points.get(i), "ui.act: " + at + ".drag[" + i + "]");
				s.point = s.path[0];
				s.ms = p.whole("ms", DRAG_MS, 0, MAX_DRAG_MS);
				break;
			}
			default:
				break;
		}
		return s;
	}

	private static String ref(Params p, String name) {
		Object v = p.raw(name);
		if (!(v instanceof String) || ((String) v).length() < 2 || !((String) v).startsWith("@")) {
			throw RpcError.invalid("ui.act: " + p.where() + "." + name + " is " + Json.write(v) + ", not a ref (\"@e12\")");
		}
		return (String) v;
	}

	private static void refOrPoint(Params p, String name, Step s) {
		Object v = p.raw(name);
		if (v instanceof String) s.ref = ref(p, name);
		else s.point = Params.wholePointOf(v, "ui.act: " + p.where() + "." + name + " (a ref or a point)");
	}

	private static Expect expect(Params p) {
		p.only("text", "ref", "gone", "timeoutMs");
		Expect e = new Expect();
		e.text = p.str("text", null);
		e.ref = p.has("ref") ? ref(p, "ref") : null;
		e.gone = p.bool("gone", false);
		if (p.has("timeoutMs")) {
			long t = p.whole("timeoutMs", 0, Long.MAX_VALUE);
			if (t > MAX_EXPECT_MS) throw RpcError.limit("ui.act: expect.timeoutMs " + t + " is more than the " + MAX_EXPECT_MS + " ms an expect may wait");
			e.timeoutMs = t;
		}
		if (e.text == null && e.ref == null) throw RpcError.invalid("ui.act: expect names neither text nor ref: it needs at least one");
		return e;
	}

	/** Runs one step by the best route the call allows, or refuses it. */
	private Map<String, Object> run(Step s, String stateId, State held, Target target, boolean foreground, Device.Accessibility a11y, Wire.Cancel cancel) throws Refused, InterruptedException {
		Device.Clock clock = device.clock();
		try {
			Device.AxWindow window = window(a11y, target);
			Outline.Frame frame = new Outline.Frame(window.bounds().left, window.bounds().top, device.display().scale);
			AxNode node = s.ref == null ? null : resolve(s.ref);
			if (s.point != null) checkPoint(s.point, stateId, held, window, frame);
			Sign sign = new Sign(a11y, target, window, cancel);
			switch (s.kind) {
				case "press":
					if (has(node, "ACTION_CLICK") && node.perform("ACTION_CLICK", null)) return answer("semantic", sign.seen());
					foreground(foreground, "press " + s.ref + ": " + (has(node, "ACTION_CLICK") ? "the app refused its click action, and a tap" : "it has no click action, so a tap"));
					device.input().touch(new int[][] {center(node, s.ref)}, 0);
					return answer("foreground", sign.seen());
				case "set":
					return set(s, node, sign);
				case "perform":
					if (!node.perform(s.action, null)) throw new Refused("unsupported", "perform " + s.action + " on " + s.ref + ": the app refused it");
					return answer("semantic", sign.seen());
				case "click": {
					String action = s.right ? "ACTION_LONG_CLICK" : "ACTION_CLICK";
					if (!foreground && node != null && s.count == 1 && has(node, action) && node.perform(action, null)) return answer("semantic", sign.seen());
					foreground(foreground, "click " + (s.ref != null ? s.ref : "at a point") + ": a tap");
					int[] at = node != null ? center(node, s.ref) : onScreen(frame.pixels(s.point[0], s.point[1]));
					if (s.right) {
						device.input().touch(new int[][] {at, at}, 800);
					} else {
						for (int i = 0; i < s.count; i++) {
							if (i > 0) clock.sleep(60);
							device.input().touch(new int[][] {at}, 0);
						}
					}
					return answer("foreground", sign.seen());
				}
				case "type":
					return type(s, node, foreground, window, sign);
				case "key":
					foreground(foreground, "key " + s.text + ": a key press");
					Keys.press(device.input(), s.keys);
					return answer("foreground", sign.seen());
				case "nav": {
					String off = off("ui.nav");
					if (off != null) throw new Refused("unsupported", "nav " + s.nav + ": " + off);
					if (!a11y.global(s.nav)) throw new Refused("unsupported", "nav " + s.nav + ": the phone refused the global action");
					return answer("semantic", sign.seen());
				}
				case "scroll":
					return scroll(s, node, foreground, frame, window, sign);
				case "drag": {
					foreground(foreground, "drag: a touch");
					int[][] path = new int[s.path.length][];
					for (int i = 0; i < s.path.length; i++) path[i] = onScreen(frame.pixels(s.path[i][0], s.path[i][1]));
					device.input().touch(path, s.ms);
					return answer("foreground", sign.seen());
				}
				default:
					throw new Refused("invalid", "unknown step " + s.kind);
			}
		} catch (RpcError e) {
			if ("aborted".equals(e.kind)) throw e;
			throw Refused.of(e);
		}
	}

	private static Map<String, Object> answer(String route, boolean verified) {
		return Json.obj("route", route, "verified", verified);
	}

	/** Whether the element lists the action: one it lacks is never tried, so a missing one is not an error. */
	private static boolean has(AxNode node, String action) {
		return node.actions().contains(action);
	}

	/**
	 * Whether a step landed, by reading the window back: verified only when what a person would see of the target's
	 * window (its fingerprint) differs from before the step. An accessibility event or a new frame is only the cue to
	 * read again: a tap's ripple draws frames and changes nothing, so it never verifies a step.
	 */
	private final class Sign {
		private final Device.Accessibility a11y;
		private final Target target;
		private final int windowId;
		private final Wire.Cancel cancel;
		private final String before;
		private final long events;

		Sign(Device.Accessibility a11y, Target target, Device.AxWindow window, Wire.Cancel cancel) {
			this.a11y = a11y;
			this.target = target;
			this.windowId = window.id();
			this.cancel = cancel;
			this.before = new Look(window, false).fingerprint();
			this.events = a11y.events();
			a11y.framesSince(windowId);
		}

		/** Reads the window back until it differs, within SIGN_MS; reads again only on an event or a frame. */
		boolean seen() throws InterruptedException {
			Device.Clock clock = device.clock();
			long start = clock.now();
			long seen = events;
			boolean read = true;
			for (;;) {
				if (read && !before.equals(new Look(after(a11y, target), false).fingerprint())) return true;
				if (clock.now() - start >= Settle.SIGN_MS) return false;
				cancel.check();
				clock.sleep(Settle.POLL_MS);
				long now = a11y.events();
				read = now != seen || a11y.framesSince(windowId) > 0;
				seen = now;
			}
		}
	}

	/** Refuses a step that needs the foreground route when the call did not allow it. */
	private static void foreground(boolean allowed, String what) throws Refused {
		if (allowed) return;
		throw new Refused("denied", what + " is the phone's own input (the foreground route), which this call does not allow: pass foreground: true");
	}

	private Map<String, Object> set(Step s, AxNode node, Sign sign) throws Refused, InterruptedException {
		if (node.checkable()) {
			boolean on;
			if (s.text.equals("on") || s.text.equals("true")) on = true;
			else if (s.text.equals("off") || s.text.equals("false")) on = false;
			else throw new Refused("invalid", "set " + s.ref + ": a switch or checkbox is set to \"on\" or \"off\", not " + Json.write(s.text));
			if (node.checked() == on) return answer("semantic", true);
			if (!has(node, "ACTION_CLICK") || !node.perform("ACTION_CLICK", null)) throw new Refused("unsupported", "set " + s.ref + ": the app refused its click action");
			sign.seen();
			return answer("semantic", node.refresh() && node.checked() == on);
		}
		if (!node.editable()) throw new Refused("unsupported", "set " + s.ref + ": phoned sets text fields, switches and checkboxes; this element is none (press it, or type into a field)");
		if (!node.perform("ACTION_SET_TEXT", s.text)) throw new Refused("unsupported", "set " + s.ref + ": the app refused to set its text");
		return answer("semantic", readback(node, s.text, true));
	}

	private Map<String, Object> type(Step s, AxNode into, boolean foreground, Device.AxWindow window, Sign sign) throws Refused, InterruptedException {
		AxNode field = into != null ? into : focusedField(window.root(), 0);
		if (field != null && field.editable() && !field.password()) {
			// Semantic: the field's text with this text after it, set by the app's own action. It types at the end of the
			// field, not at the caret.
			String now = field.text() == null || field.text().equals(field.hint()) ? "" : field.text();
			if (field.perform("ACTION_SET_TEXT", now + s.text)) return answer("semantic", readback(field, now + s.text, true));
		}
		foreground(foreground, "type" + (into == null ? "" : " into " + s.ref) + (field == null ? " with no text field focused" : "") + ": the keyboard");
		if (into != null && !into.focused() && !into.perform("ACTION_FOCUS", null)) device.input().touch(new int[][] {center(into, s.ref)}, 0);
		Device.Input input = device.input();
		if (!(ascii(s.text) && input.typeKeys(s.text))) input.paste(s.text);
		if (field != null && field.editable() && !field.password()) return answer("foreground", readback(field, s.text, false));
		return answer("foreground", sign.seen());
	}

	/**
	 * Scrolls by (dx, dy) points: dy above 0 shows what is below. Without foreground, one accessibility scroll of the
	 * element (a page, whatever the amount). With it, swipes inside the element or the window, each holding still at
	 * its end so the list stops where the finger does.
	 */
	private Map<String, Object> scroll(Step s, AxNode node, boolean foreground, Outline.Frame frame, Device.AxWindow window, Sign sign) throws Refused, InterruptedException {
		Device.Clock clock = device.clock();
		if (s.dx == 0 && s.dy == 0) return answer(foreground ? "foreground" : "semantic", true);
		boolean vertical = Math.abs(s.dy) >= Math.abs(s.dx);
		if (!foreground && node != null) {
			List<String> actions = node.actions();
			String dir = vertical ? (s.dy > 0 ? "ACTION_SCROLL_DOWN" : "ACTION_SCROLL_UP") : (s.dx > 0 ? "ACTION_SCROLL_RIGHT" : "ACTION_SCROLL_LEFT");
			String paged = (vertical ? s.dy : s.dx) > 0 ? "ACTION_SCROLL_FORWARD" : "ACTION_SCROLL_BACKWARD";
			String action = actions.contains(dir) ? dir : actions.contains(paged) ? paged : null;
			if (action != null && node.perform(action, null)) return answer("semantic", sign.seen());
		}
		foreground(foreground, "scroll " + (s.ref != null ? s.ref : "at a point") + ": a swipe");
		Device.Display d = device.display();
		Rect area = (node != null ? node.bounds() : window.bounds()).intersect(new Rect(0, 0, d.width, d.height));
		if (area.empty()) throw new Refused("invalid", "scroll " + s.ref + ": the element is off the screen");
		int[] at = node != null ? new int[] {area.centerX(), area.centerY()} : onScreen(frame.pixels(s.point[0], s.point[1]));
		long leftX = Math.round(s.dx * frame.scale);
		long leftY = Math.round(s.dy * frame.scale);
		long reachX = Math.max(1, area.width() * 8L / 10);
		long reachY = Math.max(1, area.height() * 8L / 10);
		for (int swipes = 0; (leftX != 0 || leftY != 0) && swipes < 20; swipes++) {
			sign.cancel.check();
			long mx = Math.max(-reachX, Math.min(reachX, leftX));
			long my = Math.max(-reachY, Math.min(reachY, leftY));
			int fromX = clamp(at[0] + (int) (mx / 2), area.left, area.right - 1);
			int fromY = clamp(at[1] + (int) (my / 2), area.top, area.bottom - 1);
			int toX = clamp(fromX - (int) mx, area.left, area.right - 1);
			int toY = clamp(fromY - (int) my, area.top, area.bottom - 1);
			if (fromX == toX && fromY == toY) break;
			device.input().touch(new int[][] {{fromX, fromY}, {toX, toY}, {toX, toY}}, Math.max(DRAG_MS, Math.max(Math.abs(mx), Math.abs(my))));
			leftX -= fromX - toX;
			leftY -= fromY - toY;
			clock.sleep(30);
		}
		return answer("foreground", sign.seen());
	}

	private static int clamp(int v, int lo, int hi) {
		return Math.max(lo, Math.min(hi, v));
	}

	/** The element behind a ref, read again; stale when it is gone. */
	AxNode resolve(String ref) throws Refused {
		AxNode node = nodeOfRef.get(ref);
		if (node == null) throw new Refused("stale", ref + " was let go after " + REF_LIFETIME + " observes without it: observe again for fresh refs");
		if (!node.refresh() || node.bounds().empty()) throw new Refused("stale", ref + " is gone: its element is no longer in the window. Observe again for fresh refs");
		return node;
	}

	private int[] center(AxNode node, String ref) {
		Device.Display d = device.display();
		Rect seen = node.bounds().intersect(new Rect(0, 0, d.width, d.height));
		if (seen.empty()) throw RpcError.invalid(ref + " is off the screen: scroll it into view first");
		return new int[] {seen.centerX(), seen.centerY()};
	}

	private int[] onScreen(int[] p) {
		Device.Display d = device.display();
		if (p[0] < 0 || p[1] < 0 || p[0] >= d.width || p[1] >= d.height) throw RpcError.invalid("that point is off the screen");
		return p;
	}

	/**
	 * The point rule: a point read from a state lands only when the window is the state's, at its size, and what is
	 * under the point is the element the state saw there, where it was.
	 */
	void checkPoint(long[] p, String stateId, State held, Device.AxWindow window, Outline.Frame frame) throws Refused {
		String at = "(" + p[0] + ", " + p[1] + ")";
		if (held == null) throw new Refused("stale", "state " + stateId + " is no longer held: observe again, and read the point from the new state");
		if (held.windowId != window.id()) throw new Refused("stale", "the window of state " + stateId + " is no longer the one in front: observe again");
		Rect now = window.bounds();
		if (now.width() != held.windowBounds.width() || now.height() != held.windowBounds.height()) {
			throw new Refused("stale", "the window changed size since state " + stateId + ", so " + at + " may not land on what it showed: observe again");
		}
		long[] size = frame.points(now);
		if (p[0] < 0 || p[1] < 0 || p[0] >= size[2] || p[1] >= size[3]) throw new Refused("invalid", at + " is outside the window, which is " + size[2] + " by " + size[3] + " points");
		int[] px = frame.pixels(p[0], p[1]);
		int dx = held.windowBounds.left - now.left;
		int dy = held.windowBounds.top - now.top;
		Outline.Hit then = hitIn(held.hits, px[0] + dx, px[1] + dy);
		Outline.Hit hit = Outline.of(window.root(), true).hitAt(px[0], px[1]);
		boolean same = then == null ? hit == null
				: hit != null && then.key.equals(hit.key)
						&& then.bounds.left - dx == hit.bounds.left && then.bounds.top - dy == hit.bounds.top
						&& then.bounds.width() == hit.bounds.width() && then.bounds.height() == hit.bounds.height();
		if (!same) throw new Refused("stale", "what is at " + at + " changed since state " + stateId + ": observe again");
	}

	private static Outline.Hit hitIn(List<Outline.Hit> hits, int x, int y) {
		Outline.Hit found = null;
		for (Outline.Hit h : hits) if (h.bounds.contains(x, y)) found = h;
		return found;
	}

	private static boolean ascii(String text) {
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if ((c < 0x20 || c > 0x7e) && c != '\n') return false;
		}
		return true;
	}

	/** Whether a field reads back the text: equal, or holding it. A secure field cannot be read. */
	private static boolean readback(AxNode field, String text, boolean equal) {
		if (!field.refresh() || field.password()) return false;
		String now = field.text() == null ? "" : field.text();
		return equal ? now.equals(text) : now.contains(text);
	}

	private static AxNode focusedField(AxNode node, int depth) {
		if (node == null || depth > 100) return null;
		if (node.editable() && node.focused()) return node;
		int count = node.childCount();
		for (int i = 0; i < count; i++) {
			AxNode found = focusedField(node.child(i), depth + 1);
			if (found != null) return found;
		}
		return null;
	}

	/** Polls the expect against the target's window until it holds or its time runs out. */
	private boolean holdsWithin(Expect e, Device.Accessibility a11y, Target target, Device.Clock clock, Wire.Cancel cancel) throws InterruptedException {
		long start = clock.now();
		for (;;) {
			cancel.check();
			if (holds(e, a11y, target)) return true;
			long spent = clock.now() - start;
			if (spent >= e.timeoutMs) return false;
			clock.sleep(Math.min(EXPECT_POLL_MS, e.timeoutMs - spent));
		}
	}

	/** text: some element's name or value holds it; ref: the element is in the window (holding text, when both); gone inverts. */
	private boolean holds(Expect e, Device.Accessibility a11y, Target target) {
		Outline outline;
		try {
			outline = Outline.of(after(a11y, target).root(), true);
		} catch (RpcError gone) {
			return e.gone;
		}
		boolean seen = false;
		if (e.ref != null) {
			AxNode node = nodeOfRef.get(e.ref);
			Outline.Entry entry = node == null ? null : outline.find(node.key());
			seen = entry != null && (e.text == null || entry.holds(e.text));
		} else {
			for (Outline.Entry entry : outline.entries) {
				if (entry.holds(e.text)) {
					seen = true;
					break;
				}
			}
		}
		return seen != e.gone;
	}
}
