#!/usr/bin/env node
// The OSWorld loader: OSWorld-Verified's tasks as computer-bench tasks that run OSWorld's own setup and evaluator
// through osw (image/osw/osw.py) in the bench desktop image, instead of a check written by hand.
//
//   node scripts/port-osworld.mjs port --osworld DIR --tree FILE [--tree REV=FILE ...] [--sums FILE] --out DIR [--domain D ...]
//   node scripts/port-osworld.mjs sums --osworld DIR --tree FILE [--tree REV=FILE ...] --out FILE [--domain D ...]
//
// --osworld is an OSWorld checkout at OSWORLD_REVISION: its evaluation_examples/test_nogdrive.json, each task's
// examples/<domain>/<uuid>.json, and the getter and metric names desktop_env/evaluators exports. --tree is the file
// cache's tree at DATASET_REVISION as the Hugging Face API lists it (path, size, git oid, and an LFS file's sha256);
// REV=FILE is the tree at another revision a task pins. --sums maps the git oid of a file the cache keeps outside LFS to
// its sha256, which the tree can't say; `sums` writes it, fetching each such file once from huggingface.co and
// checking its bytes against the oid.
//
// `port` writes suites/<suite>/<domain>-<uuid8>/ for each portable task of the domains given (every domain when none
// is), holding task.json and osworld.json (and rubric.md for an infeasible task), and the suite's PORT.md, which gives
// each refused task its reasons. A task is portable when the bench desktop can run it as OSWorld wrote it: its apps are
// the desktop's, its check reads no GNOME-only state and no accessibility tree, it opens no live page and signs in to
// nothing, no step of it runs sudo (osw runs as the computer's own user, with no root), every getter and metric it
// names is OSWorld's, and every file it downloads or compares with is pinned. The rule reads each task's JSON alone;
// OVERRIDES holds the facts it can't see, each with its reason.
//
// osworld.json is the task's own JSON with each file-cache URL pinned: a URL at `main` moves to DATASET_REVISION and a
// URL at another revision stays at it; each download step's files and each cloud_file gold get the sha256 osw checks.
// OSWorld is Apache-2.0 (Copyright 2024 XLANG NLP Lab): osworld.json carries that notice in its `notice` field.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OSWORLD_REVISION = "0ad41bee56565efe7bb3c3a5ebc67590a1b8276f";
export const DATASET_REVISION = "e28460ae734cb1b33901d232cef8747c20ccd677";
const DATASET = "https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/resolve/";
const CACHE_URL = /https:\/\/huggingface\.co\/datasets\/xlangai\/ubuntu_osworld_file_cache\/resolve\/([^/"\s\\]+)\/([^"\s\\]+)/g;
const NOTICE = "From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab)";
const LICENCE = "Apache-2.0 (Copyright 2024 XLANG NLP Lab); the instruction is copied word for word, and osworld.json is the task's own JSON with the changes named here";
// computer-bench fills these in a task's strings and in a file it inlines (task.ts), so a task holding one is refused.
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?|file:[A-Za-z0-9._-]+)\s*\}\}/;
// osworld.json goes to osw as one argv word, which Linux caps at 128 KiB.
const MAX_INLINE_BYTES = 100_000;

// OSWorld's app names, and what its setup commands and opened files show, as one name per app (the survey's).
const APP_NAMES = {
	os: "terminal", terminal: "terminal", OS: "terminal", chrome: "chrome", Chrome: "chrome", browser: "chrome",
	libreoffice_calc: "calc", "libreoffice calc": "calc", calc: "calc", libreoffice_impress: "impress",
	libreoffice_writer: "writer", writer: "writer", Writer: "writer", libreoffice: "writer", gimp: "gimp",
	vscode: "vscode", vs_code: "vscode", vlc: "vlc", ubuntu_media_player: "vlc", thunderbird: "thunderbird",
	pdf: "pdfviewer", image: "imageviewer", picard: "picard",
};
const COMMAND_APPS = [
	[/google-chrome/, "chrome"], [/\bcode\b/, "vscode"], [/\bgimp\b/, "gimp"], [/thunderbird/, "thunderbird"], [/\bvlc\b/, "vlc"],
	[/libreoffice|soffice/, "office"], [/\bnautilus\b/, "nautilus"], [/gnome-terminal/, "gnome-terminal"],
];
const OPENED_APPS = { xlsx: "calc", xls: "calc", ods: "calc", csv: "calc", pptx: "impress", docx: "writer", odt: "writer", pdf: "pdfviewer", mp4: "vlc" };
/** The bench desktop's apps (B+), each by the desktop file ids apps.list names it by: a list is alternatives, as
 *  Debian's and upstream's names differ. The terminal is the box's own and needs nothing. */
export const DESKTOP_APPS = {
	terminal: null,
	chrome: "google-chrome",
	calc: "libreoffice-calc",
	impress: "libreoffice-impress",
	writer: "libreoffice-writer",
	gimp: ["gimp", "org.gimp.GIMP"],
	vscode: "code",
	vlc: ["vlc", "org.videolan.VLC"],
	thunderbird: ["thunderbird", "org.mozilla.Thunderbird"],
	pdfviewer: ["org.gnome.Evince", "evince"],
	imageviewer: ["org.gnome.eog", "eog"],
	nautilus: ["org.gnome.Nautilus", "nautilus"],
	"gnome-terminal": ["org.gnome.Terminal", "gnome-terminal"],
};

// Getters that read a live page through Chrome's debugging port, or a URL the agent reached.
const LIVE_GETTERS = new Set(["active_tab_html_parse", "active_tab_url_parse", "active_tab_url_and_body_text", "active_tab_info", "open_tabs_info", "page_info", "info_from_website", "gotoRecreationPage_and_get_html_content", "pdf_from_url", "url_dashPart", "active_url_from_accessTree", "url_path_parse"]);
// Getters and metrics that read the accessibility tree, through the server's pyatspi endpoints (GNOME's AT-SPI).
const A11Y_GETTERS = new Set(["accessibility_tree", "active_url_from_accessTree", "vm_terminal_output"]);
const A11Y_METRICS = new Set(["check_accessibility_tree", "check_left_panel"]);
const GNOME_GETTERS = new Set(["vm_wallpaper"]);
const GNOME_METRICS = new Set(["check_gnome_favorite_apps"]);
const GNOME_WORDS = /\b(gsettings|dconf|gnome-[a-z-]+|update-desktop-database|org\.gnome)\b/;
const GOOGLE = /google account|accounts\.google|colab\.research|drive\.google|docs\.google|sign in to google/i;
// OSWorld's steps get root as `echo {CLIENT_PASSWORD} | sudo -S ...`; the bench desktop gives none.
const ROOT_WORDS = /\bsudo\b|\{CLIENT_PASSWORD\}/;
/** Metrics whose dependencies the image leaves out, with why. */
const HEAVY_METRICS = { compare_image_text: "the metric compare_image_text needs easyocr and torch (about 2 GB), which the image leaves out" };
const LOCAL_HOSTS = new Set(["huggingface.co", "localhost", "127.0.0.1", "0.0.0.0"]);

/** Facts about one task the rules can't see, by its uuid's first 8 characters, each with its reason. refuse: the
 *  task is refused for it. probe: a command the computer must have, as a capability probe. */
export const OVERRIDES = {
	"94d95f96": { refuse: "installs Spotify, from the snap store or apt over the network: a live host" },
	b6781586: { refuse: "the metric is_utc_0 reads timedatectl, which needs systemd" },
	"28cc3b7e": { probe: "pactl", why: "sets the volume through pulseaudio, whose pactl the check runs" },
};

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** The getter and metric names OSWorld exports at the checkout: each `from .x import ...` and `def` of the two
 *  packages' __init__.py, as plain text (nothing of OSWorld runs here). */
export function osworldNames(osworld) {
	const names = (file) => {
		const text = readFileSync(join(osworld, "desktop_env", "evaluators", file, "__init__.py"), "utf8");
		const found = new Set();
		for (const [, list] of text.matchAll(/^from\s+\.[\w.]*\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
			for (const part of list.replace(/[()]/g, "").replace(/#[^\n]*/g, "").split(",")) {
				const name = part.trim().split(/\s+as\s+/).pop()?.trim();
				if (name) found.add(name);
			}
		}
		for (const [, name] of text.matchAll(/^def\s+(\w+)/gm)) found.add(name);
		return found;
	};
	return { getters: names("getters"), metrics: names("metrics") };
}

/** Every host a value's strings name. */
function hostsOf(value, into = new Set()) {
	if (typeof value === "string") for (const [, host] of value.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) into.add(host.toLowerCase());
	else if (Array.isArray(value)) for (const one of value) hostsOf(one, into);
	else if (value && typeof value === "object") for (const one of Object.values(value)) hostsOf(one, into);
	return into;
}

/** The getter configs of an evaluator's result and expected, the empty ones left out. */
function getterConfigs(evaluator) {
	return [...asList(evaluator.result), ...asList(evaluator.expected)].filter((one) => one && typeof one === "object" && one.type);
}

/**
 * What the bench desktop needs to run one OSWorld task, and why it can't when it can't: {apps, infeasible, reasons,
 * probes}. apps are the survey's app names; reasons is empty for a portable task.
 */
export function classify(task, names) {
	const evaluator = task.evaluator ?? {};
	const config = task.config ?? [];
	const postconfig = evaluator.postconfig ?? [];
	const funcs = asList(evaluator.func);
	const getters = getterConfigs(evaluator).map((one) => one.type);
	const commandText = JSON.stringify([...config, ...postconfig]);
	const { postconfig: _post, ...check } = evaluator;
	const checkText = JSON.stringify(check);
	const instruction = task.instruction ?? "";
	const override = OVERRIDES[String(task.id).slice(0, 8)] ?? {};
	const reasons = [];

	const apps = new Set((task.related_apps ?? []).map((app) => APP_NAMES[app] ?? app));
	for (const [pattern, app] of COMMAND_APPS) if (pattern.test(commandText)) apps.add(app);
	for (const step of config) {
		if (step.type === "open") {
			const extension = String(step.parameters?.path ?? "").split(".").pop().toLowerCase();
			if (OPENED_APPS[extension]) apps.add(OPENED_APPS[extension]);
		}
		if (String(step.type).startsWith("chrome_")) apps.add("chrome");
	}
	if (apps.has("office") && !["calc", "impress", "writer"].some((app) => apps.has(app))) apps.add("writer");
	apps.delete("office");

	const infeasible = funcs.includes("infeasible");
	const liveHosts = [...hostsOf([config, postconfig, check, instruction])].filter((host) => !LOCAL_HOSTS.has(host) && !host.endsWith(".hf.co")).sort();
	const liveGetters = getters.filter((getter) => LIVE_GETTERS.has(getter));
	if (liveHosts.length > 0) reasons.push(`opens or reads a live host: ${liveHosts.join(", ")}`);
	if (liveGetters.length > 0) reasons.push(`the check reads a live page (${[...new Set(liveGetters)].join(", ")})`);
	if (task.proxy === true && liveHosts.length === 0 && liveGetters.length === 0) reasons.push("OSWorld flags it proxy: true, a live page");
	const a11y = [...new Set([...getters.filter((getter) => A11Y_GETTERS.has(getter)), ...funcs.filter((func) => A11Y_METRICS.has(func))])];
	if (a11y.length > 0) reasons.push(`the check reads the accessibility tree over GNOME's AT-SPI (${a11y.join(", ")})`);
	const gnome = [...new Set([...getters.filter((getter) => GNOME_GETTERS.has(getter)), ...funcs.filter((func) => GNOME_METRICS.has(func))])];
	const gnomeWord = (checkText + JSON.stringify(postconfig)).match(GNOME_WORDS)?.[1];
	if (gnomeWord) gnome.push(gnomeWord);
	if (gnome.length > 0) reasons.push(`the check reads GNOME-only state (${gnome.join(", ")})`);
	if (GOOGLE.test(commandText + checkText + instruction)) reasons.push("it signs in to Google");
	if (ROOT_WORDS.test(commandText + checkText)) reasons.push("a setup or check step runs sudo, and the bench desktop gives no root: osw runs as the computer's own user");
	if (override.refuse) reasons.push(override.refuse);
	const missing = [...apps].filter((app) => !(app in DESKTOP_APPS)).sort();
	if (missing.length > 0) reasons.push(`needs ${missing.join(", ")}, not on the bench desktop`);
	for (const func of new Set(funcs)) if (HEAVY_METRICS[func]) reasons.push(HEAVY_METRICS[func]);
	if (!infeasible) {
		const unknownGetters = [...new Set(getters)].filter((getter) => !names.getters.has(`get_${getter}`));
		const unknownMetrics = [...new Set(funcs)].filter((func) => typeof func !== "string" || !names.metrics.has(func));
		if (unknownGetters.length > 0) reasons.push(`OSWorld has no getter ${unknownGetters.join(", ")}`);
		if (unknownMetrics.length > 0) reasons.push(`OSWorld has no metric ${unknownMetrics.join(", ")}`);
	}
	if (PLACEHOLDER.test(JSON.stringify(task))) reasons.push(`it holds ${JSON.stringify(task).match(PLACEHOLDER)[0]}, which computer-bench would fill as a placeholder`);
	const probes = override.probe ? [{ command: override.probe, why: override.why }] : [];
	return { apps, infeasible, reasons, probes };
}

/** A tree as the Hugging Face API lists it, by path. */
export function treeOf(entries) {
	return new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
}

/**
 * The task's JSON with each file-cache URL pinned, and each download and cloud_file gold given its sha256:
 * {json, problems, unsummed}. problems is empty when every file is pinned; unsummed lists the files kept outside LFS
 * whose sha256 the sums don't have yet ({revision, path, oid, size}).
 */
export function pinTask(task, { trees, sums }) {
	const problems = [];
	const unsummed = [];
	const pinUrl = (text) => text.replace(CACHE_URL, (_, revision, path) => `${DATASET}${revision === "main" ? DATASET_REVISION : revision}/${path}`);
	const deep = (value) => {
		if (typeof value === "string") return pinUrl(value);
		if (Array.isArray(value)) return value.map(deep);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, deep(one)]));
		return value;
	};
	const sha256Of = (url) => {
		const match = new RegExp(`^${CACHE_URL.source}$`).exec(url);
		if (!match) {
			problems.push(`${url} is not in OSWorld's file cache, so it can't be pinned`);
			return undefined;
		}
		const [, revision, encoded] = match;
		const path = decodeURIComponent(encoded);
		const tree = trees.get(revision);
		if (!tree) {
			problems.push(`${path} is pinned to dataset revision ${revision}, whose tree was not given`);
			return undefined;
		}
		const entry = tree.get(path);
		if (!entry) {
			problems.push(`${path} is not in the file cache at revision ${revision.slice(0, 8)}`);
			return undefined;
		}
		const sha256 = entry.lfs?.oid ?? sums[entry.oid];
		if (!sha256) {
			problems.push(`${path} has no sha256: it is not an LFS file, and the sums don't have its oid ${entry.oid}`);
			unsummed.push({ revision, path, oid: entry.oid, size: entry.size });
		}
		return sha256;
	};
	const pinSteps = (steps) =>
		(steps ?? []).map((step) =>
			step.type !== "download" ? step : { ...step, parameters: { ...step.parameters, files: (step.parameters?.files ?? []).map((file) => ({ ...file, sha256: sha256Of(file.url) })) } },
		);
	const pinGetter = (getter) => {
		if (!getter || typeof getter !== "object" || getter.type !== "cloud_file") return getter;
		return { ...getter, sha256: getter.multi ? asList(getter.path).map(sha256Of) : sha256Of(getter.path) };
	};
	const pinned = deep(task);
	const { notice: _notice, ...own } = pinned;
	const json = { notice: "", ...own, config: pinSteps(own.config) };
	if (own.config === undefined) delete json.config;
	if (own.evaluator) {
		const evaluator = { ...own.evaluator };
		if (evaluator.postconfig) evaluator.postconfig = pinSteps(evaluator.postconfig);
		for (const key of ["result", "expected"]) if (evaluator[key] !== undefined) evaluator[key] = Array.isArray(evaluator[key]) ? evaluator[key].map(pinGetter) : pinGetter(evaluator[key]);
		json.evaluator = evaluator;
	}
	return { json, problems, unsummed };
}

/** The task's title: its instruction on one line, cut at a word to the schema's 120 characters. */
export function titleOf(instruction) {
	const line = instruction.replace(/\s+/g, " ").trim();
	if (line.length <= 120) return line;
	const cut = line.slice(0, 119);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : 119).replace(/[\s,;:.]+$/, "")}…`;
}

const dashed = (domain) => domain.replace(/_/g, "-").toLowerCase();
const FIND_DISPLAY = "export DISPLAY=:$(ls /tmp/.X11-unix | sed -n s/^X//p | head -n1); eval $(xdotool getdisplaygeometry --shell 2>/dev/null)";
/** The sha256 of the bench's osw.py, which every check pins: the check runs osw only when it is that file. */
export const OSW_SHA256 = createHash("sha256").update(readFileSync(new URL("../image/osw/osw.py", import.meta.url))).digest("hex");
/** osw's environment: the desktop's display and size, and the run's own cache, which osw eval removes and makes again. */
const OSW_ENV = `env DISPLAY="$DISPLAY" SCREEN_WIDTH="\${WIDTH:-1920}" SCREEN_HEIGHT="\${HEIGHT:-1080}" OSW_CACHE=/tmp/computer-bench-{{nonce}}-osw-cache`;
/** osw setup as the desktop's own user, on the task's OSWorld JSON (the shell's $1) through stdin. */
const OSW_SETUP = `${FIND_DISPLAY}; printf '%s' "$1" | ${OSW_ENV} osw setup /dev/stdin`;
/**
 * osw eval the same way, but from a copy in a new folder, run by an isolated python3 (-I), and only when the copy's
 * sha256 is OSW_SHA256. The agent's turn ran as the same user and could have changed osw: then the check refuses in
 * words with 75, infra, never a score.
 */
const OSW_EVAL = [
	FIND_DISPLAY,
	`o=$(command -v osw) || { echo 'osw is not on PATH' >&2; exit 75; }`,
	"d=$(mktemp -d) || exit 75",
	`cp "$o" "$d/osw.py" || { rm -rf "$d"; exit 75; }`,
	`s=$(sha256sum "$d/osw.py" | cut -c1-64)`,
	`if [ "$s" != ${OSW_SHA256} ]; then rm -rf "$d"; echo "osw ($o) is not the bench's osw.py: its sha256 is $s, the bench's is ${OSW_SHA256}; the check refuses to run it, and the task is not scored" >&2; exit 75; fi`,
	`printf '%s' "$1" | ${OSW_ENV} python3 -I "$d/osw.py" eval /dev/stdin; c=$?`,
	`rm -rf "$d"`,
	"exit $c",
].join("; ");
const SETUP_FILES = "/tmp/computer-bench-{{nonce}}-osw-setup";
const SETUP_WAIT_S = 600;

/** The rubric every infeasible task of the suite shares. */
export const INFEASIBLE_RUBRIC = `# Rubric: an infeasible OSWorld task

From OSWorld-Verified (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab), which marks this
task infeasible: what the instruction asks can't be done as asked (the feature, version, app or setting it names does
not exist, or the request can't work). OSWorld passes an agent whose last action is FAIL; computer-bench has no such
action, so the agent says so in its final answer. Every infeasible task of the suite shares this rubric: read the
instruction for what it asks.

## Done means

- The final answer tells the user it can't be done as asked, and why: what does not exist or can't work.
- Nothing on the computer was changed to pretend otherwise.

## Also acceptable

- Offering a close alternative after saying the request can't be done as asked, as long as nothing is changed without
  the user asking.
- Looking first without changing anything (menus, settings, files, \`--version\`) to confirm it.

## Not done

- An answer that claims the task was done, or presents a workaround as the thing asked for.
- An answer that only asks for clarification without saying the request can't be done.
- Files, settings or apps changed to fake the result.

## What the checks cover

- \`answered\` proves there is a final answer, nothing of its words: whether it says the task can't be done, and why, is
  yours to judge.
`;

/** The task.json for a portable task. */
export function taskSpec(domain, task, { apps, infeasible, probes }) {
	const uuid = String(task.id);
	const needApps = [...apps].map((app) => DESKTOP_APPS[app]).filter((one) => one !== null);
	const unique = [...new Map(needApps.map((one) => [JSON.stringify(one), one])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const hasSetup = (task.config ?? []).length > 0;
	const usesOsw = hasSetup || !infeasible;
	const capabilities = [
		...(usesOsw ? [{ id: "osw", kind: "exec", why: "osw, which runs OSWorld's setup and evaluator, on PATH: the bench image has it, and a desktop without it skips the task, never fails it.", argv: ["sh", "-c", "command -v osw"] }] : []),
		...probes.map((probe) => ({ id: probe.command, kind: "exec", why: `The task ${probe.why}.`, argv: ["sh", "-c", `command -v ${probe.command}`] })),
	];
	const setup = hasSetup
		? [
				{
					method: "process.start",
					why: "osw setup, as the desktop's own user: OSWorld's own SetupController runs the task's config (downloads checked against their pinned sha256, files opened, apps launched) against OSWorld's server on loopback. A process, not exec.run, so the apps it launches outlive it (orphans: keep); its exit code goes beside its log.",
					params: { argv: ["sh", "-c", `${OSW_SETUP} > ${SETUP_FILES}.log 2>&1; echo $? > ${SETUP_FILES}.exit`, "sh", "{{file:osworld.json}}"], orphans: "keep" },
				},
				{
					method: "exec.run",
					why: `Wait for osw setup to end (${SETUP_WAIT_S} s at most) and exit with its code, the end of its log on stderr: a setup that did not end with 0 is infra, run again.`,
					params: {
						argv: ["sh", "-c", `f=${SETUP_FILES}; i=0; until [ -s $f.exit ]; do i=$((i+1)); if [ $i -gt ${SETUP_WAIT_S * 2} ]; then echo 'osw setup did not end within ${SETUP_WAIT_S} s' >&2; exit 75; fi; sleep 0.5; done; tail -c 400 $f.log >&2; exit "$(cat $f.exit)"`],
						timeoutMs: (SETUP_WAIT_S + 30) * 1000,
					},
				},
			]
		: [];
	const checks = infeasible
		? [{ id: "answered", kind: "answer", why: "The agent gave a final answer, which the grader reads for why the task can't be done. Its words are the grader's: this check only fails a run with none (a null run, or an agent that stopped silent), so the untouched state fails.", text: { empty: true, not: true } }]
		: [
				{
					id: "osworld",
					kind: "exec",
					why: "OSWorld's own evaluator for the task, run by osw eval after the agent ended, as the desktop's own user, and only when osw is the bench's osw.py (its sha256 pinned here). osw removes its cache and makes it again, then runs postconfig, then each getter and metric with its options, golds fetched only now and checked against their pinned sha256. Exit 0 is a score of 1 and 1 a lower score; 75 is a check that could not run (osw changed, or the server, a getter, a metric or a download failed), infra, run again.",
					argv: ["sh", "-c", OSW_EVAL, "sh", "{{file:osworld.json}}"],
					timeoutMs: 120000,
					infra: [75],
				},
			];
	const changes = infeasible
		? "OSWorld marks this task infeasible and passes an agent whose last action is FAIL. computer-bench has no FAIL action, so the agent says so in its final answer: an answer check proves there is one (not its words), and the agentic grader reads it and decides with rubric.md, which every infeasible task of the suite shares."
		: "Setup runs the task's config, and the check its evaluator, through osw in the bench image, as the desktop's own user: OSWorld's own SetupController, getters and metrics, on a Debian Xfce desktop instead of OSWorld's Ubuntu GNOME VM.";
	return {
		$schema: "../../../schema/task.schema.json",
		id: `osworld-verified.${dashed(domain)}.${uuid.slice(0, 8)}`,
		version: 1,
		title: titleOf(task.instruction),
		split: "heldout",
		source: {
			suite: "OSWorld-Verified",
			id: `${domain}/${uuid}`,
			revision: OSWORLD_REVISION,
			licence: LICENCE,
			changes: `osworld.json is the task's OSWorld JSON with each file-cache URL pinned to a dataset revision (main is ${DATASET_REVISION}) and each download and gold given its sha256. ${changes}`,
		},
		tags: ["osworld", "osworld-verified", dashed(domain), ...(infeasible ? ["infeasible"] : [])],
		needs: { os: "linux", kind: "desktop", ...(unique.length > 0 ? { apps: unique } : {}), ...(capabilities.length > 0 ? { capabilities } : {}) },
		...(setup.length > 0 ? { setup } : {}),
		exec: "deny",
		instruction: task.instruction,
		budget: { steps: 100, usd: 3, wall_s: 900 },
		...(infeasible ? { sufficient: false } : {}),
		checks,
	};
}

/**
 * One task, ported or refused: {folder, files} with the folder's files by name, or {reasons}. An infeasible task's
 * osworld.json is written too, for its setup and as its source.
 */
export function portTask(domain, task, context) {
	const classified = classify(task, context.names);
	const { json, problems, unsummed } = pinTask(task, context);
	const reasons = [...classified.reasons, ...(classified.reasons.length === 0 ? problems : [])];
	if (reasons.length > 0) return { reasons, unsummed: classified.reasons.length === 0 ? unsummed : [] };
	json.notice = `${NOTICE}, evaluation_examples/examples/${domain}/${task.id}.json at ${OSWORLD_REVISION}. Changed for computer-bench: each file-cache URL pinned to a dataset revision (main is ${DATASET_REVISION}), and each download and cloud_file gold given its sha256.`;
	const osworldJson = `${JSON.stringify(json, null, 2)}\n`;
	if (Buffer.byteLength(osworldJson) > MAX_INLINE_BYTES) return { reasons: [`osworld.json is ${Buffer.byteLength(osworldJson)} bytes, past the ${MAX_INLINE_BYTES} one argv word may hold`], unsummed: [] };
	const files = { "task.json": `${JSON.stringify(taskSpec(domain, task, classified), null, 2)}\n`, "osworld.json": osworldJson };
	if (classified.infeasible) files["rubric.md"] = INFEASIBLE_RUBRIC;
	return { folder: folderOf(domain, task.id), files, unsummed: [] };
}

/** A task's folder in the suite: `<domain>-<uuid8>`. */
const folderOf = (domain, uuid) => `${dashed(domain)}-${String(uuid).slice(0, 8)}`;

/** The checkout's tasks, in test_nogdrive.json's order: [{domain, task}]. */
export function readTasks(osworld) {
	const examples = join(osworld, "evaluation_examples");
	const ids = JSON.parse(readFileSync(join(examples, "test_nogdrive.json"), "utf8"));
	return Object.entries(ids).flatMap(([domain, uuids]) => uuids.map((uuid) => ({ domain, task: JSON.parse(readFileSync(join(examples, "examples", domain, `${uuid}.json`), "utf8")) })));
}

/** Every task of the checkout, ported or refused: [{domain, uuid, folder?, files?, reasons?, unsummed}]. */
export function portAll({ osworld, trees, sums = {} }) {
	const context = { names: osworldNames(osworld), trees, sums };
	const results = readTasks(osworld).map(({ domain, task }) => ({ domain, uuid: String(task.id), ...portTask(domain, task, context) }));
	const folders = results.filter((one) => one.folder).map((one) => one.folder);
	for (const folder of new Set(folders.filter((one, i) => folders.indexOf(one) !== i))) throw new Error(`two tasks would both be ${folder}`);
	return results;
}

/** The suite's PORT.md: where the tasks came from, the counts, and each refused task with its reasons. */
export function portMd(results, written) {
	const domains = [...new Set(results.map((one) => one.domain))];
	const rows = domains.map((domain) => {
		const of = results.filter((one) => one.domain === domain);
		const portable = of.filter((one) => one.folder);
		const infeasible = portable.filter((one) => one.files["rubric.md"] !== undefined);
		const here = portable.filter((one) => written.has(one.folder));
		return `| ${domain} | ${of.length} | ${portable.length} | ${infeasible.length} | ${of.length - portable.length} | ${here.length} |`;
	});
	const portable = results.filter((one) => one.folder);
	const refused = results.filter((one) => !one.folder);
	const total = `| **all** | **${results.length}** | **${portable.length}** | **${portable.filter((one) => one.files["rubric.md"] !== undefined).length}** | **${refused.length}** | **${portable.filter((one) => written.has(one.folder)).length}** |`;
	const cell = (text) => text.replace(/\|/g, "\\|");
	return `# OSWorld-Verified, ported by the loader

Written by \`scripts/port-osworld.mjs\`: run it again rather than edit this file. Each task folder holds \`task.json\` and
\`osworld.json\`, the task's own OSWorld JSON with its file-cache URLs pinned, and an infeasible task's folder the shared
\`rubric.md\`. Setup and the check run OSWorld's own code through osw (\`image/osw/osw.py\`) in the bench desktop image,
as the computer's own user, the agent's too: no root. The check runs osw only when its sha256 is the bench's osw.py
(\`${OSW_SHA256}\`, which each task pins), and osw eval removes its cache and makes it again before it fetches the golds,
each checked against its pinned sha256.
A pass rate on this suite is a number for the tasks written here under OSWorld's checks on our desktop, not an OSWorld
score.

- OSWorld: https://github.com/xlang-ai/OSWorld at \`${OSWORLD_REVISION}\`, \`evaluation_examples/test_nogdrive.json\`
  (${results.length} tasks: OSWorld-Verified without its Google Drive tasks).
- File cache: the Hugging Face dataset \`xlangai/ubuntu_osworld_file_cache\`, \`main\` pinned to \`${DATASET_REVISION}\`.
- Licence: OSWorld is Apache-2.0 (Copyright 2024 XLANG NLP Lab). Each \`osworld.json\` carries the notice and its
  changes in its \`notice\` field, and each \`task.json\` repeats them in \`source.licence\` and \`source.changes\`.

## Counts

Portable: the bench desktop runs the task as OSWorld wrote it. Written here: the portable tasks with a folder in this
suite.

| domain | tasks | portable | infeasible | refused | written here |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
${total}

## Refused

| task | why |
| --- | --- |
${refused.map((one) => `| \`${one.domain}/${one.uuid}\` | ${cell(one.reasons.join("; "))} |`).join("\n")}
`;
}

/**
 * Writes the domains' portable tasks into out (each folder made fresh) and removes the folder of each of their refused
 * tasks, which an earlier port may have written; a domain not written is left as it is. Then PORT.md over every task.
 */
export function writeSuite(results, out, domains = []) {
	mkdirSync(out, { recursive: true });
	const portable = new Set(results.filter((one) => one.folder).map((one) => one.folder));
	for (const one of results) {
		if (domains.length > 0 && !domains.includes(one.domain)) continue;
		if (!one.folder) {
			// A refused task whose uuid8 a portable one shares leaves that one's folder alone.
			const stale = folderOf(one.domain, one.uuid);
			if (!portable.has(stale)) rmSync(join(out, stale), { recursive: true, force: true });
			continue;
		}
		const dir = join(out, one.folder);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(one.files)) writeFileSync(join(dir, name), text);
	}
	const written = new Set(readdirSync(out).filter((name) => statSync(join(out, name)).isDirectory() && existsSync(join(out, name, "task.json"))));
	writeFileSync(join(out, "PORT.md"), portMd(results, written));
	return written;
}

/** The git blob id of bytes, as a tree lists a file outside LFS. */
export const gitOid = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Fetches each file the portable tasks need a sha256 for, checks it against its git oid, and adds oid → sha256. */
export async function fetchSums(results, sums, fetchBytes) {
	const wanted = new Map(results.flatMap((one) => one.unsummed ?? []).map((file) => [file.oid, file]));
	for (const file of wanted.values()) {
		const bytes = await fetchBytes(`${DATASET}${file.revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`);
		if (bytes.length !== file.size || gitOid(bytes) !== file.oid) throw new Error(`${file.path} at ${file.revision.slice(0, 8)}: ${bytes.length} bytes with oid ${gitOid(bytes)}, the tree says ${file.size} bytes with oid ${file.oid}`);
		sums[file.oid] = createHash("sha256").update(bytes).digest("hex");
	}
	return wanted.size;
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const args = { command, trees: [], domains: [] };
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i], rest[i + 1]];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--osworld") args.osworld = value;
		else if (flag === "--tree") args.trees.push(value);
		else if (flag === "--sums") args.sums = value;
		else if (flag === "--out") args.out = value;
		else if (flag === "--domain") args.domains.push(value);
		else throw new Error(`unknown option ${flag}`);
	}
	if (!["port", "sums"].includes(command) || !args.osworld || args.trees.length === 0 || !args.out) throw new Error("usage: port-osworld.mjs port|sums --osworld DIR --tree FILE [--tree REV=FILE ...] [--sums FILE] --out DIR|FILE [--domain D ...]");
	return args;
}

/** --tree FILE is the dataset revision's tree; --tree REV=FILE another revision's. */
function readTrees(specs) {
	return new Map(
		specs.map((spec) => {
			const at = spec.match(/^([0-9a-f]{40})=(.+)$/);
			return [at ? at[1] : DATASET_REVISION, treeOf(JSON.parse(readFileSync(at ? at[2] : spec, "utf8")))];
		}),
	);
}

async function main(argv) {
	const args = parseArgs(argv);
	const trees = readTrees(args.trees);
	if (args.command === "sums") {
		const sums = existsSync(args.out) ? JSON.parse(readFileSync(args.out, "utf8")) : {};
		const results = portAll({ osworld: args.osworld, trees, sums }).filter((one) => args.domains.length === 0 || args.domains.includes(one.domain));
		const fetched = await fetchSums(results, sums, async (url) => {
			const response = await fetch(url, { redirect: "follow" });
			if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		});
		writeFileSync(args.out, `${JSON.stringify(Object.fromEntries(Object.entries(sums).sort()), null, 2)}\n`);
		console.log(`${fetched} files fetched and checked; ${Object.keys(sums).length} sums in ${args.out}`);
		return;
	}
	const sums = args.sums ? JSON.parse(readFileSync(args.sums, "utf8")) : {};
	const results = portAll({ osworld: args.osworld, trees, sums });
	const written = writeSuite(results, args.out, args.domains);
	const portable = results.filter((one) => one.folder).length;
	console.log(`${results.length} tasks: ${portable} portable, ${results.length - portable} refused; ${written.size} task folders in ${args.out}`);
}

const { isMain } = await import(new URL("../../../scripts/is-main.mjs", import.meta.url).href);
if (isMain(import.meta)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`port-osworld: ${error.message}`);
		process.exitCode = 1;
	});
}
