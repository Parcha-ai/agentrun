package ai.agentrun.phoned;

import static ai.agentrun.phoned.Check.eq;
import static ai.agentrun.phoned.Check.list;
import static ai.agentrun.phoned.Check.map;
import static ai.agentrun.phoned.Check.refuses;
import static ai.agentrun.phoned.Check.yes;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/** hello, the apps group, exec.run, and what a phone does not answer. */
final class PhonedTest {
	private PhonedTest() {}

	static void testHelloSaysTheScreenInPointsAndEachFeature() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> hello = phone.call("hello", "{}");
		eq("0.2", hello.get("protocol"));
		eq("0.0.0-test", hello.get("version"));
		eq("android", hello.get("os"));
		eq("15", hello.get("osVersion"));
		eq("android", hello.get("kind"));
		eq("arm64", hello.get("arch"));
		eq(Arrays.asList("exec", "screen", "input.keys", "input.touch", "apps", "ui"), hello.get("groups"));
		eq(Json.obj("width", 540L, "height", 1200L, "scale", 2.0), hello.get("screen"));
		Map<String, Object> features = map(hello.get("features"));
		eq(true, features.get("ui.image"));
		eq(true, features.get("ui.foreground"));
		eq(true, features.get("ui.nav"));
		yes(((String) map(features.get("ui.background")).get("off")).contains("window in front"), "ui.background is off, with the reason");
		yes(map(features.get("apps.background")).containsKey("off"), "apps.background is off");
		phone.device.features.put("ui.tree", "UiAutomation is held by another client");
		phone.device.features.put("input.inject", "INJECT_EVENTS was refused");
		Map<String, Object> off = map(phone.call("hello", "{}").get("features"));
		yes(((String) map(off.get("ui.nav")).get("off")).contains("held by another client"), Json.write(off));
		eq(Json.obj("off", "INJECT_EVENTS was refused"), off.get("ui.foreground"));
	}

	static void testAppsListAndLaunch() throws Exception {
		Check.Phone phone = new Check.Phone();
		Map<String, Object> apps = phone.call("apps.list", "{}");
		eq(Json.obj("id", "com.android.settings", "name", "Settings", "version", "15"), list(apps, "apps").get(0));
		eq("com.android.settings", apps.get("foreground"));
		eq(Json.obj(), phone.call("apps.launch", "{\"id\":\"com.android.chrome\",\"url\":\"https://example.com/a?b=c\"}"));
		phone.call("apps.terminate", "{\"id\":\"com.android.chrome\"}");
		eq(Arrays.asList("launch com.android.chrome https://example.com/a?b=c", "terminate com.android.chrome"), phone.device.log);
		refuses("not_found", () -> phone.call("apps.launch", "{\"id\":\"com.example.none\"}"));
		refuses("invalid", () -> phone.call("apps.launch", "{\"id\":\"chrome\"}"));
		refuses("invalid", () -> phone.call("apps.launch", "{\"id\":\"com.android.chrome\",\"url\":\"not a url\"}"));
		String words = refuses("unsupported", () -> phone.call("apps.launch", "{\"id\":\"com.android.chrome\",\"background\":true}"));
		yes(words.contains("apps.background"), words);
	}

	static void testWhatAPhoneDoesNotAnswerIsSaid() throws Exception {
		Check.Phone phone = new Check.Phone();
		eq(Json.obj(), phone.call("ping", "{}"));
		yes(refuses("unsupported", () -> phone.call("files.read", "{\"path\":\"/x\"}")).contains("exec.run"), "files point at exec.run");
		refuses("unsupported", () -> phone.call("deadline.extend", "{}"));
		try {
			phone.call("teleport", "{}");
			throw new AssertionError("teleport answered");
		} catch (RpcError e) {
			eq(RpcError.METHOD_NOT_FOUND, e.code);
		}
	}

	static Map<String, Object> run(Exec exec, String params, Wire.Cancel cancel) throws Exception {
		return exec.run(Params.of(Json.parse(params), "params"), cancel);
	}

	static String text(Object b64) {
		return new String(Base64.getDecoder().decode((String) b64), StandardCharsets.UTF_8);
	}

	static Exec exec() {
		Map<String, String> env = new LinkedHashMap<>();
		env.put("PATH", System.getenv("PATH"));
		env.put("ANDROID_DATA", "/data");
		env.put("PHONED_SECRET", "leak");
		return new Exec(env, System.getProperty("java.io.tmpdir"));
	}

	static void testExecRunsArgvWithAMinimalEnvironment() throws Exception {
		Map<String, Object> r = run(exec(), "{\"argv\":[\"sh\",\"-c\",\"echo $HOME:$USER:$ANDROID_DATA:$PHONED_SECRET:$FOO; pwd; echo bad >&2; exit 3\"],\"env\":{\"FOO\":\"bar\"},\"timeoutMs\":10000}", Wire.Cancel.none());
		eq(3L, r.get("exitCode"));
		String tmp = new File(System.getProperty("java.io.tmpdir")).getCanonicalPath();
		eq(System.getProperty("java.io.tmpdir") + ":shell:/data::bar\n" + tmp + "\n", text(r.get("stdout")));
		eq("bad\n", text(r.get("stderr")));
		eq(false, r.get("timedOut"));
		eq(false, r.get("truncated"));
		yes(!r.containsKey("signal"), "no signal");
		Map<String, Object> cut = run(exec(), "{\"argv\":[\"sh\",\"-c\",\"echo 0123456789\"],\"maxOutput\":4,\"timeoutMs\":10000}", Wire.Cancel.none());
		eq("0123", text(cut.get("stdout")));
		eq(true, cut.get("truncated"));
	}

	static void testExecKillsTheWholeTreeAtItsTimeout() throws Exception {
		long start = System.nanoTime();
		// The background sleep holds stdout open: unless it is killed too, the reply waits on it.
		Map<String, Object> r = run(exec(), "{\"argv\":[\"sh\",\"-c\",\"sleep 30 & sleep 30\"],\"timeoutMs\":300}", Wire.Cancel.none());
		long ms = (System.nanoTime() - start) / 1_000_000;
		eq(true, r.get("timedOut"));
		eq(null, r.get("exitCode"));
		eq("KILL", r.get("signal"));
		yes(ms < 3000, "answered in " + ms + " ms");
	}

	static void testExecCancelAborts() throws Exception {
		Wire.Cancel cancel = new Wire.Cancel();
		Thread stop = new Thread(() -> {
			try {
				Thread.sleep(200);
			} catch (InterruptedException e) {
				return;
			}
			cancel.cancel();
		});
		stop.start();
		refuses("aborted", () -> run(exec(), "{\"argv\":[\"sleep\",\"30\"],\"timeoutMs\":60000}", cancel));
		stop.join();
	}

	static void testExecRefusals() throws Exception {
		Exec exec = exec();
		yes(refuses("denied", () -> run(exec, "{\"argv\":[\"id\"],\"user\":\"root\",\"timeoutMs\":1000}", Wire.Cancel.none())).contains("shell user"), "says who it runs as");
		eq(0L, run(exec, "{\"argv\":[\"true\"],\"user\":\"shell\",\"timeoutMs\":5000}", Wire.Cancel.none()).get("exitCode"));
		refuses("not_found", () -> run(exec, "{\"argv\":[\"true\"],\"cwd\":\"no-such-dir-here\",\"timeoutMs\":1000}", Wire.Cancel.none()));
		refuses("not_found", () -> run(exec, "{\"argv\":[\"no-such-program-here\"],\"timeoutMs\":1000}", Wire.Cancel.none()));
		refuses("invalid", () -> run(exec, "{\"argv\":[],\"timeoutMs\":1000}", Wire.Cancel.none()));
		refuses("invalid", () -> run(exec, "{\"argv\":[\"true\"]}", Wire.Cancel.none()));
		refuses("invalid", () -> run(exec, "{\"argv\":[\"true\"],\"timeoutMs\":0}", Wire.Cancel.none()));
		refuses("invalid", () -> run(exec, "{\"argv\":[\"true\"],\"env\":{\"A\":1},\"timeoutMs\":1000}", Wire.Cancel.none()));
	}
}
