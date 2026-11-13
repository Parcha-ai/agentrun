package ai.agentrun.phoned;

import ai.agentrun.phoned.fake.FakeDevice;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** The tests' assertions, and a phone to call. */
final class Check {
	private Check() {}

	static void eq(Object want, Object got) {
		if (!Objects.equals(want, got)) throw new AssertionError("want " + Json.write(want) + ", got " + Json.write(got));
	}

	static void yes(boolean v, String what) {
		if (!v) throw new AssertionError(what);
	}

	/** Runs fn and checks it refuses with kind; returns the words. */
	static String refuses(String kind, Body fn) throws Exception {
		try {
			fn.run();
		} catch (RpcError e) {
			if (!e.kind.equals(kind)) throw new AssertionError("want " + kind + ", got " + e.kind + ": " + e.getMessage());
			return e.getMessage();
		}
		throw new AssertionError("want a refusal of kind " + kind + ", got none");
	}

	interface Body {
		void run() throws Exception;
	}

	/** A phone and phoned over it, called method by method. */
	static final class Phone {
		final FakeDevice device = new FakeDevice(true);
		final Phoned phoned = new Phoned(device, "0.0.0-test", new Exec(System.getenv(), System.getProperty("java.io.tmpdir")));

		@SuppressWarnings("unchecked")
		Map<String, Object> call(String method, String params) throws Exception {
			Object p;
			try {
				p = Json.parse(params);
			} catch (Json.ParseError e) {
				throw new AssertionError("bad test params: " + params);
			}
			return (Map<String, Object>) phoned.handle(method, Params.of(p, "params"), Wire.Cancel.none());
		}

		/** The observed node named name. */
		Map<String, Object> node(Map<String, Object> observed, String name) {
			for (Object n : list(observed, "nodes")) {
				Map<String, Object> node = map(n);
				if (name.equals(node.get("name"))) return node;
			}
			throw new AssertionError("no node named " + name + " in " + Json.write(observed.get("nodes")));
		}
	}

	@SuppressWarnings("unchecked")
	static Map<String, Object> map(Object v) {
		return (Map<String, Object>) v;
	}

	@SuppressWarnings("unchecked")
	static List<Object> list(Map<String, Object> m, String key) {
		return (List<Object>) m.get(key);
	}
}
