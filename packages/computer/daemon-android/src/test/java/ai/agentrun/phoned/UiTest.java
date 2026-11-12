package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.list;
import static ai.agentrun.phoned.Check.map;
import static ai.agentrun.phoned.Check.refuses;
import static ai.agentrun.phoned.Check.yes;

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
		eq("Mobile, Wi-Fi, hotspot", row.get("value"));
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
		eq("com.android.settings:id/recycler_view", listNode.get("id"));
		yes(listNode.containsKey("parent"), "the list's own parent (the window's root) is listed too");
		// The zero-size layout is dropped in both forms.
		Map<String, Object> full = phone.call("ui.observe", "{\"full\":true}");
		yes(list(full, "nodes").size() > list(seen, "nodes").size(), "full lists more");
		phone.node(full, "Mobile, Wi-Fi, hotspot");
		phone.node(full, "System");
		for (Object n : list(full, "nodes")) {
			String b = Json.write(map(n).get("bounds"));
			yes(!b.endsWith(",0,0]") && !b.endsWith(",0]"), "a zero-size node is listed: " + b);
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
		String words = refuses("unsupported", () -> phone.call("ui.observe", "{\"image\":true}"));
		yes(words.contains("ui.image is off here"), words);
	}

	static void testPressByRefIsSemanticAndExpectIsMet() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> seen = phone.call("ui.observe", "{}");
		String ref = (String) phone.node(seen, "Network & internet").get("ref");
		Map<String, Object> acted = phone.call("ui.act", "{\"state\":\"s1\",\"steps\":[{\"press\":\"" + ref + "\"}],\"expect\":{\"text\":\"Wi-Fi\"}}");
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
		Map<String, Object> acted = phone.call("ui.act", "{\"steps\":[{\"press\":\"" + network + "\"},{\"press\":\"" + network + "\"},{\"nav\":\"back\"}],\"expect\":{\"text\":\"Wi-Fi\"}}");
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
		eq("Home network", wifiRow.get("value"));
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
}
