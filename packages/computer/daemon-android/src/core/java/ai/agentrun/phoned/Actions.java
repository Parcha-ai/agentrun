package ai.agentrun.phoned;

import ai.agentrun.phoned.device.Device;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * input.actions on a phone: the touch and keys groups, injected through the phone's input system in screen pixels. The
 * batch is checked whole before any action runs, by the rules of the TypeScript checkActions (src/actions.ts): shape,
 * keys, groups, repeat, text length and the summed durations. A failure then answers { done: 0, failed }.
 */
public final class Actions {
	/** protocol.ts MAX_ACTIONS, MAX_BATCH_WAIT_MS, MAX_KEY_REPEAT; actions.ts MAX_TYPE_CHARACTERS. */
	static final int MAX_ACTIONS = 100;
	static final long MAX_BATCH_WAIT_MS = 300_000;
	static final long MAX_KEY_REPEAT = 100;
	static final int MAX_TYPE_CHARACTERS = 64 << 10;
	static final long LONG_PRESS_MS = 800;
	static final long SWIPE_MS = 300;
	static final long PINCH_MS = 400;
	/** The pause between the taps of a double tap. */
	static final long TAP_GAP_MS = 60;

	private static final Set<String> POINTER = new HashSet<>(Arrays.asList("move", "down", "up", "click", "drag", "scroll"));
	private static final Set<String> TIMED = new HashSet<>(Arrays.asList("wait", "hold", "long_press", "swipe", "pinch"));

	private final Device device;
	private final Object hands;

	public Actions(Device device, Object hands) {
		this.device = device;
		this.hands = hands;
	}

	/** Why one action may not run, as {kind, words}, or null. */
	private static String[] check(Object raw, int index, long[] waited) {
		if (!(raw instanceof Map)) return new String[] {"invalid", "action " + index + " is not an object"};
		@SuppressWarnings("unchecked")
		Map<String, Object> a = (Map<String, Object>) raw;
		Object type = a.get("type");
		String shape = shape(a);
		if (shape != null) return new String[] {"invalid", "action " + index + " (" + Json.write(type) + "): " + shape};
		Object keys = a.get("keys");
		if (keys instanceof List) {
			for (Object key : (List<?>) keys) {
				try {
					if (!(key instanceof String)) throw RpcError.invalid("");
					Keys.key((String) key);
				} catch (RpcError e) {
					return new String[] {"invalid", "action " + index + ": " + Json.write(key) + " is not a key: a key is a name in KEYS or one printable ASCII character"};
				}
			}
		}
		if (POINTER.contains(type)) return new String[] {"unsupported", "action " + index + " (" + type + ") needs input.pointer, which this computer does not declare"};
		if ("key".equals(type) && a.get("repeat") != null && ((Long) a.get("repeat")) > MAX_KEY_REPEAT) {
			return new String[] {"limit", "action " + index + ": repeat " + a.get("repeat") + " is over " + MAX_KEY_REPEAT};
		}
		if ("type".equals(type)) {
			String text = (String) a.get("text");
			int characters = text.codePointCount(0, text.length());
			if (characters > MAX_TYPE_CHARACTERS) return new String[] {"limit", "action " + index + ": text of " + characters + " characters; one type takes at most " + MAX_TYPE_CHARACTERS};
		}
		if (TIMED.contains(type) && a.get("ms") != null) {
			waited[0] += (Long) a.get("ms");
			if (waited[0] > MAX_BATCH_WAIT_MS) return new String[] {"limit", "the batch's durations reach " + waited[0] + " ms at action " + index + ", over " + MAX_BATCH_WAIT_MS + " ms"};
		}
		return null;
	}

	private static boolean isNumber(Object v) {
		return v instanceof Long || (v instanceof Double && !((Double) v).isNaN() && !((Double) v).isInfinite());
	}

	private static boolean isMs(Object v) {
		return v instanceof Long && (Long) v >= 0 && (Long) v <= (1L << 53);
	}

	private static boolean isPoint(Object v) {
		return v instanceof List && ((List<?>) v).size() == 2 && isNumber(((List<?>) v).get(0)) && isNumber(((List<?>) v).get(1));
	}

	private static boolean isPath(Object v) {
		if (!(v instanceof List) || ((List<?>) v).size() < 2) return false;
		for (Object p : (List<?>) v) if (!isPoint(p)) return false;
		return true;
	}

	/** What is wrong with one action's shape, in words, or null. */
	private static String shape(Map<String, Object> a) {
		Object type = a.get("type");
		boolean hasAt = a.get("at") != null;
		boolean hasMs = a.get("ms") != null;
		boolean hasKeys = a.get("keys") != null;
		Object button = a.get("button");
		String badButton = button != null && !Arrays.asList("left", "right", "middle").contains(button) ? "button " + Json.write(button) + " is not left, right or middle" : null;
		String badAt = !isPoint(a.get("at")) ? "at " + Json.write(a.get("at")) + " is not a point [x, y]" : null;
		String badMs = !isMs(a.get("ms")) ? "ms " + Json.write(a.get("ms")) + " is not a whole number of milliseconds" : null;
		String badKeys = !(a.get("keys") instanceof List) ? "keys " + Json.write(a.get("keys")) + " is not a list of keys" : null;
		String requiredKeys = !(a.get("keys") instanceof List) || ((List<?>) a.get("keys")).isEmpty() ? "keys " + Json.write(a.get("keys")) + " is not a list of keys" : null;
		Object count = a.get("count");
		if (!(type instanceof String)) return "type " + Json.write(type) + " is not an input action";
		switch ((String) type) {
			case "move":
				return badAt;
			case "down":
			case "up":
				return badButton;
			case "click":
				return first(hasAt ? badAt : null, badButton, count != null && !Arrays.asList(1L, 2L, 3L).contains(count) ? "count " + Json.write(count) + " is not 1, 2 or 3" : null, hasKeys ? badKeys : null);
			case "drag":
				return first(!isPath(a.get("path")) ? "path is not a list of 2 or more points" : null, badButton, hasKeys ? badKeys : null);
			case "scroll":
				return first(hasAt ? badAt : null,
						(a.get("dx") != null && !isNumber(a.get("dx"))) || (a.get("dy") != null && !isNumber(a.get("dy"))) ? "dx and dy are numbers" : null,
						!"clicks".equals(a.get("unit")) && !"px".equals(a.get("unit")) ? "unit " + Json.write(a.get("unit")) + " is not clicks or px" : null,
						hasKeys ? badKeys : null);
			case "key": {
				Object repeat = a.get("repeat");
				return first(requiredKeys, repeat != null && !(repeat instanceof Long && (Long) repeat > 0) ? "repeat " + Json.write(repeat) + " is not a whole number above 0" : null);
			}
			case "hold":
				return first(requiredKeys, badMs);
			case "type":
				return !(a.get("text") instanceof String) ? "text is not a string" : null;
			case "tap":
				return first(badAt, count != null && !Arrays.asList(1L, 2L).contains(count) ? "count " + Json.write(count) + " is not 1 or 2" : null);
			case "long_press":
				return first(badAt, hasMs ? badMs : null);
			case "swipe":
				return first(!isPath(a.get("path")) ? "path is not a list of 2 or more points" : null, hasMs ? badMs : null);
			case "pinch": {
				Object scale = a.get("scale");
				return first(badAt, !(isNumber(scale) && ((Number) scale).doubleValue() > 0) ? "scale " + Json.write(scale) + " is not a number above 0" : null, hasMs ? badMs : null);
			}
			case "button":
				return !Arrays.asList("back", "home", "app_switch").contains(a.get("name")) ? "name " + Json.write(a.get("name")) + " is not back, home or app_switch" : null;
			case "wait":
				return badMs;
			default:
				return "type " + Json.write(type) + " is not an input action";
		}
	}

	private static String first(String... reasons) {
		for (String r : reasons) if (r != null) return r;
		return null;
	}

	private static Map<String, Object> failed(long done, int index, String kind, String message) {
		return Json.obj("done", done, "failed", Json.obj("index", (long) index, "kind", kind, "message", message));
	}

	private static int[] px(Object point) {
		List<?> p = (List<?>) point;
		return new int[] {(int) Math.round(((Number) p.get(0)).doubleValue()), (int) Math.round(((Number) p.get(1)).doubleValue())};
	}

	/** Every point an action lands on, in screen pixels. */
	private static List<int[]> pointsOf(Map<String, Object> a) {
		List<int[]> points = new ArrayList<>();
		if (a.get("at") != null) points.add(px(a.get("at")));
		if (a.get("path") instanceof List) for (Object p : (List<?>) a.get("path")) points.add(px(p));
		return points;
	}

	public Map<String, Object> run(Params p, Wire.Cancel cancel) {
		Object raw = p.raw("actions");
		if (!(raw instanceof List)) return failed(0, 0, "invalid", "actions is not a list");
		List<?> actions = (List<?>) raw;
		if (actions.size() > MAX_ACTIONS) return failed(0, MAX_ACTIONS, "limit", "a batch holds at most " + MAX_ACTIONS + " actions; this one has " + actions.size());
		long[] waited = {0};
		Device.Display d = device.display();
		for (int i = 0; i < actions.size(); i++) {
			String[] wrong = check(actions.get(i), i, waited);
			if (wrong != null) return failed(0, i, wrong[0], wrong[1]);
			@SuppressWarnings("unchecked")
			Map<String, Object> a = (Map<String, Object>) actions.get(i);
			for (int[] at : pointsOf(a)) {
				if (at[0] < 0 || at[1] < 0 || at[0] >= d.width || at[1] >= d.height) {
					return failed(0, i, "invalid", "action " + i + ": [" + at[0] + ", " + at[1] + "] is off the " + d.width + "x" + d.height + " screen");
				}
			}
		}
		synchronized (hands) {
			for (int i = 0; i < actions.size(); i++) {
				if (cancel.cancelled()) return failed(i, i, "aborted", "action " + i + ": the batch was aborted; actions " + i + " on did not run");
				@SuppressWarnings("unchecked")
				Map<String, Object> a = (Map<String, Object>) actions.get(i);
				try {
					one(a, d, cancel);
				} catch (InterruptedException e) {
					return failed(i, i, "aborted", "action " + i + ": the batch was aborted; actions " + i + " on did not run");
				} catch (RpcError e) {
					if ("aborted".equals(e.kind)) return failed(i, i, "aborted", "action " + i + ": the batch was aborted; actions " + i + " on did not run");
					return failed(i, i, e.kind, "action " + i + ": " + e.getMessage());
				}
			}
		}
		return Json.obj("done", (long) actions.size());
	}

	private static long ms(Map<String, Object> a, long fallback) {
		Object v = a.get("ms");
		return v == null ? fallback : (Long) v;
	}

	private void one(Map<String, Object> a, Device.Display d, Wire.Cancel cancel) throws InterruptedException {
		Device.Input input = device.input();
		Device.Clock clock = device.clock();
		switch ((String) a.get("type")) {
			case "tap": {
				int[] at = px(a.get("at"));
				long count = a.get("count") == null ? 1 : (Long) a.get("count");
				for (int i = 0; i < count; i++) {
					if (i > 0) clock.sleep(TAP_GAP_MS);
					input.touch(new int[][] {at}, 0);
				}
				return;
			}
			case "long_press": {
				int[] at = px(a.get("at"));
				input.touch(new int[][] {at, at}, ms(a, LONG_PRESS_MS));
				return;
			}
			case "swipe": {
				List<?> path = (List<?>) a.get("path");
				int[][] points = new int[path.size()][];
				for (int i = 0; i < points.length; i++) points[i] = px(path.get(i));
				input.touch(points, ms(a, SWIPE_MS));
				return;
			}
			case "pinch": {
				int[] at = px(a.get("at"));
				double scale = ((Number) a.get("scale")).doubleValue();
				// The fingers start a fifth of the screen's short side apart (wider when closing), along the horizontal.
				double span = Math.min(d.width, d.height) / 5.0;
				double from = scale >= 1 ? span / 2 : span / 2 / Math.max(scale, 0.05);
				double to = from * scale;
				input.pinch(new int[][] {spot(at, -from, d), spot(at, from, d)}, new int[][] {spot(at, -to, d), spot(at, to, d)}, ms(a, PINCH_MS));
				return;
			}
			case "button": {
				String name = (String) a.get("name");
				input.key(name.equals("back") ? Keys.KEYCODE_BACK : name.equals("home") ? Keys.KEYCODE_HOME : Keys.KEYCODE_APP_SWITCH, 0);
				return;
			}
			case "type": {
				String text = (String) a.get("text");
				if (text.isEmpty()) return;
				if (!(ascii(text) && input.typeKeys(text))) input.paste(text);
				return;
			}
			case "key": {
				List<?> names = (List<?>) a.get("keys");
				int[][] keys = new int[names.size()][];
				for (int i = 0; i < keys.length; i++) keys[i] = Keys.key((String) names.get(i));
				long repeat = a.get("repeat") == null ? 1 : (Long) a.get("repeat");
				for (long r = 0; r < repeat; r++) {
					cancel.check();
					Keys.press(input, keys);
				}
				return;
			}
			case "hold": {
				List<?> names = (List<?>) a.get("keys");
				int[][] keys = new int[names.size()][];
				for (int i = 0; i < keys.length; i++) keys[i] = Keys.key((String) names.get(i));
				int meta = 0;
				int[] held = new int[keys.length];
				int down = 0;
				try {
					for (; down < keys.length; down++) {
						meta |= Keys.metaOf(keys[down][0]) | keys[down][1];
						held[down] = meta;
						input.keyDown(keys[down][0], meta);
					}
					clock.sleep(ms(a, 0));
				} finally {
					// Every key that went down comes up, even when the hold was cancelled.
					for (int i = down - 1; i >= 0; i--) input.keyUp(keys[i][0], i == 0 ? 0 : held[i - 1]);
				}
				return;
			}
			case "wait":
				clock.sleep(ms(a, 0));
				cancel.check();
				return;
			default:
				throw RpcError.unsupported(a.get("type") + " is not an action this phone takes");
		}
	}

	private static int[] spot(int[] at, double dx, Device.Display d) {
		return new int[] {Math.max(0, Math.min(d.width - 1, (int) Math.round(at[0] + dx))), at[1]};
	}

	static boolean ascii(String text) {
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if ((c < 0x20 || c > 0x7e) && c != '\n') return false;
		}
		return true;
	}
}
