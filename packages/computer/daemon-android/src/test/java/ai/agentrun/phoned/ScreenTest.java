package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.refuses;
import static ai.agentrun.phoned.Check.yes;

import java.util.Base64;
import java.util.Map;

/** screen.shot, screen.read and screen.watch, and the secure-window refusal. */
final class ScreenTest {
	private ScreenTest() {}

	static byte[] bytes(Object b64) {
		return Base64.getDecoder().decode((String) b64);
	}

	static void testShotIsAPngAtTheScreensPixels() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> shot = phone.call("screen.shot", "{}");
		eq(1080L, shot.get("width"));
		eq(2400L, shot.get("height"));
		eq(2.0, shot.get("scale"));
		eq(true, shot.get("eof"));
		byte[] png = bytes(shot.get("data"));
		eq((long) png.length, shot.get("size"));
		eq("PNG", new String(png, 1, 3, "US-ASCII"));
		Map<String, Object> region = phone.call("screen.shot", "{\"region\":[0,2350,100,50]}");
		eq(100L, region.get("width"));
		eq(50L, region.get("height"));
		refuses("invalid", () -> phone.call("screen.shot", "{\"region\":[0,2351,100,50]}"));
		refuses("invalid", () -> phone.call("screen.shot", "{\"region\":[0.5,0,100,50]}"));
	}

	static void testReadGivesTheHeldShotThenLetsItGo() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> shot = phone.call("screen.shot", "{}");
		String id = (String) shot.get("id");
		Map<String, Object> read = phone.call("screen.read", "{\"id\":\"" + id + "\",\"offset\":8}");
		eq(true, read.get("eof"));
		byte[] whole = bytes(shot.get("data"));
		eq(whole.length - 8, bytes(read.get("data")).length);
		refuses("not_found", () -> phone.call("screen.read", "{\"id\":\"" + id + "\"}"));
		refuses("not_found", () -> phone.call("screen.read", "{\"id\":\"nope\"}"));
	}

	static void testASecureWindowIsDeniedWithItsReason() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.secure = "com.example.bank";
		String words = refuses("denied", () -> phone.call("screen.shot", "{}"));
		yes(words.contains("com.example.bank") && words.contains("FLAG_SECURE"), words);
		refuses("denied", () -> phone.call("screen.watch", "{\"after\":0,\"waitMs\":0}"));
		refuses("denied", () -> phone.call("ui.observe", "{\"image\":true}"));
	}

	static void testWatchSendsAFrameOnlyWhenTheScreenChanged() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> first = phone.call("screen.watch", "{\"after\":0,\"maxWidth\":540}");
		eq(1L, first.get("seq"));
		eq(true, first.get("changed"));
		eq("jpeg", first.get("format"));
		eq(540L, first.get("frameWidth"));
		eq(1200L, first.get("frameHeight"));
		eq(1080L, first.get("width"));
		eq(true, first.get("eof"));
		yes(!first.containsKey("id"), "a whole frame holds nothing to read");
		byte[] jpeg = bytes(first.get("data"));
		eq((byte) 0xff, jpeg[0]);
		eq((byte) 0xd8, jpeg[1]);
		Map<String, Object> same = phone.call("screen.watch", "{\"after\":1,\"waitMs\":3000,\"maxWidth\":540}");
		eq(Json.obj("seq", 1L, "changed", false, "width", 1080L, "height", 2400L), same);
		// A caller behind the newest frame gets it at once.
		eq(first, phone.call("screen.watch", "{\"after\":0}"));
		phone.device.internet();
		Map<String, Object> next = phone.call("screen.watch", "{\"after\":1,\"maxWidth\":540}");
		eq(2L, next.get("seq"));
		eq(true, next.get("changed"));
		refuses("invalid", () -> phone.call("screen.watch", "{\"after\":5}"));
	}
}
