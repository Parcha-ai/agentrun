package ai.agentrun.phoned;

import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.device.Rect;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;

/**
 * The screen group (screen.shot, screen.read, screen.watch) and the ui group's window image. Frames are taken and
 * encoded on the phone: a watch frame or an observe image is scaled there, so only the bytes asked for cross adb.
 */
public final class Shots {
	/** protocol.ts MAX_CHUNK_BYTES: the most bytes one reply carries before base64. */
	public static final int MAX_CHUNK_BYTES = 512 * 1024;
	/** An observe image's longest edge: protocol.ts MIN_IMAGE_EDGE, MAX_IMAGE_EDGE, DEFAULT_IMAGE_EDGE. */
	public static final int MIN_EDGE = 256;
	public static final int MAX_EDGE = 2048;
	public static final int DEFAULT_EDGE = 1568;
	/** A watch reads the screen at most this often, across calls too. */
	static final long WATCH_POLL_MS = 1000;
	/** The JPEG qualities an observe image steps down through until it fits one reply. */
	static final int[] IMAGE_QUALITIES = {80, 65, 50, 35, 20};

	private final Device device;
	private final SecureRandom random = new SecureRandom();

	/**
	 * The shots and watch frames screen.read reads, by id: each is dropped once read to its end, and the oldest goes
	 * when more than MAX_HELD wait. Phones' connections share one phoned, so a second shot never replaces a first one
	 * still being read.
	 */
	private static final int MAX_HELD = 16;
	private final Map<String, Held> held = new java.util.LinkedHashMap<>();
	/** The frame the cached newest answer holds, so a watch that asks another size or quality is not given it. */
	private String newestKey = "";

	private void hold(Held h) {
		held.put(h.id, h);
		while (held.size() > MAX_HELD) held.remove(held.keySet().iterator().next());
	}

	/** screen.watch's state: the newest frame's seq, its digest, and when the screen was last read. */
	private long seq;
	private byte[] digest = new byte[0];
	private long lastRead = Long.MIN_VALUE / 2;
	private Map<String, Object> newest;
	private final Object watching = new Object();

	public Shots(Device device) {
		this.device = device;
	}

	private static final class Held {
		final String id;
		final byte[] bytes;

		Held(String id, byte[] bytes) {
			this.id = id;
			this.bytes = bytes;
		}
	}

	private String newId() {
		byte[] b = new byte[6];
		random.nextBytes(b);
		StringBuilder s = new StringBuilder();
		for (byte x : b) s.append(String.format("%02x", x & 0xff));
		return s.toString();
	}

	/** A frame, refused as denied when a secure window blanked it. */
	private Device.Shot take(Rect crop, int maxEdge, String format, int quality) {
		Device.Shot s = device.screen().shot(crop, maxEdge, format, quality);
		if (s.secure != null) {
			throw RpcError.denied("the screen shows a secure window (" + s.secure + " set FLAG_SECURE): Android gives the shell user a blank frame for it, so phoned sends none");
		}
		return s;
	}

	/** screen.shot: the whole screen or a region of it, as PNG at the screen's own pixels. */
	public Map<String, Object> shot(Params p) {
		Device.Display d = device.display();
		Rect crop = null;
		if (p.has("region")) {
			Object r = p.raw("region");
			long[] v = rect(r);
			if (v == null || v[0] < 0 || v[1] < 0 || v[2] <= 0 || v[3] <= 0 || v[0] + v[2] > d.width || v[1] + v[3] > d.height) {
				throw RpcError.invalid("region " + Json.write(r) + " is not [x, y, w, h] inside the " + d.width + "x" + d.height + " screen");
			}
			crop = new Rect((int) v[0], (int) v[1], (int) (v[0] + v[2]), (int) (v[1] + v[3]));
		}
		Device.Shot s = take(crop, 0, "png", 0);
		String id = newId();
		synchronized (this) {
			hold(new Held(id, s.bytes));
		}
		byte[] first = Arrays.copyOf(s.bytes, Math.min(s.bytes.length, MAX_CHUNK_BYTES));
		return Json.obj("id", id, "size", (long) s.bytes.length, "data", b64(first), "eof", first.length == s.bytes.length,
				"width", (long) s.width, "height", (long) s.height, "scale", d.scale);
	}

	private static long[] rect(Object r) {
		if (!(r instanceof java.util.List) || ((java.util.List<?>) r).size() != 4) return null;
		long[] v = new long[4];
		for (int i = 0; i < 4; i++) {
			Object n = ((java.util.List<?>) r).get(i);
			if (!(n instanceof Long)) return null;
			v[i] = (Long) n;
		}
		return v;
	}

	/** screen.read: the rest of the held shot or watch frame, from offset. */
	public synchronized Map<String, Object> read(Params p) {
		String id = p.str("id");
		Held one = held.get(id);
		if (one == null) throw RpcError.notFound("no shot \"" + id + "\" is held: take one with screen.shot");
		long offset = p.whole("offset", 0, one.bytes.length);
		int end = (int) Math.min(one.bytes.length, offset + MAX_CHUNK_BYTES);
		byte[] data = Arrays.copyOfRange(one.bytes, (int) offset, end);
		boolean eof = end >= one.bytes.length;
		if (eof) held.remove(id);
		return Json.obj("data", b64(data), "eof", eof);
	}

	/**
	 * screen.watch: the next frame after the caller's ack, once the screen changed, as JPEG scaled on the phone to
	 * maxWidth. after older than the newest gets the newest at once; at the newest, it waits for a change until waitMs.
	 */
	public Map<String, Object> watch(Params p, Wire.Cancel cancel) throws InterruptedException {
		long after = p.whole("after", 0, Long.MAX_VALUE);
		long waitMs = p.whole("waitMs", 2000, 0, 10_000);
		int maxWidth = (int) p.whole("maxWidth", 1280, 1, 16_384);
		int quality = (int) p.whole("quality", 60, 1, 100);
		Device.Clock clock = device.clock();
		synchronized (watching) {
			if (after > seq) throw RpcError.invalid("after " + after + " is past the newest frame, " + seq);
			String key = maxWidth + "|" + quality;
			if (after < seq && newest != null) {
				if (key.equals(newestKey)) return answer();
				// Another watcher's frame is at another size or quality: this caller gets one of its own at the
				// newest seq, and the cached frame stays the other's.
				Device.Display d = device.display();
				int frameWidth = Math.min(d.width, maxWidth);
				int frameHeight = Math.max(1, (int) ((long) d.height * frameWidth / Math.max(1, d.width)));
				Device.Shot s = take(null, Math.max(frameWidth, frameHeight), "jpeg", quality);
				cancel.check();
				return frameAnswer(s, d, seq);
			}
			long deadline = clock.now() + waitMs;
			for (;;) {
				long wait = lastRead + WATCH_POLL_MS - clock.now();
				if (wait > 0) clock.sleep(wait);
				cancel.check();
				lastRead = clock.now();
				Device.Display d = device.display();
				int frameWidth = Math.min(d.width, maxWidth);
				int frameHeight = Math.max(1, (int) ((long) d.height * frameWidth / Math.max(1, d.width)));
				Device.Shot s = take(null, Math.max(frameWidth, frameHeight), "jpeg", quality);
				cancel.check();
				// The size is in the digest: a phone turned to landscape may give the same bytes, the other way round.
				byte[] now = sha256(s.width + "x" + s.height + "|" + d.width + "x" + d.height + "|" + key, s.bytes);
				if (seq == 0 || !Arrays.equals(now, digest)) {
					seq++;
					digest = now;
					newestKey = key;
					newest = frameAnswer(s, d, seq);
					return answer();
				}
				long left = deadline - clock.now();
				if (left < WATCH_POLL_MS) {
					if (left > 0) clock.sleep(left);
					cancel.check();
					return Json.obj("seq", seq, "changed", false, "width", (long) d.width, "height", (long) d.height);
				}
			}
		}
	}

	/** A watch answer carrying frame s as seq, its rest held for screen.read when it is over one chunk. */
	private Map<String, Object> frameAnswer(Device.Shot s, Device.Display d, long seq) {
		String id = newId();
		boolean whole = s.bytes.length <= MAX_CHUNK_BYTES;
		synchronized (this) {
			if (!whole) hold(new Held(id, s.bytes));
		}
		byte[] first = Arrays.copyOf(s.bytes, Math.min(s.bytes.length, MAX_CHUNK_BYTES));
		return Json.obj("seq", seq, "changed", true, "id", whole ? Json.OMIT : id, "size", (long) s.bytes.length,
				"data", b64(first), "eof", whole, "format", "jpeg", "frameWidth", (long) s.width,
				"frameHeight", (long) s.height, "width", (long) d.width, "height", (long) d.height);
	}

	private Map<String, Object> answer() {
		return new java.util.LinkedHashMap<>(newest);
	}

	/**
	 * The window's image for ui.observe: cut to the window, its longest edge at most maxEdge, as JPEG whose quality
	 * steps down until it fits one reply whole.
	 */
	public Map<String, Object> image(Rect window, int maxEdge) {
		for (int quality : IMAGE_QUALITIES) {
			Device.Shot s = take(window, maxEdge, "jpeg", quality);
			if (s.bytes.length <= MAX_CHUNK_BYTES) {
				return Json.obj("format", "jpeg", "width", (long) s.width, "height", (long) s.height, "data", b64(s.bytes));
			}
		}
		throw RpcError.limit("the window's image is over " + MAX_CHUNK_BYTES + " bytes even at JPEG quality " + IMAGE_QUALITIES[IMAGE_QUALITIES.length - 1] + ": ask for a smaller maxEdge");
	}

	static String b64(byte[] b) {
		return Base64.getEncoder().encodeToString(b);
	}

	private static byte[] sha256(String prefix, byte[] bytes) {
		try {
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			md.update(prefix.getBytes(java.nio.charset.StandardCharsets.UTF_8));
			md.update(bytes);
			return md.digest();
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
