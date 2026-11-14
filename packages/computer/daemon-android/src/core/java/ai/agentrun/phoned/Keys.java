package ai.agentrun.phoned;

import java.util.HashMap;
import java.util.Map;

/**
 * Keys as the protocol names them (protocol.ts KEYS, or one printable ASCII character), as Android's key codes and meta
 * bits (android.view.KeyEvent), on a US layout.
 */
public final class Keys {
	private Keys() {}

	public static final int KEYCODE_HOME = 3;
	public static final int KEYCODE_BACK = 4;
	public static final int KEYCODE_ENTER = 66;
	public static final int KEYCODE_APP_SWITCH = 187;

	static final int META_SHIFT = 0x1 | 0x40;
	static final int META_ALT = 0x2 | 0x10;
	static final int META_CTRL = 0x1000 | 0x2000;
	static final int META_META = 0x10000 | 0x20000;

	/** The protocol's key table: "home" is line start here (MOVE_HOME), not the Home button. */
	static final Map<String, Integer> TABLE = new HashMap<>();
	/** One printable character: its key code and whether it needs shift. */
	private static final Map<Character, int[]> CHARS = new HashMap<>();

	static {
		Object[] table = {
			"enter", 66, "tab", 61, "space", 62, "backspace", 67, "delete", 112, "escape", 111, "insert", 124,
			"up", 19, "down", 20, "left", 21, "right", 22, "home", 122, "end", 123, "pageup", 92, "pagedown", 93,
			"shift", 59, "ctrl", 113, "alt", 57, "super", 117, "capslock", 115,
		};
		for (int i = 0; i < table.length; i += 2) TABLE.put((String) table[i], (Integer) table[i + 1]);
		for (int f = 1; f <= 12; f++) TABLE.put("f" + f, 130 + f);
		for (char c = 'a'; c <= 'z'; c++) {
			CHARS.put(c, new int[] {29 + (c - 'a'), 0});
			CHARS.put(Character.toUpperCase(c), new int[] {29 + (c - 'a'), META_SHIFT});
		}
		for (char c = '0'; c <= '9'; c++) CHARS.put(c, new int[] {7 + (c - '0'), 0});
		Object[] plain = {'`', 68, '-', 69, '=', 70, '[', 71, ']', 72, '\\', 73, ';', 74, '\'', 75, '/', 76, ',', 55, '.', 56, '@', 77, '+', 81, '*', 17, '#', 18};
		for (int i = 0; i < plain.length; i += 2) CHARS.put((Character) plain[i], new int[] {(Integer) plain[i + 1], 0});
		Object[] shifted = {
			'~', 68, '!', 8, '$', 11, '%', 12, '^', 13, '&', 14, '(', 16, ')', 7, '_', 69, '{', 71, '}', 72, '|', 73,
			':', 74, '"', 75, '?', 76, '<', 55, '>', 56,
		};
		for (int i = 0; i < shifted.length; i += 2) CHARS.put((Character) shifted[i], new int[] {(Integer) shifted[i + 1], META_SHIFT});
	}

	/** The meta bits a modifier key holds down, or 0 when it is not a modifier. */
	static int metaOf(int keyCode) {
		switch (keyCode) {
			case 59:
			case 60:
				return META_SHIFT;
			case 57:
			case 58:
				return META_ALT;
			case 113:
			case 114:
				return META_CTRL;
			case 117:
			case 118:
				return META_META;
			default:
				return 0;
		}
	}

	/** One key: {key code, the meta bits it needs of its own (shift for "A")}; invalid in words when it is none. */
	public static int[] key(String name) {
		Integer code = TABLE.get(name);
		if (code != null) return new int[] {code, 0};
		if (name.length() == 1) {
			int[] c = CHARS.get(name.charAt(0));
			if (c != null) return c.clone();
		}
		throw RpcError.invalid(quote(name) + " is not a key: a key is a name in the key table (protocol.json keys) or one printable ASCII character");
	}

	/** A chord's keys, from names joined by "+" ("ctrl+shift+t"): each {key code, meta of its own}. */
	public static int[][] chord(String chord) {
		// The last name may be "+" itself ("+", "shift++"), as ui-engine's chordKeys reads it.
		String[] parts;
		if (chord.equals("+")) {
			parts = new String[] {"+"};
		} else if (chord.endsWith("++")) {
			String[] head = chord.substring(0, chord.length() - 2).split("\\+", -1);
			parts = java.util.Arrays.copyOf(head, head.length + 1);
			parts[head.length] = "+";
		} else {
			parts = chord.split("\\+", -1);
		}
		int[][] keys = new int[parts.length][];
		for (int i = 0; i < parts.length; i++) {
			if (parts[i].isEmpty()) throw RpcError.invalid("key " + quote(chord) + ": each name joined by \"+\" is one of the key table's (protocol.json keys) or one printable character");
			keys[i] = key(parts[i]);
		}
		return keys;
	}

	/** Presses a chord: each key down in order, holding the meta of those before it, then each up in reverse. */
	static void press(ai.agentrun.phoned.device.Device.Input input, int[][] keys) {
		if (keys.length == 1) {
			input.key(keys[0][0], keys[0][1]);
			return;
		}
		int[] held = new int[keys.length];
		int meta = 0;
		for (int i = 0; i < keys.length - 1; i++) {
			meta |= metaOf(keys[i][0]) | keys[i][1];
			held[i] = meta;
			input.keyDown(keys[i][0], meta);
		}
		int[] last = keys[keys.length - 1];
		input.key(last[0], meta | last[1]);
		for (int i = keys.length - 2; i >= 0; i--) input.keyUp(keys[i][0], i == 0 ? 0 : held[i - 1]);
	}

	static String quote(String s) {
		return Json.write(s);
	}
}
