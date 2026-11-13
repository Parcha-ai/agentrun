package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.map;
import static ai.agentrun.phoned.Check.yes;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** The stdio binding: lines in, replies out, errors with their kinds and codes, cancel, and the line limit. */
final class WireTest {
	private WireTest() {}

	/**
	 * Serves the lines to the handler and reads `expected` replies, each parsed, before the input ends (its end cancels
	 * what still runs, as stdio.md says). Then no other reply comes.
	 */
	static List<Map<String, Object>> serve(Wire.Handler handler, int expected, String... lines) throws Exception {
		PipedOutputStream feed = new PipedOutputStream();
		PipedInputStream in = new PipedInputStream(feed, 1 << 16);
		PipedOutputStream out = new PipedOutputStream();
		BufferedReader read = new BufferedReader(new InputStreamReader(new PipedInputStream(out, 1 << 16), StandardCharsets.UTF_8));
		Thread server = new Thread(() -> {
			try {
				Wire.serve(in, out, handler);
				out.close();
			} catch (Exception e) {
				throw new RuntimeException(e);
			}
		});
		server.start();
		// Java's pipes belong to the threads that use them: this thread writes the input and reads the replies.
		feed.write((String.join("\n", lines) + "\n").getBytes(StandardCharsets.UTF_8));
		feed.flush();
		List<Map<String, Object>> replies = new ArrayList<>();
		while (replies.size() < expected) replies.add(map(Json.parse(read.readLine())));
		feed.close();
		server.join(5000);
		yes(!server.isAlive(), "serve returns when the input ends");
		eq(null, read.readLine());
		return replies;
	}

	static final Wire.Handler ECHO = (method, params, cancel) -> {
		if (method.equals("echo")) return Json.obj("said", params.str("text"));
		if (method.equals("refuse")) throw RpcError.denied("no");
		if (method.equals("bad")) throw RpcError.invalid("bad params");
		if (method.equals("crash")) throw new IllegalStateException("boom");
		throw new RpcError("unsupported", RpcError.METHOD_NOT_FOUND, method + " is not a method");
	};

	static void testRepliesWithResultAndId() throws Exception {
		List<Map<String, Object>> r = serve(ECHO, 1, "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"echo\",\"params\":{\"text\":\"hi\"}}");
		eq(1, r.size());
		eq(7L, r.get(0).get("id"));
		eq("hi", map(r.get(0).get("result")).get("said"));
	}

	static void testErrorsCarryKindAndCode() throws Exception {
		List<Map<String, Object>> r = serve(ECHO, 4,
				"{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"refuse\"}",
				"{\"jsonrpc\":\"2.0\",\"id\":\"b\",\"method\":\"bad\"}",
				"{\"jsonrpc\":\"2.0\",\"id\":\"c\",\"method\":\"nope\"}",
				"{\"jsonrpc\":\"2.0\",\"id\":\"d\",\"method\":\"crash\"}");
		eq(4, r.size());
		for (Map<String, Object> reply : r) {
			Map<String, Object> e = map(reply.get("error"));
			Map<String, Object> data = map(e.get("data"));
			switch ((String) reply.get("id")) {
				case "a":
					eq(-32000L, e.get("code"));
					eq("denied", data.get("kind"));
					break;
				case "b":
					eq(-32602L, e.get("code"));
					eq("invalid", data.get("kind"));
					break;
				case "c":
					eq(-32601L, e.get("code"));
					eq("unsupported", data.get("kind"));
					break;
				default:
					eq("unsupported", data.get("kind"));
					yes(((String) e.get("message")).contains("failed inside phoned"), "a crash is said in words");
			}
		}
	}

	static void testParseErrorAndNonObject() throws Exception {
		// The empty line and the notification get no reply; serve() checks none came.
		List<Map<String, Object>> r = serve(ECHO, 2, "{not json", "[1,2]", "", "{\"jsonrpc\":\"2.0\",\"method\":\"echo\",\"params\":{\"text\":\"x\"}}");
		eq(null, r.get(0).get("id"));
		eq(-32700L, map(r.get(0).get("error")).get("code"));
		eq(-32600L, map(r.get(1).get("error")).get("code"));
	}

	static void testOverLimitLineKeepsItsId() throws Exception {
		char[] big = new char[Wire.MAX_LINE_BYTES + 10];
		Arrays.fill(big, 'a');
		String line = "{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"echo\",\"params\":{\"text\":\"" + new String(big) + "\"}}";
		List<Map<String, Object>> r = serve(ECHO, 2, line,"{\"jsonrpc\":\"2.0\",\"id\":43,\"method\":\"echo\",\"params\":{\"text\":\"after\"}}");
		eq(2, r.size());
		Map<String, Object> first = r.get(0).get("id").equals(42L) ? r.get(0) : r.get(1);
		eq("limit", map(map(first.get("error")).get("data")).get("kind"));
		eq(-32600L, map(first.get("error")).get("code"));
	}

	static void testCancelAbortsTheRequest() throws Exception {
		CountDownLatch started = new CountDownLatch(1);
		Wire.Handler slow = (method, params, cancel) -> {
			started.countDown();
			Thread.sleep(60_000);
			return Json.obj();
		};
		PipedOutputStream feed = new PipedOutputStream();
		PipedInputStream in = new PipedInputStream(feed, 1 << 16);
		PipedOutputStream replies = new PipedOutputStream();
		BufferedReader read = new BufferedReader(new InputStreamReader(new PipedInputStream(replies, 1 << 16), StandardCharsets.UTF_8));
		Thread server = new Thread(() -> {
			try {
				Wire.serve(in, replies, slow);
			} catch (Exception e) {
				throw new RuntimeException(e);
			}
		});
		server.start();
		feed.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"slow\"}\n".getBytes(StandardCharsets.UTF_8));
		feed.flush();
		yes(started.await(5, TimeUnit.SECONDS), "the request started");
		feed.write("{\"jsonrpc\":\"2.0\",\"method\":\"$/cancelRequest\",\"params\":{\"id\":1}}\n".getBytes(StandardCharsets.UTF_8));
		feed.flush();
		Map<String, Object> reply = map(Json.parse(read.readLine()));
		eq(1L, reply.get("id"));
		eq(-32800L, map(reply.get("error")).get("code"));
		eq("aborted", map(map(reply.get("error")).get("data")).get("kind"));
		feed.close();
		server.join(5000);
		yes(!server.isAlive(), "serve returns when the input ends");
	}

	static void testJsonRoundTripAndEscapes() throws Exception {
		String text = "{\"a\":[1,2.5,true,null,\"x\\n\\u2028\\\"\"],\"b\":{}}";
		Object v = Json.parse(text);
		eq("{\"a\":[1,2.5,true,null,\"x\\n\\u2028\\\"\"],\"b\":{}}", Json.write(v));
		eq(Json.obj("a", 1L), Json.parse("{\"a\":1}"));
		StringBuilder deep = new StringBuilder();
		for (int i = 0; i < 100; i++) deep.append('[');
		try {
			Json.parse(deep.toString());
			throw new AssertionError("a too-deep value parses");
		} catch (Json.ParseError expected) {
			// refused
		}
	}
}
