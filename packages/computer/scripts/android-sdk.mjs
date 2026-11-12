// The JDK and Android SDK that build phoned (build-phoned.mjs) and the ui fixture app (build-ui-fixture.mjs): one pin
// for both, and one sentence when something is missing, naming it and where it was looked for. Never a silent skip.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

/**
 * The Android SDK both build with: the platform they compile against and the build tools whose d8 makes their dex
 * (and aapt2, zipalign and apksigner the fixture's APK), both shipped by GitHub's ubuntu-24.04 and macos-15 runner
 * images, and minApi, the oldest Android they run on (11). phoned's jar bytes follow the build tools: another d8 makes
 * another sha256.
 */
export const ANDROID = { platform: 35, buildTools: "35.0.0", minApi: 30 };

/** Where a JDK is looked for, in order: the runner images' JDK 17, JAVA_HOME, then PATH. */
const JDK_HOMES = ["JAVA_HOME_17_X64", "JAVA_HOME_17_arm64", "JAVA_HOME"];

/** Stops the build with one sentence on stderr. */
export function fail(script, words) {
	console.error(`${script}: ${words}`);
	process.exit(1);
}

function findOnPath(name) {
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(dir, name);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/** A JDK tool (javac, java, jar, keytool): from the first of JDK_HOMES that is set, else PATH. */
export function jdk(script, name) {
	const exe = process.platform === "win32" ? `${name}.exe` : name;
	const home = JDK_HOMES.map((key) => process.env[key]).find(Boolean);
	const tool = home ? join(home, "bin", exe) : findOnPath(exe);
	if (tool === undefined || !existsSync(tool)) fail(script, `it needs a JDK 17 or newer, and ${exe} is not in ${home ? join(home, "bin") : "any PATH directory"} (looked in $${JDK_HOMES.join(", $")}, then PATH).`);
	return tool;
}

/** Every file under dir ending in suffix, sorted, so a build lists its inputs in one order. */
export function files(dir, suffix) {
	const out = [];
	const walk = (at) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(suffix)) out.push(path);
		}
	};
	if (existsSync(dir)) walk(dir);
	return out.sort();
}

/** Runs a tool with its output shown; when it fails, the build exits with its status (the tool said why). */
export function run(script, tool, args, options = {}) {
	try {
		execFileSync(tool, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
	} catch (error) {
		console.error(`${script}: ${tool.split(sep).pop()} failed`);
		process.exit(typeof error.status === "number" && error.status > 0 ? error.status : 1);
	}
}

/**
 * The pinned SDK's files: the platform's android.jar and core-for-system-modules.jar, a build tool by name (d8, aapt,
 * aapt2, zipalign, apksigner), each checked before it is given, and env, the environment to run the build tools in:
 * d8 and apksigner are scripts that run `java` from PATH, so the JDK found above comes first there.
 */
export function androidSdk(script) {
	const javaBin = dirname(jdk(script, "java"));
	const env = { ...process.env, PATH: [javaBin, process.env.PATH].filter(Boolean).join(delimiter) };
	const needs = `platforms;android-${ANDROID.platform} and build-tools;${ANDROID.buildTools}`;
	const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (!sdk) fail(script, `it needs an Android SDK with ${needs}, and neither $ANDROID_HOME nor $ANDROID_SDK_ROOT is set.`);
	const need = (path, pkg) => {
		if (!existsSync(path)) fail(script, `it needs ${pkg} from the Android SDK at ${sdk}, and ${path} is missing (sdkmanager "${pkg}" installs it).`);
		return path;
	};
	const platform = join(sdk, "platforms", `android-${ANDROID.platform}`);
	const platformPkg = `platforms;android-${ANDROID.platform}`;
	const windows = process.platform === "win32";
	const scripts = new Set(["d8", "apksigner"]);
	return {
		env,
		androidJar: need(join(platform, "android.jar"), platformPkg),
		systemModules: need(join(platform, "core-for-system-modules.jar"), platformPkg),
		tool: (name) => need(join(sdk, "build-tools", ANDROID.buildTools, windows ? (scripts.has(name) ? `${name}.bat` : `${name}.exe`) : name), `build-tools;${ANDROID.buildTools}`),
	};
}
