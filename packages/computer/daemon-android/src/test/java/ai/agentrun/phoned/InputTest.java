package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.map;
import static ai.agentrun.phoned.Check.refuses;
import static ai.agentrun.phoned.Check.yes;

import ai.agentrun.phoned.device.Device;
import ai.agentrun.phoned.fake.FakeDevice;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Keys, input.actions, and the settle that follows an act. */
final class InputTest {
	private InputTest() {}

	static Map<String, Object> failed(Map<String, Object> result) {
		return map(result.get("failed"));
	}

	static void testKeysAreTheTableOrOnePrintableCharacter() throws Exception {
		eq("[66,0]", Json.write(toList(Keys.key("enter"))));
		eq("[122,0]", Json.write(toList(Keys.key("home"))));
		eq("[29,0]", Json.write(toList(Keys.key("a"))));
		eq("[29,65]", Json.write(toList(Keys.key("A"))));
		eq("[8,65]", Json.write(toList(Keys.key("!"))));
		eq("[81,0]", Json.write(toList(Keys.key("+"))));
		eq("[142,0]", Json.write(toList(Keys.key("f12"))));
		refuses("invalid", () -> Keys.key("é"));
		refuses("invalid", () -> Keys.key("Enter"));
		refuses("invalid", () -> Keys.chord("ctrl+"));
		eq(3, Keys.chord("ctrl+alt+delete").length);
	}

	static List<Object> toList(int[] v) {
		List<Object> out = new ArrayList<>();
		for (int x : v) out.add((long) x);
		return out;
	}

	static void testTapsSwipesAndPressesInScreenPixels() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> done = phone.call("input.actions", "{\"actions\":["
				+ "{\"type\":\"tap\",\"at\":[100,2300],\"count\":2},"
				+ "{\"type\":\"swipe\",\"path\":[[10,10],[10,500.4]]},"
				+ "{\"type\":\"long_press\",\"at\":[5,5]},"
				+ "{\"type\":\"pinch\",\"at\":[540,1200],\"scale\":2},"
				+ "{\"type\":\"button\",\"name\":\"back\"}]}");
		eq(Json.obj("done", 5L), done);
		eq(Arrays.asList("tap 100,2300", "tap 100,2300", "touch 10,10;10,500 300ms", "touch 5,5;5,5 800ms",
				"pinch 432,1200+648,1200 to 324,1200+756,1200 400ms", "key 4/0"), phone.device.log);
	}

	static void testKeysTypeAndHold() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> done = phone.call("input.actions", "{\"actions\":["
				+ "{\"type\":\"key\",\"keys\":[\"ctrl\",\"a\"]},"
				+ "{\"type\":\"key\",\"keys\":[\"backspace\"],\"repeat\":2},"
				+ "{\"type\":\"type\",\"text\":\"hi\"},"
				+ "{\"type\":\"type\",\"text\":\"héllo ✓\"},"
				+ "{\"type\":\"hold\",\"keys\":[\"shift\"],\"ms\":100}]}");
		eq(Json.obj("done", 5L), done);
		eq(Arrays.asList("down 113/12288", "key 29/12288", "up 113/0", "key 67/0", "key 67/0", "keys hi", "paste héllo ✓", "down 59/65", "up 59/0"), phone.device.log);
	}

	static void testTheBatchIsCheckedWholeFirst() throws Exception {
		Check.Phone phone = new Check.Phone();
		String tap = "{\"type\":\"tap\",\"at\":[1,1]}";
		Object[][] cases = {
			{"{\"actions\":[" + tap + ",{\"type\":\"click\"}]}", 1L, "unsupported"},
			{"{\"actions\":[" + tap + ",{\"type\":\"tap\",\"at\":[1080,5]}]}", 1L, "invalid"},
			{"{\"actions\":[" + tap + ",{\"type\":\"key\",\"keys\":[\"a\"],\"repeat\":101}]}", 1L, "limit"},
			{"{\"actions\":[{\"type\":\"wait\",\"ms\":200000},{\"type\":\"wait\",\"ms\":200000}]}", 1L, "limit"},
			{"{\"actions\":[" + tap + ",{\"type\":\"jump\"}]}", 1L, "invalid"},
			{"{\"actions\":[{\"type\":\"key\",\"keys\":[\"hyper\"]}]}", 0L, "invalid"},
			{"{\"actions\":[{\"type\":\"tap\",\"at\":[1,1],\"count\":3}]}", 0L, "invalid"},
			{"{\"actions\":[{\"type\":\"button\",\"name\":\"menu\"}]}", 0L, "invalid"},
			{"{\"actions\":[{\"type\":\"pinch\",\"at\":[1,1],\"scale\":0}]}", 0L, "invalid"},
			{"{\"actions\":\"tap\"}", 0L, "invalid"},
		};
		for (Object[] c : cases) {
			Map<String, Object> result = phone.call("input.actions", (String) c[0]);
			eq(0L, result.get("done"));
			eq(c[1], failed(result).get("index"));
			eq(c[2], failed(result).get("kind"));
		}
		StringBuilder many = new StringBuilder("{\"actions\":[");
		for (int i = 0; i < 101; i++) many.append(i > 0 ? "," : "").append(tap);
		eq("limit", failed(phone.call("input.actions", many + "]}")).get("kind"));
		yes(phone.device.log.isEmpty(), "nothing ran: " + phone.device.log);
	}

	static void testACancelledBatchSaysWhereItStopped() throws Exception {
		FakeDevice device = new FakeDevice(true);
		Actions actions = new Actions(device, new Object());
		Wire.Cancel cancel = new Wire.Cancel();
		cancel.cancel();
		Map<String, Object> result = actions.run(Params.of(Json.parse("{\"actions\":[{\"type\":\"tap\",\"at\":[1,1]}]}"), "params"), cancel);
		eq(0L, result.get("done"));
		eq("aborted", failed(result).get("kind"));
		yes(device.log.isEmpty(), "nothing ran");
	}

	/** An accessibility stream that is busy for the first `busy` reads, then still. */
	static Device.Accessibility stream(int busy) {
		return new Device.Accessibility() {
			int reads;
			long events;

			@Override
			public List<Device.AxWindow> windows() {
				return new ArrayList<>();
			}

			@Override
			public long events() {
				if (reads++ < busy) events++;
				return events;
			}

			@Override
			public int framesSince(int windowId) {
				return 0;
			}

			@Override
			public boolean global(String nav) {
				return false;
			}
		};
	}

	static void testSettleWaitsForQuietOrTheCap() throws Exception {
		Device.Clock clock = new FakeDevice(true).clock();
		long start = clock.now();
		yes(Settle.quiet(stream(0), clock, -1, 3000, Wire.Cancel.none()), "a still screen settles");
		long still = clock.now() - start;
		yes(still >= Settle.QUIET_MS && still < Settle.QUIET_MS + 50, "settled after " + still + " ms");
		start = clock.now();
		yes(Settle.quiet(stream(10), clock, -1, 3000, Wire.Cancel.none()), "a screen that stops settles");
		yes(clock.now() - start > still, "after it stopped");
		start = clock.now();
		yes(!Settle.quiet(stream(Integer.MAX_VALUE), clock, -1, 1000, Wire.Cancel.none()), "a spinner reaches the cap");
		yes(clock.now() - start >= 1000, "at the cap");
		yes(Settle.sign(stream(1), clock, -1, 0, Wire.Cancel.none()), "an event is a sign");
		start = clock.now();
		yes(!Settle.sign(stream(0), clock, -1, 0, Wire.Cancel.none()), "no sign");
		yes(clock.now() - start >= Settle.SIGN_MS, "after SIGN_MS");
	}
}
