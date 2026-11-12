// `npm run build:ui-fixture`: the ui fixture (src/conformance/ui-fixture.ts) as an Android app, at
// dist/ui-fixture.apk, which the phone harness installs on a conformance run's phones. Plain javac and d8, no Gradle
// and no resources: aapt2 links the manifest against the pinned platform (android-sdk.mjs's ANDROID), aapt adds the
// dex, zipalign aligns it, and apksigner signs it with a debug key made here for this build, so no key is kept
// anywhere. The APK's bytes differ from build to build (the key is new each time); the app inside them does not.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANDROID, androidSdk, files, jdk as jdkTool, run as runTool } from "./android-sdk.mjs";

const SCRIPT = "build:ui-fixture";
const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "fixture-android");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const run = (tool, args, options) => runTool(SCRIPT, tool, args, options);
const jdk = (name) => jdkTool(SCRIPT, name);

const sdk = androidSdk(SCRIPT);
const work = mkdtempSync(join(tmpdir(), "agentrun-ui-fixture-"));
try {
	const classes = join(work, "classes");
	run(jdk("javac"), ["-encoding", "UTF-8", "--release", "17", "-Xlint:all,-options", "-classpath", sdk.androidJar, "-d", classes, ...files(join(source, "src"), ".java")]);

	const dex = join(work, "dex");
	mkdirSync(dex);
	run(sdk.java, [...sdk.d8(), "--release", "--min-api", String(ANDROID.minApi), "--lib", sdk.androidJar, "--output", dex, ...files(classes, ".class")]);

	const linked = join(work, "linked.apk");
	run(sdk.tool("aapt2"), [
		"link",
		"-o", linked,
		"--manifest", join(source, "AndroidManifest.xml"),
		"-I", sdk.androidJar,
		"--min-sdk-version", String(ANDROID.minApi),
		"--target-sdk-version", String(ANDROID.platform),
		"--version-code", "1",
		"--version-name", version,
	]);
	// aapt add puts the file in under the path it is given, so it runs in the dex's directory.
	run(sdk.tool("aapt"), ["add", linked, "classes.dex"], { cwd: dex, stdio: ["ignore", "ignore", "inherit"] });

	const aligned = join(work, "aligned.apk");
	run(sdk.tool("zipalign"), ["-p", "-f", "4", linked, aligned]);

	// A debug key for this build alone: its password is no secret, and the keystore goes with the work directory.
	const keystore = join(work, "debug.p12");
	run(jdk("keytool"), ["-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-storepass", "android", "-keypass", "android", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3650", "-dname", "CN=AgentRun ui fixture"], { stdio: ["ignore", "ignore", "inherit"] });
	const dist = join(root, "dist");
	mkdirSync(dist, { recursive: true });
	const out = join(dist, "ui-fixture.apk");
	rmSync(out, { force: true });
	run(sdk.java, [...sdk.apksigner(), "sign", "--ks", keystore, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--ks-key-alias", "fixture", "--out", out, aligned]);
	rmSync(`${out}.idsig`, { force: true });
	console.log(`${SCRIPT}: ${out} (${statSync(out).size} bytes, ${version})`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
