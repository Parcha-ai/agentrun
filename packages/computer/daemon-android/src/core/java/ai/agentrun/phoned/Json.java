package ai.agentrun.phoned;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON for the wire, with no library: parse() gives Map (LinkedHashMap), List, String, Long, Double, Boolean or null;
 * write() takes those, plus int, long[] and any Number. A whole number parses as a Long (1.0 and 1e0 too), any other as a Double.
 */
public final class Json {
	private Json() {}

	/** Thrown for text that is not one JSON value. */
	public static final class ParseError extends Exception {
		ParseError(String message) {
			super(message);
		}
	}

	public static Object parse(String text) throws ParseError {
		Json.Reader reader = new Json.Reader(text);
		reader.space();
		Object value = reader.value(0);
		reader.space();
		if (reader.at < text.length()) throw new ParseError("text after the value at " + reader.at);
		return value;
	}

	public static String write(Object value) {
		StringBuilder out = new StringBuilder();
		write(value, out);
		return out.toString();
	}

	@SuppressWarnings("unchecked")
	static void write(Object value, StringBuilder out) {
		if (value == null) {
			out.append("null");
		} else if (value instanceof String) {
			quote((String) value, out);
		} else if (value instanceof Boolean) {
			out.append(((Boolean) value) ? "true" : "false");
		} else if (value instanceof Double || value instanceof Float) {
			double d = ((Number) value).doubleValue();
			if (Double.isNaN(d) || Double.isInfinite(d)) out.append("null");
			else if (d == Math.rint(d) && Math.abs(d) < 1e15) out.append((long) d);
			else out.append(d);
		} else if (value instanceof Number) {
			out.append(((Number) value).longValue());
		} else if (value instanceof Map) {
			out.append('{');
			boolean first = true;
			for (Map.Entry<String, Object> e : ((Map<String, Object>) value).entrySet()) {
				if (e.getValue() == OMIT) continue;
				if (!first) out.append(',');
				first = false;
				quote(e.getKey(), out);
				out.append(':');
				write(e.getValue(), out);
			}
			out.append('}');
		} else if (value instanceof List) {
			out.append('[');
			boolean first = true;
			for (Object item : (List<Object>) value) {
				if (!first) out.append(',');
				first = false;
				write(item, out);
			}
			out.append(']');
		} else if (value instanceof long[]) {
			out.append('[');
			long[] a = (long[]) value;
			for (int i = 0; i < a.length; i++) {
				if (i > 0) out.append(',');
				out.append(a[i]);
			}
			out.append(']');
		} else {
			throw new IllegalArgumentException("not a JSON value: " + value.getClass().getName());
		}
	}

	/** A map value write() leaves out, so a builder can add a field only when it has one. */
	public static final Object OMIT = new Object();

	static void quote(String s, StringBuilder out) {
		out.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"':
					out.append("\\\"");
					break;
				case '\\':
					out.append("\\\\");
					break;
				case '\n':
					out.append("\\n");
					break;
				case '\r':
					out.append("\\r");
					break;
				case '\t':
					out.append("\\t");
					break;
				default:
					// Control characters, and the two line separators JavaScript once refused, are escaped.
					if (c < 0x20 || c == ' ' || c == ' ') {
						out.append(String.format("\\u%04x", (int) c));
					} else {
						out.append(c);
					}
			}
		}
		out.append('"');
	}

	/** A map built in order: Json.obj("a", 1, "b", 2). A value of OMIT is left out. */
	public static Map<String, Object> obj(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i + 1 < pairs.length; i += 2) {
			if (pairs[i + 1] != OMIT) map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	/** The deepest a value may nest: a hostile line cannot exhaust the stack. */
	static final int MAX_DEPTH = 64;

	private static final class Reader {
		final String s;
		int at;

		Reader(String s) {
			this.s = s;
		}

		void space() {
			while (at < s.length()) {
				char c = s.charAt(at);
				if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
				else break;
			}
		}

		ParseError error(String what) {
			return new ParseError(what + " at " + at);
		}

		Object value(int depth) throws ParseError {
			if (depth > MAX_DEPTH) throw error("nested deeper than " + MAX_DEPTH);
			if (at >= s.length()) throw error("the text ended");
			char c = s.charAt(at);
			switch (c) {
				case '{':
					return object(depth);
				case '[':
					return array(depth);
				case '"':
					return string();
				case 't':
					return word("true", Boolean.TRUE);
				case 'f':
					return word("false", Boolean.FALSE);
				case 'n':
					return word("null", null);
				default:
					if (c == '-' || (c >= '0' && c <= '9')) return number();
					throw error("unexpected " + c);
			}
		}

		Object word(String w, Object v) throws ParseError {
			if (!s.startsWith(w, at)) throw error("not " + w);
			at += w.length();
			return v;
		}

		Map<String, Object> object(int depth) throws ParseError {
			Map<String, Object> map = new LinkedHashMap<>();
			at++;
			space();
			if (at < s.length() && s.charAt(at) == '}') {
				at++;
				return map;
			}
			for (;;) {
				space();
				if (at >= s.length() || s.charAt(at) != '"') throw error("a key must be a string");
				String key = string();
				space();
				if (at >= s.length() || s.charAt(at) != ':') throw error("a colon must follow a key");
				at++;
				space();
				map.put(key, value(depth + 1));
				space();
				if (at >= s.length()) throw error("the object did not end");
				char c = s.charAt(at++);
				if (c == '}') return map;
				if (c != ',') throw error("a comma or } must follow a value");
			}
		}

		List<Object> array(int depth) throws ParseError {
			List<Object> list = new ArrayList<>();
			at++;
			space();
			if (at < s.length() && s.charAt(at) == ']') {
				at++;
				return list;
			}
			for (;;) {
				space();
				list.add(value(depth + 1));
				space();
				if (at >= s.length()) throw error("the array did not end");
				char c = s.charAt(at++);
				if (c == ']') return list;
				if (c != ',') throw error("a comma or ] must follow a value");
			}
		}

		String string() throws ParseError {
			StringBuilder out = new StringBuilder();
			at++;
			for (;;) {
				if (at >= s.length()) throw error("the string did not end");
				char c = s.charAt(at++);
				if (c == '"') return out.toString();
				if (c < 0x20) throw error("a control character in a string");
				if (c != '\\') {
					out.append(c);
					continue;
				}
				if (at >= s.length()) throw error("the string did not end");
				char e = s.charAt(at++);
				switch (e) {
					case '"':
					case '\\':
					case '/':
						out.append(e);
						break;
					case 'b':
						out.append('\b');
						break;
					case 'f':
						out.append('\f');
						break;
					case 'n':
						out.append('\n');
						break;
					case 'r':
						out.append('\r');
						break;
					case 't':
						out.append('\t');
						break;
					case 'u':
						if (at + 4 > s.length()) throw error("a short \\u escape");
						try {
							out.append((char) Integer.parseInt(s.substring(at, at + 4), 16));
						} catch (NumberFormatException x) {
							throw error("a bad \\u escape");
						}
						at += 4;
						break;
					default:
						throw error("a bad escape \\" + e);
				}
			}
		}

		Object number() throws ParseError {
			int start = at;
			if (s.charAt(at) == '-') at++;
			boolean whole = true;
			while (at < s.length()) {
				char c = s.charAt(at);
				if (c >= '0' && c <= '9') at++;
				else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
					whole = false;
					at++;
				} else break;
			}
			String n = s.substring(start, at);
			try {
				if (whole) {
					try {
						return Long.parseLong(n);
					} catch (NumberFormatException tooBig) {
						return Double.parseDouble(n);
					}
				}
				// 1.0 and 1e0 are the whole number 1 in JSON: a field that wants a whole number takes them as one.
				double d = Double.parseDouble(n);
				if (d == Math.rint(d) && Math.abs(d) <= (1L << 53)) return (long) d;
				return d;
			} catch (NumberFormatException x) {
				throw error("not a number: " + n);
			}
		}
	}
}
