package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.list;
import static ai.agentrun.phoned.Check.map;
import static ai.agentrun.phoned.Check.refuses;
import static ai.agentrun.phoned.Check.yes;

import ai.agentrun.phoned.fake.FakeDevice;
import ai.agentrun.phoned.fake.FakeNode;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** ui.observe and ui.act over the scripted Settings. */
final class UiTest {
	private UiTest() {}

	static Map<String, Object> step(Map<String, Object> acted, int i) {
		return map(list(acted, "steps").get(i));
	}

	static void testObserveNamesRowsFromTheirChildren() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		eq("s1", seen.get("state"));
		eq(Json.obj("id", "com.android.settings", "name", "Settings"), seen.get("app"));
		Map<String, Object> window = map(seen.get("window"));
		eq("10", window.get("id"));
		eq("[0,0,540,1200]", Json.write(window.get("bounds")));
		Map<String, Object> row = phone.node(seen, "Network & internet");
		eq("button", row.get("role"));
		eq("Mobile, Wi-Fi, hotspot", row.get("desc"));
		eq(null, row.get("value"));
		// 0,300 to 1080,500 pixels at 2 pixels a point.
		eq("[0,150,540,100]", Json.write(row.get("bounds")));
		eq(Arrays.asList("ACTION_CLICK"), row.get("actions"));
		// The row's texts are its name and value, so they are not listed again; the hidden System row is not listed at all.
		for (Object n : list(seen, "nodes")) {
			Object name = map(n).get("name");
			yes(!"Mobile, Wi-Fi, hotspot".equals(name) && !"System".equals(name), "listed again: " + name);
		}
		eq(false, seen.get("truncated"));
	}

	static void testCompactKeepsParentsAndFullKeepsAll() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		Map<String, Object> row = phone.node(seen, "Network & internet");
		Map<String, Object> listNode = null;
		for (Object n : list(seen, "nodes")) if (map(n).get("ref").equals(row.get("parent"))) listNode = map(n);
		yes(listNode != null, "the row's parent is listed");
		eq("scrollarea", listNode.get("role"));
		// The id as the app named it, without the package that holds it.
		eq("recycler_view", listNode.get("id"));
		yes(listNode.containsKey("parent"), "the list's own parent (the window's root) is listed too");
		// The zero-size layout is dropped in both forms.
		Map<String, Object> full = phone.call("ui.observe", "{\"full\":true}");
		yes(list(full, "nodes").size() > list(seen, "nodes").size(), "full lists more");
		phone.node(full, "Mobile, Wi-Fi, hotspot");
		// The System row's title, scrolled out below the window: offscreen, a line on the window's bottom edge.
		Map<String, Object> system = phone.node(full, "System");
		eq(Arrays.asList("offscreen"), system.get("flags"));
		eq("[80,1200,370,0]", Json.write(system.get("bounds")));
		for (Object n : list(full, "nodes")) {
			String b = Json.write(map(n).get("bounds"));
			Object flags = map(n).get("flags");
			yes(flags != null && ((List<?>) flags).contains("offscreen") || !b.endsWith(",0,0]") && !b.endsWith(",0]"), "a zero-size node is listed: " + b);
		}
	}

	static void testRefsStayStableAndDiffSince() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> first = phone.call("ui.observe", "{}");
		Map<String, Object> again = phone.call("ui.observe", "{\"since\":\"s1\"}");
		eq(phone.node(first, "Network & internet").get("ref"), phone.node(again, "Network & internet").get("ref"));
		eq(Json.obj("added", Arrays.asList(), "removed", Arrays.asList(), "changed", Arrays.asList()), again.get("diff"));
		phone.device.search.text = "Search";
		Map<String, Object> third = phone.call("ui.observe", "{\"since\":\"s2\"}");
		eq(Arrays.asList(phone.node(third, "Search").get("ref")), map(third.get("diff")).get("changed"));
		// A state no longer held gives no diff, not a refusal.
		yes(!phone.call("ui.observe", "{\"since\":\"s999\"}").containsKey("diff"), "no diff for an unknown state");
	}

	static void testObserveRefusesUnknownFieldsAndBadImages() throws Exception {
		Check.Phone phone = new Check.Phone();
		refuses("invalid", () -> phone.call("ui.observe", "{\"depth\":3}"));
		refuses("invalid", () -> phone.call("ui.observe", "{\"target\":{\"pid\":1}}"));
		refuses("limit", () -> phone.call("ui.observe", "{\"image\":{\"maxEdge\":100}}"));
		refuses("not_found", () -> phone.call("ui.observe", "{\"target\":{\"app\":\"com.example.none\"}}"));
	}

	static void testObserveImageIsTheWindowScaledOnThePhone() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{\"image\":{\"maxEdge\":600}}");
		Map<String, Object> image = map(seen.get("image"));
		eq("jpeg", image.get("format"));
		eq(270L, image.get("width"));
		eq(600L, image.get("height"));
		phone.device.features.put("ui.tree", "UiAutomation is held by another client");
		String words = refuses("denied", () -> phone.call("ui.observe", "{\"image\":true}"));
		yes(words.contains("ui.tree is off here: UiAutomation is held by another client") && words.contains("ui.image is off here"), words);
		refuses("denied", () -> phone.call("ui.observe", "{}"));
	}

	static void testPressByRefIsSemanticAndExpectIsMet() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		String ref = (String) phone.node(seen, "Network & internet").get("ref");
		// "Internet" is the next page's alone (Settings' row says "Wi-Fi" in its desc), so met says the press went through.
		Map<String, Object> acted = phone.call("ui.act", "{\"state\":\"s1\",\"steps\":[{\"press\":\"" + ref + "\"}],\"expect\":{\"text\":\"Internet\"}}");
		eq(Json.obj("route", "semantic", "verified", true), step(acted, 0));
		eq("met", acted.get("expect"));
		eq(true, acted.get("changed"));
		eq("s2", acted.get("state"));
		eq(Arrays.asList("ACTION_CLICK"), phone.device.network.performed);
		yes(phone.device.log.isEmpty(), "no input was injected: " + phone.device.log);
	}

	static void testAGoneRefIsStaleAndEndsTheSteps() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		String network = (String) phone.node(seen, "Network & internet").get("ref");
		Map<String, Object> acted = phone.call("ui.act", "{\"steps\":[{\"press\":\"" + network + "\"},{\"press\":\"" + network + "\"},{\"nav\":\"back\"}],\"expect\":{\"text\":\"Internet\"}}");
		List<Object> steps = list(acted, "steps");
		eq(2, steps.size());
		eq("stale", map(map(steps.get(1)).get("error")).get("kind"));
		yes(!acted.containsKey("expect"), "no expect after a refused step");
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"press\":\"@e999\"}]}"));
	}

	static void testPointsAreBoundToTheirState() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("ui.observe", "{}");
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"click\":[270,200]}]}"));
		// Without foreground, a tap at a point is refused as denied, with the way out in words.
		Map<String, Object> denied = phone.call("ui.act", "{\"state\":\"s1\",\"steps\":[{\"click\":[270,200]}]}");
		Map<String, Object> error = map(step(denied, 0).get("error"));
		eq("denied", error.get("kind"));
		yes(((String) error.get("message")).contains("foreground: true"), (String) error.get("message"));
		// The row moved down since s1: what is under the point changed.
		phone.device.network.bounds = new ai.agentrun.phoned.device.Rect(0, 320, 1080, 520);
		Map<String, Object> stale = phone.call("ui.act", "{\"state\":\"s1\",\"foreground\":true,\"steps\":[{\"click\":[270,155]}]}");
		eq("stale", map(step(stale, 0).get("error")).get("kind"));
		Map<String, Object> fresh = phone.call("ui.observe", "{}");
		Map<String, Object> tapped = phone.call("ui.act", "{\"state\":\"" + fresh.get("state") + "\",\"foreground\":true,\"steps\":[{\"click\":[270,200]}],\"expect\":{\"text\":\"Internet\"}}");
		eq(Json.obj("route", "foreground", "verified", true), step(tapped, 0));
		eq("met", tapped.get("expect"));
		// Window point (270, 200) is pixel (541, 401), the middle of the point's pixels.
		eq(Arrays.asList("tap 541,401"), phone.device.log);
		refuses("invalid", () -> phone.call("ui.act", "{\"state\":\"s1\",\"steps\":[{\"click\":[1.5,2]}]}"));
	}

	static void testSetTextAndSwitchesAreSemanticAndReadBack() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.internet();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		Map<String, Object> field = phone.node(seen, "Network name");
		eq("textbox", field.get("role"));
		Map<String, Object> wifiRow = phone.node(seen, "Wi-Fi");
		eq("Home network", wifiRow.get("desc"));
		Map<String, Object> toggle = null;
		for (Object n : list(seen, "nodes")) if ("switch".equals(map(n).get("role"))) toggle = map(n);
		yes(toggle != null, "the row's own switch is listed");
		eq(wifiRow.get("ref"), toggle.get("parent"));
		eq(Arrays.asList("checked"), toggle.get("flags"));
		Map<String, Object> acted = phone.call("ui.act", "{\"steps\":[{\"set\":\"" + field.get("ref") + "\",\"value\":\"Café\"},{\"set\":\"" + toggle.get("ref") + "\",\"value\":\"off\"},{\"set\":\"" + toggle.get("ref") + "\",\"value\":\"off\"}]}");
		eq(Json.obj("route", "semantic", "verified", true), step(acted, 0));
		eq(Json.obj("route", "semantic", "verified", true), step(acted, 1));
		eq(Json.obj("route", "semantic", "verified", true), step(acted, 2));
		eq(false, phone.device.wifi.checked);
		eq(Arrays.asList("ACTION_CLICK"), phone.device.wifi.performed);
		Map<String, Object> bad = phone.call("ui.act", "{\"steps\":[{\"set\":\"" + toggle.get("ref") + "\",\"value\":\"maybe\"}]}");
		eq("invalid", map(step(bad, 0).get("error")).get("kind"));
	}

	static void testSecureValuesAreNeverSent() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.internet();
		Map<String, Object> seen = phone.call("ui.observe", "{\"full\":true}");
		Map<String, Object> secret = phone.node(seen, "Password");
		eq(Arrays.asList("secure"), secret.get("flags"));
		yes(!secret.containsKey("value"), "a secure field sends no value");
		yes(!Json.write(seen).contains("hunter2"), "the password is nowhere in the reply");
	}

	static void testTypeIsSemanticWhenItCanBe() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.internet();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		String field = (String) phone.node(seen, "Network name").get("ref");
		Map<String, Object> acted = phone.call("ui.act", "{\"steps\":[{\"type\":\"ab\",\"into\":\"" + field + "\"},{\"type\":\"c\",\"into\":\"" + field + "\"}],\"expect\":{\"ref\":\"" + field + "\",\"text\":\"abc\"}}");
		eq(Json.obj("route", "semantic", "verified", true), step(acted, 1));
		eq("met", acted.get("expect"));
		// The password field cannot be read back, so typing into it is the keyboard's job: foreground only.
		String secret = (String) phone.node(phone.call("ui.observe", "{\"full\":true}"), "Password").get("ref");
		Map<String, Object> denied = phone.call("ui.act", "{\"steps\":[{\"type\":\"x\",\"into\":\"" + secret + "\"}]}");
		eq("denied", map(step(denied, 0).get("error")).get("kind"));
		Map<String, Object> typed = phone.call("ui.act", "{\"foreground\":true,\"steps\":[{\"type\":\"x\",\"into\":\"" + secret + "\"}]}");
		eq(Json.obj("route", "foreground", "verified", true), step(typed, 0));
	}

	static void testKeysNeedForegroundAndNavIsSemantic() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("ui.observe", "{}");
		eq("denied", map(step(phone.call("ui.act", "{\"steps\":[{\"key\":\"ctrl+a\"}]}"), 0).get("error")).get("kind"));
		phone.call("ui.act", "{\"foreground\":true,\"steps\":[{\"key\":\"ctrl+shift+T\"}]}");
		eq(Arrays.asList("down 113/12288", "down 59/12353", "key 48/12353", "up 59/12288", "up 113/0"), phone.device.log);
		phone.device.log.clear();
		phone.device.internet();
		Map<String, Object> back = phone.call("ui.act", "{\"steps\":[{\"nav\":\"back\"}],\"expect\":{\"text\":\"Network & internet\"}}");
		eq("semantic", step(back, 0).get("route"));
		eq("met", back.get("expect"));
		eq(Arrays.asList("global back"), phone.device.log);
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"key\":\"hyper+a\"}]}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"nav\":\"menu\"}]}"));
	}

	static void testScrollBySemanticActionOrSwipe() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		String list = null;
		for (Object n : list(seen, "nodes")) if ("scrollarea".equals(map(n).get("role"))) list = (String) map(n).get("ref");
		Map<String, Object> semantic = phone.call("ui.act", "{\"steps\":[{\"scroll\":\"" + list + "\",\"dy\":300}]}");
		eq("semantic", step(semantic, 0).get("route"));
		Map<String, Object> list2 = null;
		Map<String, Object> swiped = phone.call("ui.act", "{\"foreground\":true,\"steps\":[{\"scroll\":\"" + list + "\",\"dy\":300}]}");
		eq("foreground", step(swiped, 0).get("route"));
		// 300 points is 600 pixels up from the list's middle, held still at the end.
		eq(Arrays.asList("touch 540,1650;540,1050;540,1050 600ms"), phone.device.log);
		yes(list2 == null, "");
	}

	static void testActChecksTheWholeCallFirst() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("ui.observe", "{}");
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[]}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"press\":\"@e1\",\"nav\":\"back\"}]}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[{\"press\":\"@e1\",\"value\":\"x\"}]}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"gone\":true}}"));
		refuses("limit", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"text\":\"x\",\"timeoutMs\":60001}}"));
		StringBuilder many = new StringBuilder("{\"steps\":[");
		for (int i = 0; i < 101; i++) many.append(i > 0 ? "," : "").append("{\"nav\":\"back\"}");
		refuses("limit", () -> phone.call("ui.act", many + "]}"));
		refuses("limit", () -> phone.call("ui.act", "{\"state\":\"s1\",\"steps\":[{\"drag\":[[1,1],[2,2]],\"ms\":200000},{\"drag\":[[1,1],[2,2]],\"ms\":200000}]}"));
		yes(phone.device.log.isEmpty(), "nothing ran");
	}

	static void testAnExpectAloneWaitsAndGoneInverts() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("ui.observe", "{}");
		Map<String, Object> unmet = phone.call("ui.act", "{\"steps\":[],\"expect\":{\"text\":\"Bluetooth on\",\"timeoutMs\":500}}");
		eq("unmet", unmet.get("expect"));
		eq(Arrays.asList(), unmet.get("steps"));
		eq(false, unmet.get("changed"));
		eq("met", phone.call("ui.act", "{\"steps\":[],\"expect\":{\"text\":\"Bluetooth on\",\"gone\":true}}").get("expect"));
		eq("met", phone.call("ui.act", "{\"steps\":[],\"expect\":{\"text\":\"Bluetooth, pairing\"}}").get("expect"));
	}

	static void testAWindowExpectWaitsForTheAppsMainWindowAndStandsAlone() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + "}");
		String home = (String) map(seen.get("window")).get("id");
		String next = null;
		for (Object n : list(seen, "nodes")) if ("next".equals(map(n).get("id"))) next = (String) map(n).get("ref");
		// No window of that title comes: unmet after its timeout, never not_found.
		eq("unmet", phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"title\":\"No such window\"},\"timeoutMs\":300}}").get("expect"));
		// A phone's windows are ordinary ones: a dialog is never met, and a window is.
		eq("unmet", phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"role\":\"dialog\"},\"timeoutMs\":300}}").get("expect"));
		eq("met", phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"role\":\"window\"}}}").get("expect"));
		// Next opens the second page, a new window of the app: the expect waits for it and answers its state.
		Map<String, Object> second = phone.call("ui.act", "{" + target + ",\"steps\":[{\"press\":\"" + next + "\"}],\"expect\":{\"window\":{\"title\":\"Second page\"}}}");
		eq("met", second.get("expect"));
		eq(true, second.get("changed"));
		Map<String, Object> now = phone.call("ui.observe", "{" + target + "}");
		eq("Second page", map(now.get("window")).get("title"));
		yes(!home.equals(map(now.get("window")).get("id")), "the second page is a window of its own");
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"window\":{}}}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"window\":{\"title\":\"x\"},\"text\":\"x\"}}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"window\":{\"name\":\"x\"}}}"));
		refuses("invalid", () -> phone.call("ui.act", "{\"steps\":[],\"expect\":{\"window\":{\"role\":\"pane\"}}}"));
	}

	static void testAWindowExpectMayBeginBeforeItsAppHasAWindow() throws Exception {
		Check.Phone phone = new Check.Phone();
		// The app is starting and its window is not in the tree yet: what a window expect alone waits for.
		phone.device.windowLagMs = 600;
		phone.device.apps().launch(FakeDevice.FIXTURE, null);
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		refuses("not_found", () -> phone.call("ui.observe", "{" + target + "}"));
		Map<String, Object> waited = phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"title\":\"UI fixture\"}}}");
		eq("met", waited.get("expect"));
		eq(true, waited.get("changed"));
		Map<String, Object> answered = phone.call("ui.observe", "{" + target + ",\"since\":\"" + waited.get("state") + "\"}");
		eq("UI fixture", map(answered.get("window")).get("title"));
		eq(0, list(map(answered.get("diff")), "added").size());
		// An act with steps needs its window to run them on: not_found, as before.
		phone.device.apps().terminate(FakeDevice.FIXTURE);
		phone.device.apps().launch(FakeDevice.FIXTURE, null);
		refuses("not_found", () -> phone.call("ui.act", "{" + target + ",\"steps\":[{\"key\":\"enter\"}],\"expect\":{\"window\":{\"title\":\"UI fixture\"}}}"));
	}

	static void testAWindowExpectIsJudgedOnTheFinalViewItAnswers() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + "}");
		String next = null;
		for (Object n : list(seen, "nodes")) if ("next".equals(map(n).get("id"))) next = (String) map(n).get("ref");
		// The second page shows, then the app leaves it while the act settles: a look that once held never decides the
		// act. The answer is unmet, and its state is the window the phone shows.
		phone.device.secondStaysMs = FakeDevice.NEXT_ANIMATE_MS + 50;
		Map<String, Object> flashed = phone.call("ui.act", "{" + target + ",\"steps\":[{\"press\":\"" + next + "\"}],\"expect\":{\"window\":{\"title\":\"Second page\"},\"timeoutMs\":1000}}");
		eq("unmet", flashed.get("expect"));
		Map<String, Object> now = phone.call("ui.observe", "{" + target + ",\"since\":\"" + flashed.get("state") + "\"}");
		eq("UI fixture", map(now.get("window")).get("title"));
		eq(0, list(map(now.get("diff")), "added").size());
		// A second page that stays is met, and answers its own state. The fixture's home window is a new one, with new refs.
		phone.device.secondStaysMs = 0;
		String again = null;
		for (Object n : list(phone.call("ui.observe", "{" + target + "}"), "nodes")) if ("next".equals(map(n).get("id"))) again = (String) map(n).get("ref");
		yes(again != null, "the fixture's home window has its Next");
		Map<String, Object> stayed = phone.call("ui.act", "{" + target + ",\"steps\":[{\"press\":\"" + again + "\"}],\"expect\":{\"window\":{\"title\":\"Second page\"},\"timeoutMs\":1000}}");
		eq("met", stayed.get("expect"));
		Map<String, Object> then = phone.call("ui.observe", "{" + target + ",\"since\":\"" + stayed.get("state") + "\"}");
		eq("Second page", map(then.get("window")).get("title"));
		eq(0, list(map(then.get("diff")), "added").size());
	}

	static void testAWindowTargetsExpectReadsItsOwnAppsMainWindow() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String fixture = (String) map(phone.call("ui.observe", "{\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}}").get("window")).get("id");
		// Another app's window comes in front of the fixture's.
		FakeNode root = FakeNode.of("android.widget.FrameLayout").at(0, 0, 1080, 2400).pkg("com.example.other");
		synchronized (phone.device) {
			phone.device.windows.add(0, new FakeDevice.FakeWindow(99, "Other app", new ai.agentrun.phoned.device.Rect(0, 0, 1080, 2400), root));
			phone.device.changed();
		}
		String target = "\"target\":{\"window\":\"" + fixture + "\"}";
		// A wait aimed at the fixture's window reads the fixture's main window, never the app in front.
		eq("unmet", phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"title\":\"Other app\"},\"timeoutMs\":300}}").get("expect"));
		Map<String, Object> met = phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"window\":{\"title\":\"UI fixture\"},\"timeoutMs\":300}}");
		eq("met", met.get("expect"));
		Map<String, Object> answered = phone.call("ui.observe", "{" + target + ",\"since\":\"" + met.get("state") + "\"}");
		eq("UI fixture", map(answered.get("window")).get("title"));
	}

	static void testASetThatTheAppTakesBackIsNotVerified() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.internet();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		Map<String, Object> toggle = null;
		for (Object n : list(seen, "nodes")) if ("switch".equals(map(n).get("role"))) toggle = map(n);
		yes(toggle != null, "the row's own switch is listed");
		// The app turns Wi-Fi back on a moment after the switch is set off: the set reads back at once, and is not held.
		FakeNode wifi = phone.device.wifi;
		wifi.on(a -> {
			if (a.equals("ACTION_CLICK") && !wifi.checked) phone.device.after(UiDriver.SET_HOLD_MS / 2, () -> {
				wifi.checked = true;
				phone.device.changed();
			});
		});
		Map<String, Object> acted = phone.call("ui.act", "{\"steps\":[{\"set\":\"" + toggle.get("ref") + "\",\"value\":\"off\"}]}");
		eq(Json.obj("route", "semantic", "verified", false), step(acted, 0));
		eq(true, wifi.checked);
		// One the app keeps holds.
		wifi.on(a -> {});
		Map<String, Object> kept = phone.call("ui.act", "{\"steps\":[{\"set\":\"" + toggle.get("ref") + "\",\"value\":\"off\"}]}");
		eq(Json.obj("route", "semantic", "verified", true), step(kept, 0));
		eq(false, wifi.checked);
	}

	static void testRowNamingSkipsActionableChildren() {
		FakeNode row = FakeNode.of("android.widget.LinearLayout").at(0, 0, 100, 100).tappable();
		FakeNode box = FakeNode.of("android.widget.CheckBox").at(80, 10, 95, 30).text("Remember");
		box.checkable = true;
		row.add(FakeNode.of("android.widget.TextView").at(0, 0, 70, 50).text("Keep me signed in"), box);
		Outline o = Outline.of(row, false);
		eq(2, o.entries.size());
		eq("Keep me signed in", o.entries.get(0).name);
		eq("checkbox", o.entries.get(1).role);
		eq(o.entries.get(0), o.entries.get(1).parent);
	}

	static void testARowHalfShownIsCutToTheWindow() throws Exception {
		Check.Phone phone = new Check.Phone();
		// Security & privacy's row is pixels 2300 to 2500 of a 2400-pixel window: half of it shows.
		Map<String, Object> row = phone.node(phone.call("ui.observe", "{}"), "Security & privacy");
		eq("[0,1150,540,50]", Json.write(row.get("bounds")));
		eq(null, row.get("flags"));
	}

	static void testAStepIsVerifiedOnlyWhenTheWindowReadsBackChanged() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		// Connected devices' row takes its click and shows nothing new: the click ran, and nothing verifies it.
		String still = (String) phone.node(seen, "Connected devices").get("ref");
		eq(Json.obj("route", "semantic", "verified", false), step(phone.call("ui.act", "{\"steps\":[{\"press\":\"" + still + "\"}]}"), 0));
		// A frame and an event with nothing changed are no readback either.
		phone.device.changed();
		eq(Json.obj("route", "semantic", "verified", false), step(phone.call("ui.act", "{\"steps\":[{\"press\":\"" + still + "\"}]}"), 0));
	}

	static void testTheFixtureCanvasTakesOnlyTheForegroundRoute() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + "}");
		eq("[" + (1080 - 640) / 4 + "," + (2400 - 640) / 4 + ",320,320]", Json.write(map(seen.get("window")).get("bounds")));
		Map<String, Object> canvas = null;
		for (Object n : list(seen, "nodes")) if ("canvas".equals(map(n).get("id"))) canvas = map(n);
		yes(canvas != null, "the canvas is listed by its id");
		eq("image", canvas.get("role"));
		eq("Canvas", canvas.get("name"));
		eq("0", canvas.get("value"));
		yes(!canvas.containsKey("actions"), "the canvas has no action a caller would perform: " + canvas.get("actions"));
		String click = "{" + target + ",\"steps\":[{\"click\":\"" + canvas.get("ref") + "\"}]";
		// No click action to try: without foreground: true the tap is denied, and nothing is injected.
		Map<String, Object> error = map(step(phone.call("ui.act", click + "}"), 0).get("error"));
		eq("denied", error.get("kind"));
		yes(((String) error.get("message")).contains("pass foreground: true"), (String) error.get("message"));
		yes(phone.device.log.equals(Arrays.asList("launch " + FakeDevice.FIXTURE)), "nothing was injected: " + phone.device.log);
		// With it, one tap at the canvas's middle, verified by reading its count back.
		eq(Json.obj("route", "foreground", "verified", true), step(phone.call("ui.act", click + ",\"foreground\":true}"), 0));
		eq("1", phone.device.canvas.state);
	}

	static void testTheFixtureShowsItsEffectsLaterAndBackLeavesIt() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + "}");
		String save = null;
		String next = null;
		for (Object n : list(seen, "nodes")) {
			if ("save".equals(map(n).get("id"))) save = (String) map(n).get("ref");
			if ("next".equals(map(n).get("id"))) next = (String) map(n).get("ref");
		}
		// Saved shows SAVED_MS after the press: only the expect, polling, sees it.
		Map<String, Object> saved = phone.call("ui.act", "{" + target + ",\"steps\":[{\"press\":\"" + save + "\"}],\"expect\":{\"text\":\"Saved\"}}");
		eq("met", saved.get("expect"));
		Map<String, Object> second = phone.call("ui.act", "{" + target + ",\"steps\":[{\"press\":\"" + next + "\"}],\"expect\":{\"ref\":\"" + next + "\",\"gone\":true}}");
		eq("met", second.get("expect"));
		eq("Second page", phone.device.windows.get(0).title);
		Map<String, Object> home = phone.call("ui.act", "{" + target + ",\"steps\":[{\"nav\":\"back\"}],\"expect\":{\"text\":\"UI fixture\"}}");
		eq("met", home.get("expect"));
		// Back on its first page leaves the app for the home screen; terminate does too.
		phone.call("ui.act", "{\"steps\":[{\"nav\":\"back\"}]}");
		eq(FakeDevice.LAUNCHER, map(phone.call("apps.list", "{}")).get("foreground"));
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		phone.call("apps.terminate", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		eq(FakeDevice.LAUNCHER, map(phone.call("apps.list", "{}")).get("foreground"));
	}

	static void testLaunchAnswersOnceTheAppsWindowIsOnTheScreenAndStill() throws Exception {
		Check.Phone phone = new Check.Phone();
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		// As on a phone: the task is in front before the window reaches the tree, and the window then animates in.
		phone.device.windowLagMs = 400;
		phone.device.openAnimationMs = 300;
		long before = phone.device.clock().now();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		long took = phone.device.clock().now() - before;
		yes(took >= 700 && took < 1000, "apps.launch waited for the window and its animation: " + took + " ms");
		// A look right after finds the window in place, and an act of no steps on it changes nothing.
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + "}");
		eq("[110,440,320,320]", Json.write(map(seen.get("window")).get("bounds")));
		Map<String, Object> still = phone.call("ui.act", "{" + target + ",\"steps\":[],\"expect\":{\"text\":\"No such text\",\"timeoutMs\":300}}");
		eq("unmet", still.get("expect"));
		eq(false, still.get("changed"));
		// An app whose window never comes: a timeout after LAUNCH_WINDOW_MS, in words that name what the tree shows.
		phone.device.windowLagMs = 60_000;
		before = phone.device.clock().now();
		String late = refuses("timeout", () -> phone.call("apps.launch", "{\"id\":\"" + FakeDevice.SETTINGS + "\"}"));
		long waited = phone.device.clock().now() - before;
		yes(waited >= UiDriver.LAUNCH_WINDOW_MS && waited < UiDriver.LAUNCH_WINDOW_MS + 200, "waited " + waited + " ms");
		yes(late.contains("apps.launch: " + FakeDevice.SETTINGS + " opened no window within 10000 ms (the accessibility tree shows window 30 application \"UI fixture\" of " + FakeDevice.FIXTURE + ")"), late);
		// A terminate takes the launch that has not shown yet with it.
		phone.call("apps.terminate", "{\"id\":\"" + FakeDevice.SETTINGS + "\"}");
		eq(FakeDevice.FIXTURE, map(phone.call("apps.list", "{}")).get("foreground"));
	}

	static void testAppsLaunchWithTheTreeOffWaitsForTheAppInFront() throws Exception {
		Check.Phone phone = new Check.Phone();
		phone.device.features.put("ui.tree", "UiAutomation is held by another client");
		phone.device.windowLagMs = 400;
		long before = phone.device.clock().now();
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		yes(phone.device.clock().now() - before < 100, "the task is in front at once");
		eq(FakeDevice.FIXTURE, map(phone.call("apps.list", "{}")).get("foreground"));
	}

	static void testObserveIsImmediateAndItsNotFoundNamesTheWindowsThere() throws Exception {
		Check.Phone phone = new Check.Phone();
		// The task in front, its window not on the screen yet (apps.launch would wait; the phone's own launch does not).
		phone.device.windowLagMs = 400;
		phone.device.apps().launch(FakeDevice.FIXTURE, null);
		long before = phone.device.clock().now();
		String missing = refuses("not_found", () -> phone.call("ui.observe", "{\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}}"));
		eq(before, phone.device.clock().now());
		yes(missing.equals(FakeDevice.FIXTURE + " has no window on the screen (the accessibility tree shows window 10 application \"Settings\" of " + FakeDevice.SETTINGS + "): open it with apps.launch first"), missing);
	}

	static void testAWindowSitsWhereItsElementsAreThoughTheServicePutsItElsewhere() throws Exception {
		Check.Phone phone = new Check.Phone();
		// The accessibility service puts the window 1000 px lower than its elements, its screen and its input are.
		phone.device.windowSkewY = 1000;
		phone.call("apps.launch", "{\"id\":\"" + FakeDevice.FIXTURE + "\"}");
		String target = "\"target\":{\"app\":\"" + FakeDevice.FIXTURE + "\"}";
		Map<String, Object> seen = phone.call("ui.observe", "{" + target + ",\"image\":{\"maxEdge\":256}}");
		eq("[110,440,320,320]", Json.write(map(seen.get("window")).get("bounds")));
		yes(seen.get("image") != null, "the window's image, cut from the screen at the window");
		Map<String, Object> canvas = null;
		for (Object n : list(seen, "nodes")) if ("canvas".equals(map(n).get("id"))) canvas = map(n);
		eq("[16,180,200,100]", Json.write(canvas.get("bounds")));
		// A point read from the state lands on the canvas: window points to screen pixels in the elements' space.
		Map<String, Object> clicked = phone.call("ui.act", "{" + target + ",\"state\":\"" + seen.get("state") + "\",\"foreground\":true,\"steps\":[{\"click\":[116,230]}]}");
		eq(Json.obj("route", "foreground", "verified", true), step(clicked, 0));
		eq("1", phone.device.canvas.state);
	}
}
