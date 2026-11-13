package ai.agentrun.phoned;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * A request's params, read field by field: a missing or wrong field is an `invalid` refusal that names the field. A
 * field this driver does not know is ignored (the wire lets a provider-side computer ignore one).
 */
public final class Params {
	private final Map<String, Object> map;
	/** The words before each field's name: "params" or "step 2". */
	private final String where;

	public Params(Map<String, Object> map, String where) {
		this.map = map == null ? Collections.<String, Object>emptyMap() : map;
		this.where = where;
	}

	@SuppressWarnings("unchecked")
	public static Params of(Object value, String where) {
		if (value != null && !(value instanceof Map)) throw RpcError.invalid(where + " must be an object");
		return new Params((Map<String, Object>) value, where);
	}

	public boolean has(String name) {
		return map.containsKey(name) && map.get(name) != null;
	}

	public Object raw(String name) {
		return map.get(name);
	}

	private RpcError wrong(String name, String want) {
		return RpcError.invalid(where + "." + name + " must be " + want);
	}

	public String str(String name) {
		Object v = map.get(name);
		if (!(v instanceof String)) throw wrong(name, "a string");
		return (String) v;
	}

	public String str(String name, String fallback) {
		return has(name) ? str(name) : fallback;
	}

	public long whole(String name, long min, long max) {
		Object v = map.get(name);
		long n;
		if (v instanceof Long) n = (Long) v;
		else if (v instanceof Double && ((Double) v) == Math.rint((Double) v)) n = (long) (double) (Double) v;
		else throw wrong(name, "a whole number from " + min + " to " + max);
		if (n < min || n > max) throw wrong(name, "a whole number from " + min + " to " + max);
		return n;
	}

	public long whole(String name, long fallback, long min, long max) {
		return has(name) ? whole(name, min, max) : fallback;
	}

	public double number(String name) {
		Object v = map.get(name);
		if (!(v instanceof Number)) throw wrong(name, "a number");
		double d = ((Number) v).doubleValue();
		if (Double.isNaN(d) || Double.isInfinite(d)) throw wrong(name, "a number");
		return d;
	}

	public double number(String name, double fallback) {
		return has(name) ? number(name) : fallback;
	}

	public boolean bool(String name, boolean fallback) {
		if (!has(name)) return fallback;
		Object v = map.get(name);
		if (!(v instanceof Boolean)) throw wrong(name, "true or false");
		return (Boolean) v;
	}

	public Params obj(String name) {
		Object v = map.get(name);
		if (!(v instanceof Map)) throw wrong(name, "an object");
		return of(v, where + "." + name);
	}

	@SuppressWarnings("unchecked")
	public List<Object> list(String name) {
		Object v = map.get(name);
		if (!(v instanceof List)) throw wrong(name, "a list");
		return (List<Object>) v;
	}

	/** A point [x, y] in screen pixels. */
	public int[] point(String name) {
		return pointOf(map.get(name), where + "." + name);
	}

	public static int[] pointOf(Object v, String what) {
		if (v instanceof List && ((List<?>) v).size() == 2) {
			Object x = ((List<?>) v).get(0);
			Object y = ((List<?>) v).get(1);
			if (x instanceof Number && y instanceof Number) {
				double dx = ((Number) x).doubleValue();
				double dy = ((Number) y).doubleValue();
				if (!Double.isNaN(dx) && !Double.isNaN(dy) && Math.abs(dx) < 1e7 && Math.abs(dy) < 1e7) {
					return new int[] {(int) Math.round(dx), (int) Math.round(dy)};
				}
			}
		}
		throw RpcError.invalid(what + " must be a point [x, y]");
	}

	/** A point [x, y] of whole numbers, as the ui group takes them (window points). */
	public static long[] wholePointOf(Object v, String what) {
		if (v instanceof List && ((List<?>) v).size() == 2) {
			Object x = ((List<?>) v).get(0);
			Object y = ((List<?>) v).get(1);
			if (x instanceof Long && y instanceof Long) return new long[] {(Long) x, (Long) y};
		}
		throw RpcError.invalid(what + " must be a point [x, y] of whole window points");
	}

	/** Refuses a field not among names: for the ui group, whose shapes are closed. */
	public void only(String... names) {
		for (String field : map.keySet()) {
			boolean known = false;
			for (String n : names) known |= n.equals(field);
			if (!known) throw RpcError.invalid(where + " has no field \"" + field + "\"");
		}
	}

	public String where() {
		return where;
	}
}
