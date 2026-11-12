package ai.agentrun.phoned;

import ai.agentrun.phoned.device.AxNode;
import ai.agentrun.phoned.device.Rect;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * One window's accessibility tree as the protocol's nodes (protocol.ts UiNode). Compact (the default) keeps the
 * elements a person would act on or read, and every element above them, so each node's parent is in the list. Full
 * keeps every element with pixels. Both drop zero-size elements, and compact drops what is off the screen.
 *
 * Android puts a row's words on its children, not on the clickable row (a Settings row is a LinearLayout around two
 * TextViews), so a nameless clickable element is named from its children's text: the first is its name and the rest
 * its value ("Network & internet", value "Mobile, Wi-Fi, hotspot"). In compact form those children are then not listed
 * again; an actionable element among them (a row's own switch) still is.
 */
public final class Outline {
	/** The most elements one walk reads: protocol.ts MAX_UI_NODES. */
	public static final int MAX_NODES = 5000;
	/** The most children's texts a nameless row takes, and the longest value they make. */
	static final int ROW_TEXTS = 4;
	static final int ROW_VALUE_CHARS = 160;
	/** The platform actions a node lists: the ones a caller would perform. Focus, selection and the like are left out. */
	static final Set<String> LISTED = new HashSet<>(Arrays.asList(
			"ACTION_CLICK", "ACTION_LONG_CLICK", "ACTION_SET_TEXT", "ACTION_SCROLL_FORWARD", "ACTION_SCROLL_BACKWARD",
			"ACTION_SCROLL_UP", "ACTION_SCROLL_DOWN", "ACTION_SCROLL_LEFT", "ACTION_SCROLL_RIGHT", "ACTION_EXPAND",
			"ACTION_COLLAPSE", "ACTION_DISMISS", "ACTION_SET_PROGRESS", "ACTION_PAGE_UP", "ACTION_PAGE_DOWN",
			"ACTION_PAGE_LEFT", "ACTION_PAGE_RIGHT", "ACTION_PRESS_AND_HOLD"));

	/** Pixels to window points: the window's top left in screen pixels, and pixels per point. */
	public static final class Frame {
		public final int left;
		public final int top;
		public final double scale;

		public Frame(int left, int top, double scale) {
			this.left = left;
			this.top = top;
			this.scale = scale > 0 ? scale : 1;
		}

		int pt(int px, int origin) {
			return (int) Math.round((px - origin) / scale);
		}

		/** Screen pixels as window points [x, y, w, h]. */
		public long[] points(Rect r) {
			int x1 = pt(r.left, left);
			int y1 = pt(r.top, top);
			int x2 = pt(r.right, left);
			int y2 = pt(r.bottom, top);
			return new long[] {x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1)};
		}

		/** A window point as screen pixels, at the middle of the pixels the point covers. */
		public int[] pixels(long x, long y) {
			return new int[] {left + (int) Math.floor((x + 0.5) * scale), top + (int) Math.floor((y + 0.5) * scale)};
		}
	}

	/** One element as observe lists it. Bounds are in screen pixels; json() gives them in window points. */
	public static final class Entry {
		public String ref;
		public final AxNode node;
		public final Object key;
		public final String role;
		public final String name;
		public final String value;
		public final String id;
		public final Rect bounds;
		/** The nearest listed element above it, or null. */
		public Entry parent;
		public final List<String> flags;
		public final List<String> actions;
		/** Compact form lists it: it can be acted on or has a name, or an element it holds does. */
		boolean kept;

		Entry(AxNode node, String role, String name, String value, Rect bounds, List<String> flags, List<String> actions) {
			this.node = node;
			this.key = node.key();
			this.role = role;
			this.name = name;
			this.value = value;
			this.id = Outline.trim(node.viewId());
			this.bounds = bounds;
			this.flags = flags;
			this.actions = actions;
		}

		/** What diff and the point rule compare: everything a person would see change, without the ref. */
		public String signature() {
			return role + "\u0000" + name + "\u0000" + value + "\u0000" + bounds + "\u0000" + flags;
		}

		/** Whether its name or its value holds text. */
		public boolean holds(String text) {
			return (name != null && name.contains(text)) || (value != null && value.contains(text));
		}

		public Map<String, Object> json(Frame frame) {
			return Json.obj(
					"ref", ref,
					"role", role,
					"name", name == null ? Json.OMIT : name,
					"value", value == null ? Json.OMIT : value,
					"id", id == null ? Json.OMIT : id,
					"bounds", frame.points(bounds),
					"parent", parent == null ? Json.OMIT : parent.ref,
					"flags", flags.isEmpty() ? Json.OMIT : flags,
					"actions", actions.isEmpty() ? Json.OMIT : actions);
		}
	}

	/** An element with pixels on the screen, for the point rule: its identity and bounds, in walk order. */
	public static final class Hit {
		public final Object key;
		public final Rect bounds;

		Hit(Object key, Rect bounds) {
			this.key = key;
			this.bounds = bounds;
		}
	}

	/** The listed elements, a parent before its children. */
	public final List<Entry> entries = new ArrayList<>();
	/** Every visible element with pixels, parents before children: the last one holding a point is the one under it. */
	public final List<Hit> hits = new ArrayList<>();
	public boolean truncated;
	private int read;

	private Outline() {}

	/** The tree under root, compact or full. */
	public static Outline of(AxNode root, boolean full) {
		Outline outline = new Outline();
		if (root != null) outline.walk(root, null, full, false, 0);
		if (!full) {
			List<Entry> kept = new ArrayList<>(outline.entries.size());
			for (Entry e : outline.entries) if (e.kept) kept.add(e);
			outline.entries.clear();
			outline.entries.addAll(kept);
		}
		return outline;
	}

	/** The deepest element under (x, y) in screen pixels, or null: what a tap there lands on. */
	public Hit hitAt(int x, int y) {
		Hit found = null;
		for (Hit h : hits) if (h.bounds.contains(x, y)) found = h;
		return found;
	}

	/** The entry for an element, by its key, or null. */
	public Entry find(Object key) {
		for (Entry e : entries) if (e.key.equals(key)) return e;
		return null;
	}

	private boolean spent(int depth) {
		if (read >= MAX_NODES || depth > 200) {
			truncated = true;
			return true;
		}
		read++;
		return false;
	}

	private void walk(AxNode node, Entry parent, boolean full, boolean inSearch, int depth) {
		if (spent(depth)) return;
		Rect bounds = node.bounds();
		boolean visible = node.visible();
		if (!bounds.empty() && visible) hits.add(new Hit(node.key(), bounds));
		Entry entry = null;
		boolean took = false;
		if (!bounds.empty() && (full || visible)) {
			String name = ownName(node);
			String value = valueOf(node);
			boolean acts = actionable(node);
			if (acts && name == null && (node.clickable() || node.longClickable() || node.checkable()) && !node.editable()) {
				List<String> texts = new ArrayList<>();
				childTexts(node, texts, 0);
				if (!texts.isEmpty()) {
					name = texts.get(0);
					took = true;
					if (value == null && texts.size() > 1) value = clip(String.join(", ", texts.subList(1, Math.min(texts.size(), ROW_TEXTS))));
				}
			}
			entry = new Entry(node, roleOf(node, name, inSearch), name, value, bounds, flagsOf(node, visible), actionsOf(node));
			entry.parent = parent;
			entry.kept = full || acts || name != null;
			if (entry.kept) for (Entry up = parent; up != null && !up.kept; up = up.parent) up.kept = true;
			entries.add(entry);
		}
		boolean search = inSearch || simpleName(node).equals("SearchView");
		// A row named from its children: in compact form they are not listed again (their hits still count).
		boolean skipChildren = took && !full;
		Entry above = entry != null ? entry : parent;
		int count = node.childCount();
		for (int i = 0; i < count; i++) {
			AxNode child = node.child(i);
			if (child == null) continue;
			if (skipChildren) named(child, above, search, depth + 1);
			else walk(child, above, full, search, depth + 1);
		}
	}

	/**
	 * Below a row named from its children: their texts are not listed again, but an actionable element among them (a
	 * row's own switch) is, as the row's child.
	 */
	private void named(AxNode node, Entry row, boolean inSearch, int depth) {
		if (actionable(node)) {
			walk(node, row, false, inSearch, depth);
			return;
		}
		if (spent(depth)) return;
		Rect bounds = node.bounds();
		if (!bounds.empty() && node.visible()) hits.add(new Hit(node.key(), bounds));
		int count = node.childCount();
		for (int i = 0; i < count; i++) {
			AxNode child = node.child(i);
			if (child != null) named(child, row, inSearch, depth + 1);
		}
	}

	/** The texts of a row's children, in order; an actionable child (a row's switch) is listed on its own instead. */
	private void childTexts(AxNode node, List<String> out, int depth) {
		if (out.size() >= ROW_TEXTS || depth > 12) return;
		int count = node.childCount();
		for (int i = 0; i < count && out.size() < ROW_TEXTS; i++) {
			AxNode child = node.child(i);
			if (child == null || child.bounds().empty() || !child.visible()) continue;
			if (actionable(child)) continue;
			String own = ownName(child);
			if (own != null) out.add(own);
			childTexts(child, out, depth + 1);
		}
	}

	static boolean actionable(AxNode n) {
		return n.clickable() || n.longClickable() || n.editable() || n.checkable() || n.scrollable();
	}

	/** An element's own words: its text, else its content description. A text field's is its description or hint. */
	static String ownName(AxNode n) {
		if (n.editable()) {
			String desc = trim(n.description());
			return desc != null ? desc : trim(n.hint());
		}
		String text = n.password() ? null : trim(n.text());
		if (text != null) return text;
		return trim(n.description());
	}

	/** What it holds: a text field's text. A secure field's is never read. */
	static String valueOf(AxNode n) {
		if (n.password() || !n.editable()) return null;
		String text = trim(n.text());
		// An empty field reports its hint as its text on many releases: that is not a value.
		if (text != null && text.equals(trim(n.hint()))) return null;
		return text;
	}

	static String trim(String s) {
		if (s == null) return null;
		String t = s.trim();
		return t.isEmpty() ? null : t;
	}

	static String clip(String s) {
		return s.length() <= ROW_VALUE_CHARS ? s : s.substring(0, ROW_VALUE_CHARS - 1) + "…";
	}

	static List<String> flagsOf(AxNode n, boolean visible) {
		List<String> flags = new ArrayList<>(2);
		if (n.focused()) flags.add("focused");
		if (!n.enabled()) flags.add("disabled");
		if (n.selected()) flags.add("selected");
		if (n.checkable() && n.checked()) flags.add("checked");
		if (n.password()) flags.add("secure");
		if (!visible) flags.add("offscreen");
		return flags;
	}

	/** The platform's actions a caller would perform, and the app's own (by label). */
	static List<String> actionsOf(AxNode n) {
		List<String> all = n.actions();
		List<String> out = new ArrayList<>(Math.min(all.size(), 4));
		for (String a : all) if (LISTED.contains(a) || !a.startsWith("ACTION_")) out.add(a);
		return out;
	}

	static String simpleName(AxNode n) {
		String cls = n.className() == null ? "" : n.className();
		String simple = cls.substring(cls.lastIndexOf('.') + 1);
		int dollar = simple.lastIndexOf('$');
		return dollar >= 0 ? simple.substring(dollar + 1) : simple;
	}

	/** The element's ARIA role (protocol.ts UI_ROLES), from its class and what it does. */
	static String roleOf(AxNode n, String name, boolean inSearch) {
		if (n.editable()) {
			String id = n.viewId() == null ? "" : n.viewId().toLowerCase(Locale.ROOT);
			return inSearch || id.contains("search") ? "searchbox" : "textbox";
		}
		switch (simpleName(n)) {
			case "Button":
			case "ImageButton":
			case "MaterialButton":
			case "FloatingActionButton":
			case "ExtendedFloatingActionButton":
				return "button";
			case "SearchView":
				return "group";
			case "CheckBox":
			case "CheckedTextView":
			case "MaterialCheckBox":
				return "checkbox";
			case "Switch":
			case "SwitchCompat":
			case "SwitchMaterial":
			case "MaterialSwitch":
			case "ToggleButton":
				return "switch";
			case "RadioButton":
			case "MaterialRadioButton":
				return "radio";
			case "SeekBar":
			case "RatingBar":
			case "Slider":
				return "slider";
			case "Spinner":
				return "combobox";
			case "ProgressBar":
				return "progressbar";
			case "ScrollView":
			case "HorizontalScrollView":
			case "NestedScrollView":
			case "RecyclerView":
			case "ListView":
			case "GridView":
			case "ViewPager":
			case "ViewPager2":
				return "scrollarea";
			case "TabWidget":
			case "TabView":
				return "tab";
			case "Toolbar":
			case "MaterialToolbar":
				return "toolbar";
			default:
				break;
		}
		if (n.checkable()) return "checkbox";
		if (n.clickable() || n.longClickable()) return "button";
		if (n.scrollable()) return "scrollarea";
		String simple = simpleName(n);
		if (simple.endsWith("ImageView")) return "image";
		if (name != null) return "text";
		return "generic";
	}
}
