package ai.agentrun.phoned;

import ai.agentrun.phoned.device.Device;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * phoned's methods: the computer protocol's phone groups, answered on the phone itself. One Phoned serves one
 * connection (one stdin), so its refs, states and held shots are that connection's own.
 */
public final class Phoned implements Wire.Handler {
	/** protocol.ts PROTOCOL_VERSION. */
	public static final String PROTOCOL = "0.2";
	/** The groups phoned answers, in the protocol's order. */
	public static final List<String> GROUPS = Collections.unmodifiableList(Arrays.asList("exec", "screen", "input.keys", "input.touch", "apps", "ui"));
	static final Pattern APP_ID = Pattern.compile("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$");
	static final Pattern URL = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]*:\\S+$");
	static final String UI_BACKGROUND_OFF = "Android sends input to the window in front only: a step runs as an accessibility action on its element "
			+ "(semantic) or as the phone's own input (foreground)";
	static final String APPS_BACKGROUND_OFF = "an app a phone opens comes to the front";

	private final Device device;
	private final String version;
	private final Object hands = new Object();
	private final Shots shots;
	private final UiDriver ui;
	private final Actions actions;
	private final Exec exec;

	public Phoned(Device device, String version) {
		this(device, version, new Exec(System.getenv(), Exec.HOME));
	}

	public Phoned(Device device, String version, Exec exec) {
		this.device = device;
		this.version = version;
		this.shots = new Shots(device);
		this.ui = new UiDriver(device, shots, this::features, hands);
		this.actions = new Actions(device, hands);
		this.exec = exec;
	}

	/** Go's names for the ABIs, as hello.arch says them. */
	static String arch(String abi) {
		switch (abi) {
			case "arm64-v8a":
				return "arm64";
			case "x86_64":
				return "amd64";
			case "x86":
				return "386";
			case "armeabi-v7a":
				return "arm";
			default:
				return abi;
		}
	}

	/** hello.features: each protocol feature this phone has, or off with the reason. */
	Map<String, Object> features() {
		Map<String, Object> phone = device.features();
		Map<String, Object> f = new LinkedHashMap<>();
		f.put("apps.background", APPS_BACKGROUND_OFF);
		Object tree = phone.get("ui.tree");
		f.put("ui.image", Boolean.TRUE.equals(tree) ? Boolean.TRUE : "the window's image comes from the accessibility connection, which is off: " + tree);
		f.put("ui.background", UI_BACKGROUND_OFF);
		Object inject = phone.get("input.inject");
		f.put("ui.foreground", Boolean.TRUE.equals(inject) ? Boolean.TRUE : inject);
		f.put("ui.nav", Boolean.TRUE.equals(tree) ? Boolean.TRUE : "back, home and app_switch are accessibility actions, and the accessibility connection is off: " + tree);
		return f;
	}

	/** Features as the wire says them: true, or { off }. */
	private Map<String, Object> wireFeatures() {
		Map<String, Object> out = new LinkedHashMap<>();
		for (Map.Entry<String, Object> e : features().entrySet()) {
			Object v = e.getValue();
			out.put(e.getKey(), Boolean.TRUE.equals(v) ? Boolean.TRUE : Json.obj("off", String.valueOf(v)));
		}
		return out;
	}

	Map<String, Object> hello() {
		Device.Facts facts = device.facts();
		Device.Display d = device.display();
		return Json.obj(
				"protocol", PROTOCOL,
				"version", version,
				"os", "android",
				"osVersion", facts.release == null || facts.release.isEmpty() ? Json.OMIT : facts.release,
				"kind", "android",
				"arch", arch(facts.abi),
				"groups", new ArrayList<Object>(GROUPS),
				"screen", Json.obj("width", Math.round(d.width / d.scale), "height", Math.round(d.height / d.scale), "scale", d.scale),
				"features", wireFeatures());
	}

	@Override
	public Object handle(String method, Params params, Wire.Cancel cancel) throws RpcError, InterruptedException {
		switch (method) {
			case "hello":
				return hello();
			case "ping":
				return Json.obj();
			case "exec.run":
				return exec.run(params, cancel);
			case "screen.shot":
				return shots.shot(params);
			case "screen.read":
				return shots.read(params);
			case "screen.watch":
				return shots.watch(params, cancel);
			case "input.actions":
				return actions.run(params, cancel);
			case "apps.list":
				return appsList();
			case "apps.launch":
				return launch(params);
			case "apps.terminate":
				device.apps().terminate(appId(params));
				return Json.obj();
			case "ui.observe":
				return ui.observe(params, cancel);
			case "ui.act":
				return ui.act(params, cancel);
			default:
				break;
		}
		String group = method.contains(".") ? method.substring(0, method.indexOf('.')) : method;
		if (Arrays.asList("files", "process", "tar", "mount").contains(group)) {
			throw RpcError.unsupported(method + ": a phone offers exec.run as the shell user, and no files, processes or mounts");
		}
		if (method.equals("deadline.extend")) throw RpcError.unsupported("deadline.extend: a phone's session ends when its provider says; phoned has no deadline");
		throw new RpcError("unsupported", RpcError.METHOD_NOT_FOUND, method + " is not a method this phone answers");
	}

	private static String appId(Params p) {
		String id = p.str("id");
		if (!APP_ID.matcher(id).matches()) throw RpcError.invalid("id " + Json.write(id) + " is not an Android package id (like com.android.settings)");
		return id;
	}

	private Map<String, Object> appsList() {
		List<Object> apps = new ArrayList<>();
		for (Device.App a : device.apps().list()) {
			apps.add(Json.obj("id", a.id, "name", a.name == null || a.name.isEmpty() ? Json.OMIT : a.name, "version", a.version == null || a.version.isEmpty() ? Json.OMIT : a.version));
		}
		return Json.obj("apps", apps, "foreground", device.apps().foreground());
	}

	private Map<String, Object> launch(Params p) {
		String id = appId(p);
		String url = p.str("url", null);
		if (url != null && !URL.matcher(url).matches()) throw RpcError.invalid("url is not a URL (scheme:rest, no spaces)");
		if (p.bool("background", false)) throw RpcError.unsupported("apps.launch: this phone does not offer apps.background: " + APPS_BACKGROUND_OFF);
		device.apps().launch(id, url);
		return Json.obj();
	}
}
