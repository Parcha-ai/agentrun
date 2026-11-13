package ai.agentrun.phoned;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The stdio binding (spec/computer/stdio.md): JSON-RPC 2.0, one UTF-8 JSON object per line, both ways. Requests run at
 * once, each on a thread of its own, and replies go out in any order. `$/cancelRequest` ends a request with `aborted`.
 * When the input ends, every request still running is cancelled and serve() returns.
 */
public final class Wire {
	/** The longest line either side reads or writes, without its newline: protocol.json's maxLineBytes. */
	public static final int MAX_LINE_BYTES = 1024 * 1024;

	public static final String CANCEL = "$/cancelRequest";

	/** What answers the methods. */
	public interface Handler {
		/** The method's result (a JSON value Json.write takes), or an RpcError. cancel says when to stop. */
		Object handle(String method, Params params, Cancel cancel) throws RpcError, InterruptedException;
	}

	/** One request's cancel: set by $/cancelRequest or the input's end; checked by the handler at each wait. */
	public static final class Cancel {
		private volatile boolean cancelled;
		private volatile Thread thread;

		public boolean cancelled() {
			return cancelled;
		}

		/** Throws aborted once the request is cancelled. */
		public void check() {
			if (cancelled) throw RpcError.aborted("the request was cancelled");
		}

		void cancel() {
			cancelled = true;
			Thread t = thread;
			if (t != null) t.interrupt();
		}

		/** A cancel that never fires, for calls made inside the driver. */
		public static Cancel none() {
			return new Cancel();
		}
	}

	private final InputStream in;
	private final OutputStream out;
	private final Handler handler;
	private final Map<Object, Cancel> running = new ConcurrentHashMap<>();
	private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
		Thread t = new Thread(r, "phoned-request");
		t.setDaemon(true);
		return t;
	});

	private Wire(InputStream in, OutputStream out, Handler handler) {
		this.in = in;
		this.out = out;
		this.handler = handler;
	}

	/** Serves requests from in until it ends; replies go to out. */
	public static void serve(InputStream in, OutputStream out, Handler handler) throws IOException {
		new Wire(in, out, handler).run();
	}

	private void run() throws IOException {
		byte[] buffer = new byte[64 * 1024];
		try {
			for (;;) {
				int n = in.read(buffer);
				if (n < 0) break;
				int start = 0;
				for (int i = 0; i < n; i++) {
					if (buffer[i] != '\n') continue;
					append(buffer, start, i - start);
					finishLine(line, over);
					line.reset();
					over = false;
					start = i + 1;
				}
				append(buffer, start, n - start);
			}
		} finally {
			for (Cancel c : running.values()) c.cancel();
			pool.shutdown();
			try {
				pool.awaitTermination(3, TimeUnit.SECONDS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		}
	}

	/** The line read so far, and whether it went over the limit (then only its start is kept, where its id is). */
	private final ByteArrayOutputStream line = new ByteArrayOutputStream();
	private boolean over;

	private void append(byte[] buffer, int from, int length) {
		if (length <= 0 || over) return;
		if (line.size() + length > MAX_LINE_BYTES) {
			line.write(buffer, from, Math.max(0, Math.min(length, 4096 - line.size())));
			over = true;
			return;
		}
		line.write(buffer, from, length);
	}

	private static final Pattern ID =Pattern.compile("\"id\"\\s*:\\s*(-?\\d+|\"(?:[^\"\\\\]|\\\\.)*\")");

	private void finishLine(ByteArrayOutputStream bytes, boolean over) {
		byte[] raw = bytes.toByteArray();
		int length = raw.length;
		if (length > 0 && raw[length - 1] == '\r') length--;
		String text = new String(raw, 0, length, StandardCharsets.UTF_8);
		if (over) {
			Object id = null;
			Matcher m = ID.matcher(text);
			if (m.find()) {
				try {
					id = Json.parse(m.group(1));
				} catch (Json.ParseError e) {
					id = null;
				}
			}
			reply(id, null, new RpcError("limit", RpcError.INVALID_REQUEST, "the request line is over the " + MAX_LINE_BYTES + "-byte limit"));
			return;
		}
		if (text.trim().isEmpty()) return;
		Object message;
		try {
			message = Json.parse(text);
		} catch (Json.ParseError e) {
			reply(null, null, new RpcError("invalid", RpcError.PARSE, "the line is not JSON: " + e.getMessage()));
			return;
		}
		if (!(message instanceof Map)) {
			reply(null, null, new RpcError("invalid", RpcError.INVALID_REQUEST, "a request is a JSON object"));
			return;
		}
		@SuppressWarnings("unchecked")
		Map<String, Object> request = (Map<String, Object>) message;
		Object id = request.get("id");
		Object method = request.get("method");
		boolean notification = !request.containsKey("id");
		if (!(method instanceof String)) {
			if (!notification) reply(id, null, new RpcError("invalid", RpcError.INVALID_REQUEST, "a request names its method"));
			return;
		}
		if (CANCEL.equals(method)) {
			Object params = request.get("params");
			if (params instanceof Map) {
				Cancel c = running.get(key(((Map<?, ?>) params).get("id")));
				if (c != null) c.cancel();
			}
			return;
		}
		// A notification of any other method asks for nothing back.
		if (notification) return;
		if (!(id instanceof Long || id instanceof String)) {
			reply(null, null, new RpcError("invalid", RpcError.INVALID_REQUEST, "a request's id is a whole number or a string"));
			return;
		}
		Cancel cancel = new Cancel();
		Object k = key(id);
		running.put(k, cancel);
		String name = (String) method;
		Object params = request.get("params");
		try {
			pool.execute(() -> {
				cancel.thread = Thread.currentThread();
				try {
					if (cancel.cancelled()) throw RpcError.aborted(name + " was cancelled");
					Object result = handler.handle(name, Params.of(params, "params"), cancel);
					if (cancel.cancelled()) throw RpcError.aborted(name + " was cancelled");
					reply(id, result == null ? Json.obj() : result, null);
				} catch (RpcError e) {
					reply(id, null, cancel.cancelled() ? RpcError.aborted(name + " was cancelled") : e);
				} catch (InterruptedException e) {
					reply(id, null, RpcError.aborted(name + " was cancelled"));
				} catch (RuntimeException | LinkageError e) {
					// A fault of the driver's own: said in words, and the connection goes on.
					reply(id, null, new RpcError("unsupported", name + " failed inside phoned: " + e));
				} finally {
					cancel.thread = null;
					Thread.interrupted();
					running.remove(k, cancel);
				}
			});
		} catch (java.util.concurrent.RejectedExecutionException e) {
			running.remove(k, cancel);
			reply(id, null, RpcError.aborted("phoned is ending"));
		}
	}

	/** Ids 7 and 7.0 are one request: a number id is kept as a long. */
	private static Object key(Object id) {
		if (id instanceof Double) return (long) (double) (Double) id;
		return id;
	}

	private void reply(Object id, Object result, RpcError error) {
		Map<String, Object> message;
		if (error == null) {
			message = Json.obj("jsonrpc", "2.0", "id", id, "result", result);
		} else {
			message = Json.obj("jsonrpc", "2.0", "id", id, "error", Json.obj("code", error.code, "message", error.getMessage(), "data", Json.obj("kind", error.kind)));
		}
		byte[] bytes;
		try {
			bytes = Json.write(message).getBytes(StandardCharsets.UTF_8);
		} catch (IllegalArgumentException e) {
			bytes = Json.write(Json.obj("jsonrpc", "2.0", "id", id, "error", Json.obj("code", RpcError.SERVER, "message", "phoned built a reply it cannot write: " + e.getMessage(), "data", Json.obj("kind", "unsupported")))).getBytes(StandardCharsets.UTF_8);
		}
		if (bytes.length > MAX_LINE_BYTES) {
			bytes = Json.write(Json.obj("jsonrpc", "2.0", "id", id, "error", Json.obj("code", RpcError.SERVER, "message", "the reply is over the " + MAX_LINE_BYTES + "-byte line limit", "data", Json.obj("kind", "limit")))).getBytes(StandardCharsets.UTF_8);
		}
		synchronized (out) {
			try {
				out.write(bytes);
				out.write('\n');
				out.flush();
			} catch (IOException e) {
				// The reader is gone; the input's end stops the rest.
			}
		}
	}
}
