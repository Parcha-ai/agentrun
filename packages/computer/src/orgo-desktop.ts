// Orgo's Windows and macOS desktops, daemon none: no computerd runs in them (CP-8, computerd for Windows and macOS, is
// deferred), so this provider answers the protocol's methods itself, in process, over Orgo's REST API, as the phone
// harness and Browserbase do. Every Orgo fact here is from docs.orgo.ai (read 2026-11-10; the pages are kept in the
// lane's vendor-docs/orgo/windows):
// - POST /computers takes os "windows" or "macos" on the same API as Linux. Windows needs Orgo's Scale plan or a Windows
//   computer bought on the plan (403 WINDOWS_REQUIRES_SCALE otherwise) and is never billed by the hour. macOS takes ram
//   10 and nothing else (400 MACOS_RAM_FIXED), has no ends_in_hours (400 ENDS_NOT_SUPPORTED) and needs a Mac host
//   serving the workspace (422 OS_UNAVAILABLE). A Mac Orgo manages may refuse a delete with 409.
// - GET /computers/{id}/screenshot?response_format=base64&format=png&scale=s answers { image, width, height } in PNG.
// - POST /computers/{id}/{click,mouse-move,drag,type,key,scroll} drive the screen. On Windows each answers { ok: true };
//   click takes x, y, button and double (no modifiers, no repeat); drag takes start_x, start_y, end_x, end_y and button;
//   type takes text alone, at most 20,000 bytes; key takes a key or a combination joined by "+", Windows key names
//   (pageup, pagedown); scroll takes direction (up or down) and amount (1 to 50) alone, at the pointer.
// - POST /computers/{id}/bash runs PowerShell on Windows, from the user's Desktop folder, and answers stdout, stderr,
//   exit_code and output; a command past its timeout answers exit_code 124 and error "timeout". The timeout is 1 to 300 s.
// - POST /files/upload with destPath drops a file into one folder of one computer (at most 10 MB).
// Nothing here runs in a computer Orgo does not read running: any action wakes a suspended one.
//
// What each desktop offers is what Orgo's API can answer: the screen, the pointer and the keys; exec, as PowerShell on
// Windows and the shell on macOS; and, on Windows, files, through PowerShell. No processes (Orgo runs a command and
// waits for it, nothing more), no network of its own (Orgo has no egress control: a program in the computer reaches the
// internet, so the network is "open", the one a provider that cannot hold a computer to none declares), and no mount.
// Orgo's API has no separate press and release: a down is held in the client and its up becomes one click (the pointer
// did not move) or one drag (from where it went down), so a press is seen on the screen only when it is released.
//
// The name carries the run, the epoch and the janitor's deadline, as the Linux desktop's does (orgo-names.ts). The rest
// of the labels is a file in the computer the provider writes at create (C:\ProgramData\agentrun\labels.json on Windows,
// /Users/Shared/agentrun/labels.json on macOS). Unlike Linux's root-owned file, a program in the computer can change it:
// the name, which only the provider's key can change, is what list, the janitor and the takeover trust.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkActions } from "./actions.js";
import { readPng } from "./conformance/png.js";
import { EPOCH_LABEL, RUN_LABEL } from "./labels.js";
import { checkMount } from "./mount.js";
import { ORGO_API_URL, type OrgoRest, orgoRest } from "./orgo-channel.js";
import {
	COMPUTER_ID,
	filterProblem,
	type LabelsFile,
	labelProblem,
	labelsOf,
	NAME_MAX,
	nameParts,
	type OrgoComputer,
	orgoName,
	refProblem,
	runHash,
	sameComputer,
	show,
	withDeadline,
} from "./orgo-names.js";
import { encodePng } from "./phone-harness.js";
import {
	type Button,
	type ComputerClient,
	type DaemonErrorKind,
	type DaemonMethod,
	type DaemonMethods,
	type Group,
	type HelloResult,
	type InputAction,
	type InputActionsResult,
	type Key,
	MAX_CHUNK_BYTES,
	MAX_LIST_ENTRIES,
	MAX_OUTPUT_BYTES,
	type Rect,
	type ScreenWatchResult,
} from "./protocol.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreatedComputer,
	checkLifetime,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { type ComputerError, type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "./screen-watch.js";
import { listTested } from "./test-connection.js";

/** The image a spec names for an Orgo Windows desktop (Windows Server 2019, Orgo's own). */
export const ORGO_WINDOWS_IMAGE = "windows";
/** The image a spec names for an Orgo macOS desktop. */
export const ORGO_MACOS_IMAGE = "macos";
/** What a Windows desktop offers: PowerShell for exec and files, and the screen, the pointer and the keys. */
export const WINDOWS_GROUPS: readonly Group[] = ["exec", "files", "screen", "input.pointer", "input.keys"];
/** What a macOS desktop offers: the shell for exec, and the screen, the pointer and the keys. */
export const MACOS_GROUPS: readonly Group[] = ["exec", "screen", "input.pointer", "input.keys"];

export type OrgoDesktopOs = "windows" | "macos";

/** The longest each kind of call may take, and the pause between two polls. */
export interface OrgoDesktopTimeouts {
	/** One REST call: get, delete, extend, a workspace's computers, one input call. */
	requestMs: number;
	/** The create call, and the wait until the computer runs and answers a command. */
	createMs: number;
	/** One command of the provider's own (the labels file, the user). */
	execMs: number;
	/** One whole list. */
	listMs: number;
	/** From a delete to a computer Orgo no longer has. */
	goneMs: number;
	/** The pause between two reads while create or release waits. */
	pollMs: number;
}

export interface OrgoDesktopOptions {
	/** Which desktop: Windows or macOS. */
	os: OrgoDesktopOs;
	/** The Orgo API key. Serve passes ORGO_API_KEY's value; the provider never reads the environment or logs it. */
	apiKey: string;
	/** The workspace this deployment's computers live in; the provider lists, attaches and releases only there. */
	workspaceId: string;
	/** Orgo's API, https; default https://www.orgo.ai/api. */
	apiUrl?: string;
	/** For tests: every REST call goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** The longest lifetime check takes: at most 720 h, the default (Orgo's longest end on Windows). */
	maxLifetimeMs?: number;
	timeouts?: Partial<OrgoDesktopTimeouts>;
	/** The version the computer's hello reports; default the provider's. Only the conformance drift case sets another. */
	daemonVersion?: string;
}

/** What differs between the two desktops. */
interface Profile {
	os: OrgoDesktopOs;
	image: string;
	groups: readonly Group[];
	/** Go's name for the architecture the desktop reports in hello. */
	arch: string;
	/** Where the labels file is. */
	labels: string;
	/** Where a file too large for one command waits, uploaded, before it takes its path (Windows' files.write). */
	staging?: string;
	/** Orgo's RAM sizes, in GB. */
	ram: readonly number[];
	/** Whether Orgo takes ends_in_hours, the vendor's backstop, for this os. */
	ends: boolean;
	/** Whether the spec may give cpus. */
	cpus: boolean;
	/** The most bytes of text one type call takes. */
	typeBytes: number;
	/** Whether click and drag take a button other than left, and click a repeat and modifiers. */
	windowsInput: boolean;
}

const PROFILES: Readonly<Record<OrgoDesktopOs, Profile>> = {
	windows: {
		os: "windows",
		image: ORGO_WINDOWS_IMAGE,
		groups: WINDOWS_GROUPS,
		arch: "amd64",
		labels: "C:\\ProgramData\\agentrun\\labels.json",
		staging: "C:\\ProgramData\\agentrun\\staging",
		ram: [4, 8, 16, 32],
		ends: true,
		cpus: true,
		typeBytes: 20_000,
		windowsInput: true,
	},
	macos: {
		os: "macos",
		image: ORGO_MACOS_IMAGE,
		groups: MACOS_GROUPS,
		arch: "arm64",
		labels: "/Users/Shared/agentrun/labels.json",
		ram: [10],
		ends: false,
		cpus: false,
		// At Orgo's 12 ms a keystroke, about 2,500 characters fit the API's 30 s wait: a third of it, to be safe.
		typeBytes: 800,
		windowsInput: false,
	},
};

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const HOUR = 3_600_000;
const MAX_LIFETIME_MS = 720 * HOUR;
const CPU_FOR_RAM: Record<number, number> = { 4: 1, 8: 2, 16: 4, 32: 6 };
const CPUS = [0.5, 1, 2, 4, 6];
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEFAULTS: OrgoDesktopTimeouts = { requestMs: 30_000, createMs: 600_000, execMs: 60_000, listMs: 60_000, goneMs: 120_000, pollMs: 2_000 };
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "labels"]);
/** The states in which a computer runs, or is on its way to. */
const RUNNING = new Set(["running", "creating", "restarting", "updating", "resuming"]);
/** How often a delete that answers 409 (the computer waking) is tried again. */
const DELETE_TRIES = 5;
/** Orgo's bash call's longest timeout, in seconds, and how much longer its proxy waits. */
const BASH_MAX_S = 300;
const BASH_PROXY_MS = 30_000;
/** How often a waiting screen.watch reads the screen, as the phone's does. */
const WATCH_POLL_MS = 1_000;
/** How much of a file one files.read through PowerShell carries back: base64 of it stays well inside one answer. */
const READ_CHUNK_BYTES = 256 * 1024;
/** The most base64 a files.write puts inline in a PowerShell command; more goes through Orgo's upload first. */
const INLINE_WRITE_CHARS = 96 * 1024;
/** Orgo's scroll takes at most 50 wheel clicks a call. */
const SCROLL_MAX = 50;
const NETWORK = 'an Orgo Windows or macOS computer takes network "open" only: Orgo has no egress control, and no computerd runs in it to hold its programs to loopback';

const seconds = (ms: number) => `${ms / 1000} s`;
const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		}
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});

/** One word for PowerShell: single-quoted, with every quote PowerShell reads as a single quote doubled. */
export const psQuote = (word: string) => `'${word.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
/** One word for a POSIX shell: single-quoted. */
export const shQuote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
/** An environment variable's name either shell takes as written. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An absolute Windows path: a drive and a separator, or a UNC path. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/;

/** What Orgo's bash call answers, read: Windows's split streams, or Linux's and (as far as is known) macOS's combined output. */
interface Ran {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * The command that runs argv on this desktop, as Orgo's bash call takes it: on Windows a PowerShell call operator over
 * quoted words, whose exit is the program's own ($LASTEXITCODE), or 0 and 1 for a cmdlet; on macOS the words quoted for
 * the shell, through env for the variables. cwd and env are set first; argv is never a shell string.
 */
export function commandOf(os: OrgoDesktopOs, argv: readonly string[], { cwd, env }: { cwd?: string; env?: Record<string, string> } = {}): string {
	if (os === "windows") {
		return [
			"$ErrorActionPreference = 'Continue'",
			...Object.entries(env ?? {}).map(([name, value]) => `Set-Item -LiteralPath ${psQuote(`Env:${name}`)} -Value ${psQuote(value)}`),
			...(cwd === undefined ? [] : [`Set-Location -LiteralPath ${psQuote(cwd)}`]),
			`& ${argv.map(psQuote).join(" ")}`,
			"$agentrunOk = $?; $agentrunCode = $LASTEXITCODE",
			"if ($null -ne $agentrunCode) { exit $agentrunCode } elseif ($agentrunOk) { exit 0 } else { exit 1 }",
		].join("\n");
	}
	const vars = Object.entries(env ?? {}).map(([name, value]) => shQuote(`${name}=${value}`));
	const run = vars.length > 0 ? `env ${vars.join(" ")} ${argv.map(shQuote).join(" ")}` : argv.map(shQuote).join(" ");
	return cwd === undefined ? run : `cd ${shQuote(cwd)} && ${run}`;
}

/**
 * The files methods on Windows, as one PowerShell script: its request is base64 of JSON in place of the marker, so no
 * value is ever quoted into the script, and its one line of output is JSON, the result or { error, message }.
 */
const FILES_SCRIPT = [
	"# agentrun-computer: orgo-windows-files",
	"$ErrorActionPreference = 'Stop'",
	"$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@REQUEST@@')) | ConvertFrom-Json",
	"function Say($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress -Depth 6)) }",
	"function Refuse($kind, $words) { Say @{ error = $kind; message = $words }; exit 2 }",
	"function StatOf($i) {",
	"  $t = if ($i.LinkType) { 'symlink' } elseif ($i.PSIsContainer) { 'dir' } else { 'file' }",
	"  $m = if ($i.PSIsContainer) { 493 } elseif ($i.IsReadOnly) { 292 } else { 420 }",
	"  $s = if ($i.PSIsContainer) { 0 } else { [int64]$i.Length }",
	"  $at = [int64](($i.LastWriteTimeUtc - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds)",
	"  $o = @{ type = $t; size = $s; mode = $m; mtimeMs = $at; uid = 0; gid = 0 }",
	"  if ($i.LinkType -and $i.Target) { $o.target = [string]@($i.Target)[0] }",
	"  $o",
	"}",
	"function Parent($path) { Split-Path -LiteralPath $path -Parent }",
	"try {",
	"  switch ($p.op) {",
	"    'read' {",
	"      if (Test-Path -LiteralPath $p.path -PathType Container) { Refuse 'is_dir' \"$($p.path) is a folder\" }",
	"      $f = [IO.File]::Open($p.path, 'Open', 'Read', 'ReadWrite')",
	"      try {",
	"        $size = $f.Length",
	"        if ($p.offset -gt $size) { $p.offset = $size }",
	"        [void]$f.Seek([int64]$p.offset, 'Begin')",
	"        $buf = New-Object byte[] ([int][Math]::Max(0, [Math]::Min([int64]$p.length, $size - [int64]$p.offset)))",
	"        $n = 0",
	"        while ($n -lt $buf.Length) { $r = $f.Read($buf, $n, $buf.Length - $n); if ($r -le 0) { break }; $n += $r }",
	"      } finally { $f.Close() }",
	"      Say @{ data = [Convert]::ToBase64String($buf, 0, $n); size = $size }",
	"    }",
	"    'write' {",
	"      if (Test-Path -LiteralPath $p.path -PathType Container) { Refuse 'is_dir' \"$($p.path) is a folder\" }",
	"      $dir = Parent $p.path",
	"      if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) {",
	"        if ($p.parents) { [void](New-Item -ItemType Directory -Force -Path $dir) } else { Refuse 'not_found' \"no folder $dir\" }",
	"      }",
	"      $bytes = if ($p.staged) { [IO.File]::ReadAllBytes($p.staged) } else { [Convert]::FromBase64String($p.data) }",
	"      if ($null -ne $p.offset -or $p.append) {",
	"        $f = [IO.File]::Open($p.path, 'OpenOrCreate', 'Write', 'Read')",
	"        try { if ($p.append) { [void]$f.Seek(0, 'End') } else { [void]$f.Seek([int64]$p.offset, 'Begin') }; $f.Write($bytes, 0, $bytes.Length); $size = $f.Length } finally { $f.Close() }",
	"      } else { [IO.File]::WriteAllBytes($p.path, $bytes); $size = $bytes.Length }",
	"      if ($p.staged) { Remove-Item -LiteralPath $p.staged -Force }",
	"      Say @{ size = [int64]$size }",
	"    }",
	"    'stat' { Say (StatOf (Get-Item -LiteralPath $p.path -Force)) }",
	"    'list' {",
	"      if (-not (Test-Path -LiteralPath $p.path -PathType Container)) {",
	"        if (Test-Path -LiteralPath $p.path) { Refuse 'not_dir' \"$($p.path) is not a folder\" } else { Refuse 'not_found' \"no folder $($p.path)\" }",
	"      }",
	"      $all = New-Object System.Collections.ArrayList",
	"      $limit = [int]$p.offset + [int]$p.max + 1",
	"      function Walk($dir, $level) {",
	"        foreach ($i in (Get-ChildItem -LiteralPath $dir -Force | Sort-Object Name)) {",
	"          if ($all.Count -ge $limit) { return }",
	"          $o = StatOf $i; $o.path = $i.FullName; [void]$all.Add($o)",
	"          if ($i.PSIsContainer -and -not $i.LinkType -and $level -lt $p.depth) { Walk $i.FullName ($level + 1) }",
	"        }",
	"      }",
	"      Walk $p.path 1",
	"      $page = @($all | Select-Object -Skip ([int]$p.offset) -First ([int]$p.max))",
	"      Say @{ entries = $page; truncated = ($all.Count -gt [int]$p.offset + [int]$p.max) }",
	"    }",
	"    'mkdir' {",
	"      if (Test-Path -LiteralPath $p.path) {",
	"        if ($p.parents -and (Test-Path -LiteralPath $p.path -PathType Container)) { Say @{}; break }",
	"        Refuse 'exists' \"$($p.path) is there already\"",
	"      }",
	"      $dir = Parent $p.path",
	"      if ($dir -and -not $p.parents -and -not (Test-Path -LiteralPath $dir -PathType Container)) { Refuse 'not_found' \"no folder $dir\" }",
	"      [void](New-Item -ItemType Directory -Force -Path $p.path)",
	"      Say @{}",
	"    }",
	"    'move' {",
	"      if (-not (Test-Path -LiteralPath $p.from)) { Refuse 'not_found' \"no $($p.from)\" }",
	"      if ((Test-Path -LiteralPath $p.to) -and -not $p.overwrite) { Refuse 'exists' \"$($p.to) is there already\" }",
	"      Move-Item -LiteralPath $p.from -Destination $p.to -Force:([bool]$p.overwrite)",
	"      Say @{}",
	"    }",
	"    'remove' {",
	"      if (-not (Test-Path -LiteralPath $p.path)) { Refuse 'not_found' \"no $($p.path)\" }",
	"      $i = Get-Item -LiteralPath $p.path -Force",
	"      if ($i.PSIsContainer -and -not $i.LinkType -and -not $p.recursive -and @(Get-ChildItem -LiteralPath $p.path -Force).Count -gt 0) { Refuse 'invalid' \"$($p.path) is a folder that is not empty: remove it with recursive\" }",
	"      Remove-Item -LiteralPath $p.path -Force -Recurse:([bool]$p.recursive)",
	"      Say @{}",
	"    }",
	"    default { Refuse 'unsupported' \"$($p.op) is not a files method\" }",
	"  }",
	"} catch {",
	"  $e = $_.Exception",
	"  $kind = switch -regex ($e.GetType().Name) { 'NotFound' { 'not_found' } 'UnauthorizedAccess|Security' { 'denied' } 'PathTooLong' { 'limit' } default { 'invalid' } }",
	"  Refuse $kind $e.Message",
	"}",
].join("\n");

/** The labels file written, as each desktop's shell does it: its text base64 in the command, never quoted into it. */
function labelsWriteCommand(profile: Profile, text: string): string {
	const b64 = Buffer.from(text, "utf8").toString("base64");
	if (profile.os === "windows") {
		return [
			`$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
			`$p = ${psQuote(profile.labels)}`,
			"[void](New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p -Parent))",
			"[IO.File]::WriteAllText(\"$p.part\", $t); Move-Item -LiteralPath \"$p.part\" -Destination $p -Force",
		].join("\n");
	}
	const dir = profile.labels.slice(0, profile.labels.lastIndexOf("/"));
	return `mkdir -p ${shQuote(dir)} && printf '%s' ${shQuote(text)} > ${shQuote(`${profile.labels}.part`)} && mv -f ${shQuote(`${profile.labels}.part`)} ${shQuote(profile.labels)}`;
}

/** The labels file read: its text, or exit 3 when there is none. */
function labelsReadCommand(profile: Profile): string {
	if (profile.os === "windows") return `$p = ${psQuote(profile.labels)}; if (Test-Path -LiteralPath $p) { [Console]::Out.Write([IO.File]::ReadAllText($p)) } else { exit 3 }`;
	return `[ -f ${shQuote(profile.labels)} ] && cat ${shQuote(profile.labels)} || exit 3`;
}

/**
 * Who the computer's programs run as, as uid:gid: on Windows 0:0 for a member of the Administrators group (it can do
 * anything a root can), else its account's relative id twice; on macOS what id says.
 */
function userCommand(profile: Profile): string {
	if (profile.os === "windows") {
		return [
			"$i = [Security.Principal.WindowsIdentity]::GetCurrent()",
			"$admin = ([Security.Principal.WindowsPrincipal]$i).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
			"$rid = $i.User.Value.Split('-')[-1]",
			"if ($admin) { [Console]::Out.Write('0:0') } else { [Console]::Out.Write(\"${rid}:${rid}\") }",
		].join("; ");
	}
	return 'printf "%s:%s" "$(id -u)" "$(id -g)"';
}

/**
 * Orgo's Windows and macOS desktops: see the module's header. A spec's image is "windows" or "macos", the one this
 * provider was built for; cpus and memoryMb are Orgo's sizes; the network is open.
 */
export class OrgoDesktopProvider implements ComputerProvider {
	readonly id = "orgo";
	readonly version = VERSION;
	readonly #rest: OrgoRest;
	readonly #workspaceId: string;
	readonly #profile: Profile;
	readonly #maxLifetimeMs: number;
	readonly #timeouts: OrgoDesktopTimeouts;
	readonly #daemonVersion: string;
	/** Each computer's extend in flight, by id: the next waits for it, so two never read the same old deadline. */
	readonly #extending = new Map<string, Promise<unknown>>();

	constructor({ os, apiKey, workspaceId, apiUrl = ORGO_API_URL, fetch, maxLifetimeMs = MAX_LIFETIME_MS, timeouts = {}, daemonVersion = VERSION }: OrgoDesktopOptions) {
		if (os !== "windows" && os !== "macos") throw new Error(`os is "windows" or "macos" for an Orgo desktop Orgo's API answers, not ${JSON.stringify(os)}`);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, an Orgo API key, is required");
		if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) throw new Error("options.workspaceId, the Orgo workspace this deployment's computers live in, is required");
		let url: URL;
		try {
			url = new URL(apiUrl);
		} catch {
			throw new Error("options.apiUrl is not a URL");
		}
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("options.apiUrl must be https, with no credentials in it: the key goes to it");
		if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MAX_LIFETIME_MS) throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 720 h (${MAX_LIFETIME_MS} ms)`);
		const merged = { ...DEFAULTS, ...timeouts };
		for (const [key, value] of Object.entries(merged)) {
			if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) throw new Error(`timeouts.${key} must be a whole number of ms above 0`);
		}
		this.#rest = orgoRest({ apiKey, apiUrl: url.href, ...(fetch ? { fetch } : {}) });
		this.#workspaceId = workspaceId;
		this.#profile = PROFILES[os];
		this.#maxLifetimeMs = maxLifetimeMs;
		this.#timeouts = merged;
		this.#daemonVersion = daemonVersion;
	}

	/** A client of the computer, opened: its screen read, its hello this provider's own version, or a refusal in words. */
	async #open(ref: ComputerRef, signal?: AbortSignal): Promise<Result<{ client: OrgoDesktopClient; hello: HelloResult }>> {
		const client = new OrgoDesktopClient(this.#rest, ref.id, this.#profile, this.#workspaceId, this.#timeouts.requestMs);
		const hello = await client.open(this.#daemonVersion, signal);
		if (!hello.ok) {
			client.close();
			return fail(hello.error.code, `the screen of ${ref.name} could not be read: ${hello.error.message}`);
		}
		if (hello.value.version !== this.version) {
			client.close();
			return fail("refused", `hello: the daemon reports version ${hello.value.version}, expected ${this.version}`);
		}
		return ok({ client, hello: hello.value });
	}

	/**
	 * daemon none: the provider answers every method over Orgo's API. lifetime janitor: the deadline is in the name, and
	 * on Windows Orgo's end (whole hours) is the backstop. network open alone, never read back from inside: Orgo has no
	 * egress control and no computerd runs here to probe from inside. release delete alone.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "desktop",
			lifetime: "janitor",
			network: ["open"],
			networkReadBack: false,
			isolation: "vm",
			os: this.#profile.os,
			daemon: "none",
			groups: [...this.#profile.groups],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, labels, mount } = given;
		const profile = this.#profile;
		if (image !== profile.image) refuse("image", `this Orgo provider makes ${profile.os} desktops: its image is ${JSON.stringify(profile.image)}`);
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (network !== "open") refuse("network", NETWORK);
		if (memoryMb !== undefined && !profile.ram.some((gb) => gb * 1024 === memoryMb)) refuse("memoryMb", `memoryMb is one of Orgo's ${profile.os} sizes: ${profile.ram.map((gb) => gb * 1024).join(", ")}`);
		if (cpus !== undefined && !(profile.cpus && CPUS.includes(cpus as number))) refuse("cpus", profile.cpus ? "cpus is one of Orgo's sizes: 0.5, 1, 2, 4 or 6" : `an Orgo ${profile.os} computer's cpus are its host's: leave cpus unset`);
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		refusals.push(...checkMount(mount, []));
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || field === "mount" || value === undefined) continue;
			if (field === "user") refuse(field, `an Orgo ${profile.os} computer's programs run as Orgo's own user; a spec cannot name another`);
			else if (field === "workdir") refuse(field, `an Orgo ${profile.os} computer's programs start where Orgo starts them; a spec cannot name a folder`);
			else if (field === "pids") refuse(field, "Orgo offers no pids limit to set; leave pids unset");
			else refuse(field, `an Orgo ${profile.os} computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: CallContext = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		if (signal?.aborted) return fail("aborted", "create was aborted before Orgo was called");
		const profile = this.#profile;
		const labels = { ...spec.labels };
		const now = Date.now();
		const deadline = new Date(now + spec.lifetimeMs).toISOString();
		const maxDeadline = new Date(now + this.#maxLifetimeMs).toISOString();
		const name = orgoName(labels, randomBytes(6).toString("hex"), new Date(deadline));
		if (name.length > NAME_MAX || nameParts(name) === undefined) return fail("invalid", `the name ${name} is not one Orgo holds: at most ${NAME_MAX} of letters, digits and dashes`);
		const ram = spec.memoryMb === undefined ? (profile.ram[0] as number) : spec.memoryMb / 1024;
		const cpu = profile.cpus ? (spec.cpus ?? (CPU_FOR_RAM[ram] as number)) : undefined;
		const body = {
			workspace_id: this.#workspaceId,
			name,
			os: profile.os,
			ram,
			...(cpu === undefined ? {} : { cpu }),
			// Orgo's end, the vendor's backstop where it has one: whole hours, deleting the computer. The janitor ends it on time.
			...(profile.ends ? { ends_in_hours: Math.max(1, Math.ceil(spec.lifetimeMs / HOUR)) } : {}),
		};
		const made = await this.#rest.request<OrgoComputer>("POST", "/computers", { body, timeoutMs: this.#timeouts.createMs, ...(signal ? { signal } : {}) });
		if (!made.ok) {
			// A create Orgo refused (a 4xx) made nothing. One whose answer never came may have: it goes by its name.
			if (["invalid", "denied", "limit", "not_found", "refused"].includes(made.error.code)) return made;
			return fail(made.error.code, `${made.error.message}${await this.#deleteNamed(name)}`);
		}
		const id = made.value?.id;
		if (typeof id !== "string" || !COMPUTER_ID.test(id)) return fail("orgo", `Orgo's create answered no computer id${await this.#deleteNamed(name)}`);
		const ref = { id, name };
		const file: LabelsFile = { name, labels, deadline, maxDeadline, image: profile.image, ...(cpu === undefined ? {} : { cpus: cpu }), memoryMb: ram * 1024 };
		const prepared = await this.#prepare(ref, made.value.status, file, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" });
		if (prepared.ok) return ok(ref);
		return this.#abandon(ref, prepared.error);
	}

	/** Running, answering a command, its labels file written, then its screen and the hello a connection answers. */
	async #prepare(ref: ComputerRef, status: string, file: LabelsFile, signal?: AbortSignal): Promise<Result<void>> {
		const running = status === "running" ? ok(undefined) : await this.#untilRunning(ref, signal);
		if (!running.ok) return running;
		const until = Date.now() + this.#timeouts.createMs;
		// A computer Orgo reads running may not take a command yet (503 "Computer not ready" while it boots): tried until it does.
		for (;;) {
			const written = await this.#shell(ref.id, labelsWriteCommand(this.#profile, JSON.stringify(file)), this.#timeouts.execMs, signal);
			if (written.ok && written.value.exitCode === 0) break;
			if (signal?.aborted) return fail("aborted", "create was aborted while the computer started");
			if (written.ok) return fail("refused", `writing the labels file ${this.#profile.labels} in ${ref.name} failed (exit ${written.value.exitCode}): ${(written.value.stderr || written.value.stdout).trim().slice(0, 300)}`);
			if (Date.now() >= until) return fail(written.error.code, `${ref.name} did not take a command within ${seconds(this.#timeouts.createMs)}: ${written.error.message}`);
			await pause(this.#timeouts.pollMs, signal);
		}
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		opened.value.client.close();
		return ok(undefined);
	}

	/** Polls Orgo until it reads the computer running, within createMs. */
	async #untilRunning(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const until = Date.now() + this.#timeouts.createMs;
		let last = "unread";
		for (;;) {
			const read = await this.#get(ref.id, signal);
			if (!read.ok) return read;
			last = read.value.status;
			if (last === "running") return ok(undefined);
			if (!RUNNING.has(last)) return fail("orgo", `Orgo read ${ref.name} ${last}, not running`);
			if (Date.now() >= until) return fail("timeout", `Orgo did not read ${ref.name} running within ${seconds(this.#timeouts.createMs)}; it last read ${last}`);
			await pause(this.#timeouts.pollMs, signal);
			if (signal?.aborted) return fail("aborted", "create was aborted while Orgo made the computer");
		}
	}

	/** One command of the provider's own through Orgo's bash call (PowerShell on Windows), read as Ran. */
	#shell(id: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<Ran>> {
		return bashCall(this.#rest, id, command, timeoutMs, signal);
	}

	/** The labels file, read in the computer. */
	async #readLabels(ref: ComputerRef, signal?: AbortSignal): Promise<Result<LabelsFile>> {
		const read = await this.#shell(ref.id, labelsReadCommand(this.#profile), this.#timeouts.execMs, signal);
		if (!read.ok) return read;
		if (read.value.exitCode !== 0) return fail("refused", `${ref.name} has no labels file ${this.#profile.labels} to read (exit ${read.value.exitCode})`);
		const file = labelsOf(read.value.stdout, this.#profile.labels);
		return typeof file === "string" ? fail("refused", `${ref.name}: ${file}`) : ok(file);
	}

	async #writeLabels(ref: ComputerRef, file: LabelsFile, signal?: AbortSignal): Promise<Result<void>> {
		const written = await this.#shell(ref.id, labelsWriteCommand(this.#profile, JSON.stringify(file)), this.#timeouts.execMs, signal);
		if (!written.ok) return written;
		return written.value.exitCode === 0 ? ok(undefined) : fail("refused", `writing ${this.#profile.labels} in ${ref.name} failed (exit ${written.value.exitCode})`);
	}

	/** Orgo's record of a computer; not_found once Orgo no longer has it. */
	async #get(id: string, signal?: AbortSignal): Promise<Result<OrgoComputer>> {
		const read = await this.#rest.request<OrgoComputer>("GET", `/computers/${encodeURIComponent(id)}`, { timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		if (typeof read.value?.name !== "string" || typeof read.value.status !== "string") return fail("orgo", `Orgo's record of ${id} has no name or status`);
		return ok(read.value);
	}

	/**
	 * Whether Orgo's record is a computer of this provider: its name's shape, in this workspace, of this os where Orgo
	 * says it (a workspace's listing may not).
	 */
	#ours(record: OrgoComputer, name?: string): boolean {
		return (
			nameParts(record.name) !== undefined &&
			(record.workspace_id ?? record.project_id) === this.#workspaceId &&
			(name === undefined || sameComputer(record.name, name)) &&
			record.status !== "deleted" &&
			(record.os === undefined || record.os === this.#profile.os)
		);
	}

	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<OrgoComputer>> {
		const read = await this.#get(ref.id, signal);
		if (!read.ok) return read.error.code === "not_found" ? fail("not_found", `no Orgo computer is ${ref.name} (${ref.id})`) : read;
		if (!this.#ours(read.value, ref.name)) return fail("not_found", `no Orgo ${this.#profile.os} computer of this provider named ${ref.name} has the id ${ref.id}`);
		return read;
	}

	/** Deletes a computer create gives up on, and waits until Orgo no longer has it. Never signalled: it outlives an abort. */
	async #abandon(ref: ComputerRef, error: ComputerError): Promise<Result<never>> {
		const deleted = await this.#delete(ref);
		return fail(error.code, `the computer ${ref.name} ${deleted.ok ? "was deleted" : `could not be deleted (${deleted.error.message})`}: ${error.message}`);
	}

	/** Every computer of this workspace with the name create gave: for a create whose answer never came. Best effort, in words. */
	async #deleteNamed(name: string): Promise<string> {
		const listed = await this.#desktops();
		if (!listed.ok) return `; a computer named ${name} may be left (${listed.error.message})`;
		const found = listed.value.filter((one) => one.name === name);
		if (found.length === 0) return `; no computer named ${name} is in the workspace`;
		const said = [];
		for (const one of found) {
			const deleted = await this.#delete({ id: one.id, name });
			said.push(deleted.ok ? `${one.id} was deleted` : `${one.id} may be left (${deleted.error.message})`);
		}
		return `; the computer named ${name}: ${said.join("; ")}`;
	}

	/** DELETE, tried again while Orgo answers 409 computer_waking, then the wait until Orgo no longer has the computer. */
	async #delete(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const { requestMs, pollMs, goneMs } = this.#timeouts;
		for (let tries = 1; ; tries++) {
			const deleted = await this.#rest.request("DELETE", `/computers/${encodeURIComponent(ref.id)}`, { timeoutMs: requestMs });
			if (deleted.ok || deleted.error.code === "not_found") break;
			const { status, orgoCode } = deleted as { status?: number; orgoCode?: string };
			// A Mac Orgo manages is given back, never deleted: said in Orgo's words, and left.
			if (status !== 409 || orgoCode !== "computer_waking" || tries >= DELETE_TRIES) return deleted;
			await pause(pollMs);
		}
		const until = Date.now() + goneMs;
		let last = "unread";
		for (;;) {
			const read = await this.#get(ref.id, signal);
			if (!read.ok && read.error.code === "not_found") return ok(undefined);
			if (read.ok && read.value.status === "deleted") return ok(undefined);
			if (!read.ok && read.error.code !== "timeout") return fail(read.error.code, `release of ${ref.name}: reading it back failed (${read.error.message})`);
			last = read.ok ? read.value.status : read.error.message;
			if (Date.now() >= until) return fail("timeout", `${ref.name} was still there ${seconds(goneMs)} after its delete; Orgo last read ${last}`);
			await pause(pollMs, signal);
			if (signal?.aborted) return fail("aborted", `the wait for ${ref.name} to go was aborted; Orgo last read ${last}`);
		}
	}

	/** The workspace's computers, as Orgo lists them. */
	async #desktops(signal?: AbortSignal): Promise<Result<OrgoComputer[]>> {
		const read = await this.#rest.request<{ desktops?: unknown }>("GET", `/workspaces/${encodeURIComponent(this.#workspaceId)}`, { timeoutMs: this.#timeouts.listMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		const desktops = read.value?.desktops;
		if (!Array.isArray(desktops)) return fail("orgo", `Orgo's workspace ${this.#workspaceId} lists no computers array`);
		return ok(desktops.filter((one): one is OrgoComputer => typeof one?.id === "string" && typeof one.name === "string").map((one) => ({ ...one, workspace_id: this.#workspaceId })));
	}

	/** The live view: screen.watch on a connection of the watch's own (daemonWatch), the client's polled screenshots. */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (found.value.status !== "running") return fail("refused", `${ref.name} is ${found.value.status}, not running: a connection's first call would wake it`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { client, hello } = opened.value;
		return ok({ client, hello, close: async () => client.close() });
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			if (typeof given.id !== "string" || !COMPUTER_ID.test(given.id)) return fail("invalid", `${String(given.id)} is not an Orgo computer id`);
			const read = await this.#get(given.id, signal);
			if (!read.ok) return read.error.code === "not_found" ? fail("not_found", `no Orgo computer has the id ${given.id}`) : read;
			if (!this.#ours(read.value)) return fail("not_found", `no Orgo ${this.#profile.os} computer of this provider has the id ${given.id}`);
			return this.#attached(read.value, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no Orgo computer has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${words}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const found = await this.#own((listed.value[0] as ComputerInfo).ref, signal);
		if (!found.ok) return found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The check of a computer attach did not make: its labels file held to its name, who its programs run as, and the
	 * hello its screen answers. A computer that does not run is refused: reading it would wake it.
	 */
	async #attached(record: OrgoComputer, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const ref = { id: record.id, name: record.name };
		if (record.status !== "running") return fail("refused", `${ref.name} is ${record.status}: its labels file and screen are read from inside, and a read would wake it`);
		const file = await this.#readLabels(ref, signal);
		if (!file.ok) return file;
		const found: string[] = [];
		const parts = nameParts(record.name) as { run?: string; epoch?: string };
		const { labels } = file.value;
		if (typeof file.value.name !== "string" || !sameComputer(file.value.name, record.name)) found.push(`name: Orgo's is ${record.name}, the labels file's ${show(file.value.name)}`);
		const run = labels[RUN_LABEL];
		if ((parts.run ?? "") !== (typeof run === "string" && run !== "" ? runHash(run) : "")) found.push(`run: the name's run hash ${show(parts.run)} is not the labels file's run ${show(run)}`);
		if ((parts.epoch ?? "") !== (labels[EPOCH_LABEL] ?? "")) found.push(`epoch: the name says ${show(parts.epoch)}, the labels file ${show(labels[EPOCH_LABEL])}`);
		if (file.value.image !== this.#profile.image) found.push(`image: the labels file says ${show(file.value.image)}, not ${this.#profile.image}`);
		const deadline = new Date(file.value.deadline);
		if (Number.isNaN(deadline.getTime())) found.push(`deadline: the labels file reads ${show(file.value.deadline)}, not a time`);
		if (found.length > 0) return fail("refused", `the computer ${ref.name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		const user = await this.#shell(ref.id, userCommand(this.#profile), this.#timeouts.execMs, signal);
		if (!user.ok) return user;
		const ids = /^(\d+):(\d+)$/.exec(user.value.stdout.trim());
		if (user.value.exitCode !== 0 || ids === null) return fail("orgo", `who ${ref.name}'s programs run as could not be read (exit ${user.value.exitCode}): ${user.value.stdout.trim().slice(0, 100)}`);
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		opened.value.client.close();
		return ok({
			...ref,
			spec: {
				image: file.value.image,
				user: `${ids[1]}:${ids[2]}`,
				network: "open",
				...(file.value.cpus === undefined ? {} : { cpus: file.value.cpus }),
				...(file.value.memoryMb === undefined ? {} : { memoryMb: file.value.memoryMb }),
				deadline,
				kind: "desktop",
			},
		});
	}

	/**
	 * Every computer of this provider in the workspace that carries all of these labels. The run and the epoch are read
	 * from the name, with nothing run in a computer, so a stopped one is listed too; any other label is read from the
	 * labels file of a running computer (a stopped one is not woken, so it proves no such label and is left out).
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const listed = await this.#desktops(signal);
		if (!listed.ok) return listed;
		const others = Object.keys(labels).filter((key) => key !== RUN_LABEL && key !== EPOCH_LABEL);
		const infos: ComputerInfo[] = [];
		for (const record of listed.value) {
			const parts = nameParts(record.name);
			if (parts === undefined || !this.#ours(record)) continue;
			if (labels[RUN_LABEL] !== undefined && parts.run !== runHash(labels[RUN_LABEL])) continue;
			if (labels[EPOCH_LABEL] !== undefined && parts.epoch !== labels[EPOCH_LABEL]) continue;
			const ref = { id: record.id, name: record.name };
			let read: Record<string, string> = {
				...(labels[RUN_LABEL] !== undefined ? { [RUN_LABEL]: labels[RUN_LABEL] } : {}),
				...(parts.epoch !== undefined ? { [EPOCH_LABEL]: parts.epoch } : {}),
			};
			let deadline: Date | undefined = parts.deadline ?? (typeof record.ends_at === "string" ? new Date(record.ends_at) : undefined);
			if (others.length > 0) {
				if (record.status !== "running") continue;
				const file = await this.#readLabels(ref, signal);
				if (!file.ok || !others.every((key) => file.value.labels[key] === labels[key])) continue;
				read = { ...file.value.labels };
				deadline = parts.deadline ?? new Date(file.value.deadline);
			}
			infos.push({ ref, labels: read, deadline, state: RUNNING.has(record.status) ? "running" : "stopped", network: "open" });
		}
		return ok(infos);
	}

	/** Settings' test: one read of the workspace's computers (list with no label to read from inside), which makes nothing. */
	async testConnection(context: CallContext = {}): Promise<Result<{ detail: string }>> {
		return listTested("Orgo", await this.list({}, context));
	}

	/** open: what Orgo gives, the one network here; never read from inside, and a change is refused. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (policy !== undefined && policy !== "open") return fail("refused", NETWORK);
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		return ok("open");
	}

	/** delete: idempotent, a computer Orgo no longer has is done; it waits until Orgo no longer has it. No stop. */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		if (how === "stop") return fail("unsupported", "an Orgo computer has no stop that this provider declares: release it with delete");
		const read = await this.#get(ref.id);
		if (!read.ok) return read.error.code === "not_found" ? ok(undefined) : read;
		if (read.value.status === "deleted") return ok(undefined);
		if (!this.#ours(read.value, ref.name)) return fail("not_found", `no Orgo ${this.#profile.os} computer of this provider is ${ref.name} (${ref.id}), so it is left as it is`);
		return this.#delete(ref, signal);
	}

	/**
	 * Moves the deadline to now + ttlMs, never earlier and never past the most the labels file holds: Orgo's end first
	 * where there is one, in whole hours with an Idempotency-Key, then the name's, then the labels file. A computer's
	 * extends are taken in turn.
	 */
	extend(ref: ComputerRef, ttlMs: number, context: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const key = typeof ref?.id === "string" ? ref.id : "";
		const before = this.#extending.get(key) ?? Promise.resolve();
		const turn = before.then(() => this.#extend(ref, ttlMs, context));
		const settled = turn.then(
			() => undefined,
			() => undefined,
		);
		this.#extending.set(key, settled);
		void settled.then(() => {
			if (this.#extending.get(key) === settled) this.#extending.delete(key);
		});
		return turn;
	}

	async #extend(ref: ComputerRef, ttlMs: number, { signal }: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return fail("invalid", "extend takes ttlMs, a whole number of milliseconds above 0");
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		if (found.value.status !== "running") return fail("refused", `${ref.name} is ${found.value.status}, not running`);
		const file = await this.#readLabels(ref, signal);
		if (!file.ok) return file;
		const most = Date.parse(file.value.maxDeadline);
		const current = Date.parse(file.value.deadline);
		const target = Date.now() + ttlMs;
		if (Number.isNaN(most) || target > most) return fail("limit", `${new Date(target).toISOString()} is past ${file.value.maxDeadline}, the most this computer may live`);
		if (target < current) return fail("refused", `${new Date(target).toISOString()} is earlier than ${ref.name}'s deadline ${file.value.deadline}: an extend never moves it earlier; nothing moved`);
		if (target === current) return ok({ deadline: new Date(current) });
		const end = typeof found.value.ends_at === "string" ? Date.parse(found.value.ends_at) : Number.NaN;
		if (this.#profile.ends && !Number.isNaN(end) && end < target) {
			const hours = Math.ceil((target - end) / HOUR);
			const moved = await this.#rest.request("POST", `/computers/${encodeURIComponent(ref.id)}/extend`, { body: { hours }, headers: { "idempotency-key": randomUUID() }, timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
			if (!moved.ok) return fail(moved.error.code, `Orgo's end did not move, so nothing did: ${moved.error.message}`);
		}
		const took = new Date(Math.ceil(target / 1000) * 1000);
		const parts = nameParts(found.value.name) as { stable: string; deadline?: Date };
		const name = parts.deadline !== undefined && parts.deadline.getTime() >= took.getTime() ? found.value.name : withDeadline(parts.stable, took);
		if (name !== found.value.name) {
			const renamed = await this.#rest.request("PATCH", `/computers/${encodeURIComponent(ref.id)}`, { body: { name }, timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
			if (!renamed.ok) return fail(renamed.error.code, `the deadline in ${found.value.name} did not move: ${renamed.error.message}`);
		}
		const written = await this.#writeLabels(ref, { ...file.value, name, deadline: took.toISOString() }, signal);
		if (!written.ok) return fail(written.error.code, `the janitor's deadline moved to ${took.toISOString()}, and the labels file did not: ${written.error.message}`);
		return ok({ deadline: took });
	}
}

/** Orgo's bash call (PowerShell on Windows), bounded, read as Ran whichever shape it answers. */
async function bashCall(rest: OrgoRest, id: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<Ran>> {
	const timeout = Math.min(BASH_MAX_S, Math.max(1, Math.ceil(timeoutMs / 1000)));
	const ran = await rest.request<{ exit_code?: unknown; output?: unknown; stdout?: unknown; stderr?: unknown; error?: unknown }>("POST", `/computers/${encodeURIComponent(id)}/bash`, {
		body: { command, timeout },
		timeoutMs: timeout * 1000 + BASH_PROXY_MS,
		...(signal ? { signal } : {}),
	});
	if (!ran.ok) return ran;
	const { exit_code: exitCode, output, stdout, stderr, error } = ran.value ?? {};
	if (typeof exitCode !== "number") return fail("orgo", `Orgo's bash call answered no exit code (${JSON.stringify(ran.value)?.slice(0, 200)})`);
	const split = typeof stdout === "string" || typeof stderr === "string";
	// Windows says a timeout in words (exit 124, error "timeout"); Linux, and by the same agent macOS, with exit -1.
	const timedOut = error === "timeout" || exitCode === -1;
	return ok({
		exitCode: timedOut ? null : exitCode,
		stdout: split ? (typeof stdout === "string" ? stdout : "") : typeof output === "string" ? output : "",
		stderr: split && typeof stderr === "string" ? stderr : "",
		timedOut,
	});
}

type Call = Result<unknown>;
const refuse = (code: ComputerErrorCode, message: string): Call => fail(code, message);
const DAEMON_KINDS: ReadonlySet<string> = new Set(["not_found", "invalid", "timeout", "aborted", "denied", "limit", "unsupported", "exists", "not_dir", "is_dir"]);

/** The key names of Orgo's key call, from the protocol's (KEYS): Linux's X keysyms, which Windows reads as written but for pageup and pagedown. */
function orgoKey(key: Key, os: OrgoDesktopOs): string | undefined {
	const named: Record<string, string> = {
		enter: "Return",
		tab: "Tab",
		space: "space",
		backspace: "BackSpace",
		delete: "Delete",
		escape: "Escape",
		insert: "Insert",
		up: "Up",
		down: "Down",
		left: "Left",
		right: "Right",
		home: "Home",
		end: "End",
		pageup: os === "windows" ? "pageup" : "Page_Up",
		pagedown: os === "windows" ? "pagedown" : "Page_Down",
		shift: "shift",
		ctrl: "ctrl",
		alt: "alt",
		super: "super",
		capslock: os === "windows" ? "capslock" : "Caps_Lock",
	};
	if (Object.hasOwn(named, key)) return named[key];
	if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase();
	// "+" joins a combination in Orgo's key call, so it cannot be one of its keys.
	if (key.length === 1 && key !== "+") return key;
	return undefined;
}

/** One planned call to Orgo for one action: a path and a body, or a pause. */
type Step = { path: string; body: Record<string, unknown> } | { waitMs: number };

/**
 * The in-process client of one Orgo Windows or macOS desktop: each protocol method is one or more calls to Orgo's API.
 * Input batches run one at a time; a cancel stops a batch at the action it is on.
 */
export class OrgoDesktopClient implements ComputerClient {
	#closed = false;
	#hello: HelloResult | undefined;
	/** The screen's size, the input space. */
	#size: [number, number] = [0, 0];
	/** Where the pointer is, as far as the provider moved it; undefined until it has. */
	#pointer: [number, number] | undefined;
	#held: { id: string; bytes: Buffer } | undefined;
	#watchHeld: { id: string; bytes: Buffer } | undefined;
	#watch: { seq: number; digest: string; read: number; frame?: { bytes: Buffer; frameWidth: number; frameHeight: number; width: number; height: number; cursor?: [number, number] } } = {
		seq: 0,
		digest: "",
		read: Number.NEGATIVE_INFINITY,
	};
	/** A press down asked for and not yet released: Orgo has no separate press, so up makes it one click or drag. */
	#pressed: { button: Button; at: [number, number] } | undefined;
	#watching: Promise<unknown> = Promise.resolve();
	#inputs: Promise<unknown> = Promise.resolve();
	readonly #closing = new AbortController();

	constructor(
		readonly rest: OrgoRest,
		readonly computer: string,
		readonly profile: Profile,
		readonly workspaceId: string,
		readonly requestMs: number,
	) {}

	/** The screen's size from a first screenshot, then the hello this client answers. */
	async open(version: string, signal?: AbortSignal): Promise<Result<HelloResult>> {
		const shot = await this.#screenshot(1, signal);
		if (!shot.ok) return shot;
		this.#size = [shot.value.width, shot.value.height];
		this.#hello = { version, os: this.profile.os, kind: "desktop", arch: this.profile.arch, groups: [...this.profile.groups] };
		return ok(this.#hello);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#held = undefined;
		this.#watchHeld = undefined;
		this.#closing.abort();
	}

	#either(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#closing.signal]) : this.#closing.signal;
	}

	async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options: { signal?: AbortSignal } = {}): Promise<Result<DaemonMethods[M]["result"]>> {
		if (this.#closed) return fail("gone", "the connection to the computer is closed");
		if (options.signal?.aborted) return fail("aborted", `${method} was aborted`);
		return (await this.#answer(method as string, (params ?? {}) as Record<string, unknown>, this.#either(options.signal))) as Result<DaemonMethods[M]["result"]>;
	}

	async #answer(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
		switch (method) {
			case "hello":
				return ok(this.#hello);
			case "ping":
				return ok({});
			case "screen.shot":
				return this.#shot(params.region, signal);
			case "screen.read":
				return this.#read(params.id, params.offset);
			case "screen.watch": {
				const turn = this.#watching.then(() => this.#screenWatch(params, signal));
				this.#watching = turn.catch(() => undefined);
				return turn;
			}
			case "input.actions":
				return this.#inTurn(params.actions, signal);
			case "exec.run":
				return this.#exec(params, signal);
		}
		const group = method.split(".")[0] as string;
		if (group === "files" && this.profile.groups.includes("files")) return this.#files(method.slice("files.".length), params, signal);
		if (["files", "tar"].includes(group)) return refuse("unsupported", `${method}: an Orgo ${this.profile.os} computer offers ${this.profile.groups.includes("files") ? "files.read, write, stat, list, mkdir, move and remove, and no tar" : "no files methods: use exec"}`);
		if (group === "process") return refuse("unsupported", `${method}: Orgo runs a command and waits for it, so an Orgo ${this.profile.os} computer offers no processes`);
		if (method === "deadline.extend") return refuse("unsupported", "deadline.extend: no computerd runs in an Orgo Windows or macOS computer; extend it through the provider");
		return refuse("unsupported", `${method} is not a method an Orgo ${this.profile.os} computer answers`);
	}

	// --- screen --------------------------------------------------------------------------------------------------

	/** One screenshot, PNG, at scale (0 to 1]: its bytes and its size. */
	async #screenshot(scale: number, signal?: AbortSignal): Promise<Result<{ bytes: Buffer; width: number; height: number }>> {
		const query = `response_format=base64&format=png${scale < 1 ? `&scale=${scale.toFixed(4)}` : ""}`;
		const shot = await this.rest.request<{ image?: unknown; width?: unknown; height?: unknown }>("GET", `/computers/${encodeURIComponent(this.computer)}/screenshot?${query}`, {
			timeoutMs: this.requestMs,
			...(signal ? { signal } : {}),
		});
		if (!shot.ok) return shot;
		const { image, width, height } = shot.value ?? {};
		if (typeof image !== "string" || image === "") return fail("orgo", "Orgo's screenshot answered no image");
		const bytes = Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64");
		if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && (width as number) > 0 && (height as number) > 0) return ok({ bytes, width: width as number, height: height as number });
		try {
			const png = readPng(bytes);
			return ok({ bytes, width: png.width, height: png.height });
		} catch (error) {
			return fail("orgo", `Orgo's screenshot is not a PNG this client reads: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #shot(region: unknown, signal: AbortSignal): Promise<Call> {
		const shot = await this.#screenshot(1, signal);
		if (!shot.ok) return shot;
		const { width, height } = shot.value;
		this.#size = [width, height];
		let bytes = shot.value.bytes;
		let rect: Rect = [0, 0, width, height];
		if (region !== undefined) {
			const r = region as number[];
			if (!(Array.isArray(r) && r.length === 4 && r.every((v) => Number.isSafeInteger(v)) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= width && r[1] + r[3] <= height)) {
				return refuse("invalid", `region ${show(region)} is not [x, y, w, h] inside the ${width}x${height} screen`);
			}
			rect = r as Rect;
			const png = readPng(bytes);
			const rgba = Buffer.alloc(width * height * 4);
			for (let y = rect[1]; y < rect[1] + rect[3]; y++) {
				for (let x = rect[0]; x < rect[0] + rect[2]; x++) {
					const [red, green, blue] = png.rgb(x, y);
					rgba.set([red, green, blue, 255], (y * width + x) * 4);
				}
			}
			bytes = encodePng(rgba, width, rect);
		}
		const id = randomBytes(6).toString("hex");
		this.#held = { id, bytes };
		const data = bytes.subarray(0, MAX_CHUNK_BYTES);
		return ok({ id, size: bytes.length, data: data.toString("base64"), eof: data.length === bytes.length, width: rect[2], height: rect[3], scale: 1, ...(this.#pointer ? { cursor: [...this.#pointer] } : {}) });
	}

	/**
	 * screen.watch: the live view's frames, PNG, read about once a second at most (WATCH_POLL_MS), scaled by Orgo to
	 * maxWidth; width and height stay the screen's, the input space. An older ack gets the newest frame at once, one at
	 * the newest waits for a change until waitMs passes.
	 */
	async #screenWatch(params: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
		const { after, waitMs = 2_000, maxWidth = 1_280, quality = 60 } = params;
		const whole = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
		if (!whole(after, 0, Number.MAX_SAFE_INTEGER)) return refuse("invalid", "screen.watch takes after: the seq of the last frame the caller has, 0 for none");
		if (!whole(waitMs, 0, 10_000)) return refuse("invalid", `waitMs ${show(waitMs)} is outside 0 to 10000`);
		if (!whole(maxWidth, 1, 16_384)) return refuse("invalid", `maxWidth ${show(maxWidth)} is outside 1 to 16384`);
		if (!whole(quality, 1, 100)) return refuse("invalid", `quality ${show(quality)} is outside 1 to 100`);
		const watch = this.#watch;
		if ((after as number) > watch.seq) return refuse("invalid", `after ${after} is past the newest frame, ${watch.seq}`);
		if ((after as number) < watch.seq && watch.frame) return ok(this.#frameAnswer());
		const aborted = () => refuse("aborted", "screen.watch was aborted");
		const deadline = Date.now() + (waitMs as number);
		for (;;) {
			const wait = watch.read + WATCH_POLL_MS - Date.now();
			if (wait > 0) await pause(wait, signal);
			if (signal.aborted || this.#closed) return aborted();
			watch.read = Date.now();
			const [width, height] = this.#size;
			const scale = width > (maxWidth as number) ? (maxWidth as number) / width : 1;
			const shot = await this.#screenshot(scale, signal);
			if (signal.aborted || this.#closed) return aborted();
			if (!shot.ok) return shot;
			// The cursor is part of what a frame shows: where this client moved the pointer is in the digest, so a move is a
			// new frame even when Orgo's screenshot leaves the cursor out.
			const cursor = this.#pointer === undefined ? undefined : ([...this.#pointer] as [number, number]);
			const digest = createHash("sha256").update(shot.value.bytes).update(`|${cursor?.join(",") ?? ""}`).digest("hex");
			if (watch.seq === 0 || digest !== watch.digest) {
				watch.seq += 1;
				watch.digest = digest;
				const full: [number, number] = scale < 1 ? [width, height] : [shot.value.width, shot.value.height];
				if (scale >= 1) this.#size = full;
				watch.frame = { bytes: shot.value.bytes, frameWidth: shot.value.width, frameHeight: shot.value.height, width: full[0], height: full[1], ...(cursor ? { cursor } : {}) };
				return ok(this.#frameAnswer());
			}
			const left = deadline - Date.now();
			if (left < WATCH_POLL_MS) {
				if (left > 0) await pause(left, signal);
				if (signal.aborted || this.#closed) return aborted();
				return ok({ seq: watch.seq, changed: false, width: this.#size[0], height: this.#size[1] });
			}
		}
	}

	#frameAnswer(): ScreenWatchResult {
		const { seq, frame } = this.#watch;
		const { bytes, frameWidth, frameHeight, width, height, cursor } = frame as NonNullable<typeof frame>;
		const data = bytes.subarray(0, MAX_CHUNK_BYTES);
		const eof = data.length === bytes.length;
		const id = randomBytes(6).toString("hex");
		if (!eof) this.#watchHeld = { id, bytes };
		return { seq, changed: true, ...(eof ? {} : { id }), size: bytes.length, data: data.toString("base64"), eof, format: "png", frameWidth, frameHeight, width, height, ...(cursor ? { cursor } : {}) };
	}

	#read(id: unknown, offset: unknown): Call {
		const frame = this.#watchHeld !== undefined && this.#watchHeld.id === id;
		const held = frame ? this.#watchHeld : this.#held;
		if (held === undefined || held.id !== id) return refuse("not_found", `no shot ${show(id)} is held: take one with screen.shot`);
		if (!(Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= held.bytes.length)) return refuse("invalid", `offset ${show(offset)} is not inside the shot's ${held.bytes.length} bytes`);
		const data = held.bytes.subarray(offset as number, (offset as number) + MAX_CHUNK_BYTES);
		const eof = (offset as number) + data.length >= held.bytes.length;
		if (eof && frame) this.#watchHeld = undefined;
		else if (eof) this.#held = undefined;
		return ok({ data: data.toString("base64"), eof });
	}

	// --- input ---------------------------------------------------------------------------------------------------

	/**
	 * The Orgo calls of one action with the pointer where it is, or why this desktop cannot do it: "unsupported" whatever
	 * the pointer, so a batch is refused whole before any of it runs. down and up are the batch loop's (#actions).
	 */
	#steps(action: InputAction, pointer: [number, number] | undefined): Step[] | { kind: DaemonErrorKind; message: string } {
		const windows = this.profile.windowsInput;
		const os = this.profile.os;
		const at = (point: [number, number]) => ({ x: Math.round(point[0]), y: Math.round(point[1]) });
		const modifiers = (keys: Key[] | undefined): string[] | { kind: DaemonErrorKind; message: string } => {
			if (keys === undefined || keys.length === 0) return [];
			if (windows) return { kind: "unsupported", message: "Orgo's Windows click takes no keys held down" };
			const names: Record<string, string> = { ctrl: "ctrl", alt: "alt", shift: "shift", super: "super" };
			const bad = keys.find((key) => !Object.hasOwn(names, key));
			return bad === undefined ? keys.map((key) => names[key] as string) : { kind: "unsupported", message: `${show(bad)} is not a key Orgo's click holds down: ctrl, alt, shift or super` };
		};
		switch (action.type) {
			case "move":
				return [{ path: "mouse-move", body: at(action.at) }];
			case "click": {
				const point = action.at ?? pointer;
				if (point === undefined) return { kind: "invalid", message: "a click without at needs the pointer's place, and this connection has not moved it yet" };
				const button: Button = action.button ?? "left";
				const count = action.count ?? 1;
				const held = modifiers(action.keys);
				if (!Array.isArray(held)) return held;
				if (windows) {
					if (count === 3) return { kind: "unsupported", message: "Orgo's Windows click has no triple click" };
					return [{ path: "click", body: { ...at(point), button, ...(count === 2 ? { double: true } : {}) } }];
				}
				if (count === 2 && button !== "left") return { kind: "unsupported", message: "Orgo's double click is always the left button's" };
				if (held.length > 0 && count > 1) return { kind: "unsupported", message: "Orgo's click takes keys held down only on a single click" };
				return [{ path: "click", body: { ...at(point), button, ...(count === 2 ? { double: true } : count === 3 ? { repeat: 3 } : {}), ...(held.length > 0 ? { modifiers: held } : {}) } }];
			}
			case "drag": {
				if (action.path.length !== 2) return { kind: "unsupported", message: "Orgo's drag goes straight from one point to another: a path of 2 points" };
				if ((action.keys ?? []).length > 0) return { kind: "unsupported", message: "Orgo's drag takes no keys held down" };
				const button: Button = action.button ?? "left";
				if (!windows && button !== "left") return { kind: "unsupported", message: `Orgo's drag on ${os} is always the left button's` };
				const [from, to] = action.path as [[number, number], [number, number]];
				return [{ path: "drag", body: { start_x: Math.round(from[0]), start_y: Math.round(from[1]), end_x: Math.round(to[0]), end_y: Math.round(to[1]), ...(windows ? { button } : {}) } }];
			}
			case "scroll": {
				if ((action.dx ?? 0) !== 0) return { kind: "unsupported", message: "Orgo scrolls up and down only, not sideways" };
				if ((action.keys ?? []).length > 0) return { kind: "unsupported", message: "Orgo's scroll takes no keys held down" };
				const dy = Math.round(action.dy ?? 0);
				if (dy === 0) return [];
				const point = action.at ?? pointer;
				const direction = dy > 0 ? "down" : "up";
				const steps: Step[] = [];
				if (windows) {
					// Windows scrolls at the pointer, and takes no coordinates: the pointer goes there first.
					if (action.at !== undefined) steps.push({ path: "mouse-move", body: at(action.at) });
					for (let left = Math.abs(dy); left > 0; left -= SCROLL_MAX) steps.push({ path: "scroll", body: { direction, amount: Math.min(SCROLL_MAX, left) } });
					return steps;
				}
				if (point === undefined) return { kind: "invalid", message: "a scroll without at needs the pointer's place, and this connection has not moved it yet" };
				for (let left = Math.abs(dy); left > 0; left -= SCROLL_MAX) steps.push({ path: "scroll", body: { ...at(point), direction, amount: Math.min(SCROLL_MAX, left) } });
				return steps;
			}
			case "key": {
				const names = action.keys.map((key) => orgoKey(key, os));
				const bad = names.findIndex((name) => name === undefined);
				if (bad !== -1) return { kind: "unsupported", message: `${show(action.keys[bad])} is not a key Orgo's key call can press: "+" joins a combination there` };
				return Array.from({ length: action.repeat ?? 1 }, () => ({ path: "key", body: { key: names.join("+") } }));
			}
			case "type": {
				const steps: Step[] = [];
				let chunk = "";
				for (const character of action.text) {
					if (Buffer.byteLength(chunk + character, "utf8") > this.profile.typeBytes) {
						steps.push({ path: "type", body: { text: chunk } });
						chunk = "";
					}
					chunk += character;
				}
				if (chunk !== "") steps.push({ path: "type", body: { text: chunk } });
				return steps;
			}
			case "wait":
				return [{ waitMs: action.ms }];
			case "down":
				if (!windows && (action.button ?? "left") !== "left") return { kind: "unsupported", message: `Orgo's drag on ${os}, which a down and its up become, is always the left button's` };
				return [];
			case "up":
				return [];
			case "hold":
				return { kind: "unsupported", message: "hold: Orgo's key call cannot keep a key down" };
			default:
				return { kind: "unsupported", message: `${(action as { type: string }).type} is not an action an Orgo desktop takes` };
		}
	}

	/** The points an action names, to check against the screen before any runs. */
	static #pointsOf(action: InputAction): Array<[number, number]> {
		if ((action.type === "move" || action.type === "click" || action.type === "scroll") && action.at !== undefined) return [action.at];
		if (action.type === "drag") return action.path;
		return [];
	}

	/** A batch in its turn: batches run one at a time; a cancel while it waits answers at once with none of it run. */
	#inTurn(actions: unknown, signal: AbortSignal): Promise<Call> {
		const waitedOut = (): Call => ok({ done: 0, failed: { index: 0, kind: "aborted", message: "action 0: the batch was aborted while it waited for the batch before it; none of it ran" } } satisfies InputActionsResult);
		let started = false;
		const turn = this.#inputs.then((): Promise<Call> | Call => {
			started = true;
			return signal.aborted ? waitedOut() : this.#actions(actions, signal);
		});
		this.#inputs = turn.catch(() => undefined);
		return new Promise<Call>((resolve, reject) => {
			const stop = () => {
				if (!started) resolve(waitedOut());
			};
			signal.addEventListener("abort", stop, { once: true });
			if (signal.aborted) stop();
			turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	}

	/** One call to Orgo's input API, bounded and cancelled with the batch. */
	#send(step: { path: string; body: Record<string, unknown> }, signal: AbortSignal): Promise<Result<unknown>> {
		return this.rest.request("POST", `/computers/${encodeURIComponent(this.computer)}/${step.path}`, { body: step.body, timeoutMs: this.requestMs, signal });
	}

	/**
	 * The press down asked for, released where the pointer is now: one click there when it has not moved, else one drag
	 * from where it went down. Orgo has no separate press and release, so this is when the button goes down and up.
	 */
	async #release(signal: AbortSignal): Promise<Result<unknown>> {
		const pressed = this.#pressed;
		if (pressed === undefined) return ok(undefined);
		this.#pressed = undefined;
		const to = this.#pointer ?? pressed.at;
		const windows = this.profile.windowsInput;
		const [x, y] = [Math.round(to[0]), Math.round(to[1])];
		if (to[0] === pressed.at[0] && to[1] === pressed.at[1]) return this.#send({ path: "click", body: { x, y, button: pressed.button } }, signal);
		return this.#send({ path: "drag", body: { start_x: Math.round(pressed.at[0]), start_y: Math.round(pressed.at[1]), end_x: x, end_y: y, ...(windows ? { button: pressed.button } : {}) } }, signal);
	}

	/**
	 * The batch: checked whole first (its shape, keys and groups, then what Orgo's API cannot do), so a refused batch runs
	 * nothing; then each action in order, its points held to the screen as it comes, so a batch that fails at action n
	 * has done n. A press down is held in the client until its up (#release), across batches as the protocol says, and a
	 * batch that fails releases it where the pointer is.
	 */
	async #actions(actions: unknown, signal: AbortSignal): Promise<Call> {
		const refused = checkActions(actions, this.profile.groups, { pixelScroll: false });
		if (refused !== undefined) return ok({ done: 0, failed: refused } satisfies InputActionsResult);
		const list = actions as InputAction[];
		for (const [index, action] of list.entries()) {
			const steps = this.#steps(action, [0, 0]);
			if (!Array.isArray(steps) && steps.kind === "unsupported") return ok({ done: 0, failed: { index, kind: steps.kind, message: `action ${index}: ${steps.message}` } } satisfies InputActionsResult);
		}
		const failed = async (index: number, kind: DaemonErrorKind, message: string): Promise<Call> => {
			if (this.#pressed !== undefined && !signal.aborted) await this.#release(signal);
			return ok({ done: index, failed: { index, kind, message: `action ${index}: ${message}` } } satisfies InputActionsResult);
		};
		const cancelled = (index: number): Call => ok({ done: index, failed: { index, kind: "aborted", message: `action ${index}: the batch was aborted; actions ${index} on did not run` } } satisfies InputActionsResult);
		const sendOrFail = async (index: number, step: { path: string; body: Record<string, unknown> }): Promise<Call | undefined> => {
			const sent = await this.#send(step, signal);
			if (sent.ok) return undefined;
			if (signal.aborted) return cancelled(index);
			return failed(index, (DAEMON_KINDS.has(sent.error.code) ? sent.error.code : "invalid") as DaemonErrorKind, sent.error.message);
		};
		for (const [index, action] of list.entries()) {
			if (signal.aborted) return cancelled(index);
			const off = OrgoDesktopClient.#pointsOf(action).find((point) => point[0] < 0 || point[1] < 0 || point[0] >= this.#size[0] || point[1] >= this.#size[1]);
			if (off !== undefined) return failed(index, "invalid", `${show(off)} is off the ${this.#size[0]}x${this.#size[1]} screen`);
			if (action.type === "down" || action.type === "up" || (action.type === "move" && this.#pressed !== undefined)) {
				if (action.type === "move") this.#pointer = [...action.at];
				else if (action.type === "up") {
					const released = await this.#release(signal);
					if (!released.ok) return signal.aborted ? cancelled(index) : failed(index, (DAEMON_KINDS.has(released.error.code) ? released.error.code : "invalid") as DaemonErrorKind, released.error.message);
				} else {
					if (this.#pointer === undefined) return failed(index, "invalid", "a down needs the pointer's place, and this connection has not moved it yet");
					if (this.#pressed !== undefined) {
						const released = await this.#release(signal);
						if (!released.ok) return failed(index, "invalid", released.error.message);
					}
					this.#pressed = { button: action.button ?? "left", at: [...this.#pointer] };
				}
				continue;
			}
			// Anything else presses or moves on its own: a press held down is released first, where the pointer is.
			if (this.#pressed !== undefined && action.type !== "wait" && action.type !== "key" && action.type !== "type") {
				const released = await this.#release(signal);
				if (!released.ok) return signal.aborted ? cancelled(index) : failed(index, "invalid", released.error.message);
			}
			const steps = this.#steps(action, this.#pointer);
			if (!Array.isArray(steps)) return failed(index, steps.kind, steps.message);
			for (const step of steps) {
				if (signal.aborted) return cancelled(index);
				if ("waitMs" in step) {
					await pause(step.waitMs, signal);
					if (signal.aborted) return cancelled(index);
					continue;
				}
				const stopped = await sendOrFail(index, step);
				if (stopped !== undefined) return stopped;
			}
			if (action.type === "move" || ((action.type === "click" || action.type === "scroll") && action.at !== undefined)) this.#pointer = [...(action.at as [number, number])];
			else if (action.type === "drag") this.#pointer = [...(action.path.at(-1) as [number, number])];
		}
		return ok({ done: list.length } satisfies InputActionsResult);
	}

	// --- exec ----------------------------------------------------------------------------------------------------

	/**
	 * exec.run through Orgo's bash call: PowerShell on Windows, the shell on macOS, argv quoted word by word (never a
	 * shell string). Orgo bounds a command in whole seconds, 1 to 300; a longer timeoutMs is refused as limit. No user
	 * switch: denied. maxOutput keeps that many bytes of each stream.
	 */
	async #exec(params: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
		const { argv, cwd, env, user, timeoutMs, maxOutput = MAX_OUTPUT_BYTES } = params;
		if (!Array.isArray(argv) || argv.length === 0 || !argv.every((word) => typeof word === "string" && !word.includes("\0")) || argv[0] === "") return refuse("invalid", "argv is a program and its arguments: a list of strings, the first not empty, none holding a NUL");
		if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) return refuse("invalid", "timeoutMs is a whole number of milliseconds above 0");
		if ((timeoutMs as number) > BASH_MAX_S * 1000) return refuse("limit", `timeoutMs ${timeoutMs} is past Orgo's longest command, ${BASH_MAX_S} s`);
		if (!Number.isSafeInteger(maxOutput) || (maxOutput as number) < 0 || (maxOutput as number) > MAX_OUTPUT_BYTES) return refuse("invalid", `maxOutput is 0 to ${MAX_OUTPUT_BYTES} bytes`);
		if (user !== undefined) return refuse("denied", `an Orgo ${this.profile.os} computer runs every program as Orgo's own user; it cannot switch to ${show(user)}`);
		if (cwd !== undefined && (typeof cwd !== "string" || cwd === "" || cwd.includes("\0"))) return refuse("invalid", "cwd is a folder's path");
		if (env !== undefined) {
			if (typeof env !== "object" || env === null || Array.isArray(env)) return refuse("invalid", "env maps names to strings");
			const bad = Object.entries(env).find(([name, value]) => !ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0"));
			if (bad) return refuse("invalid", `env ${show(bad[0])}: a name of letters, digits and _, not starting with a digit, and a string with no NUL`);
		}
		const command = commandOf(this.profile.os, argv as string[], { ...(cwd === undefined ? {} : { cwd: cwd as string }), ...(env === undefined ? {} : { env: env as Record<string, string> }) });
		const ran = await bashCall(this.rest, this.computer, command, timeoutMs as number, signal);
		if (!ran.ok) return signal.aborted ? refuse("aborted", "exec.run was aborted; the command may still run in the computer until its timeout") : ran;
		const keep = (text: string) => {
			const bytes = Buffer.from(text, "utf8");
			return { data: bytes.subarray(0, maxOutput as number).toString("base64"), cut: bytes.length > (maxOutput as number) };
		};
		const out = keep(ran.value.stdout);
		const err = keep(ran.value.stderr);
		return ok({ exitCode: ran.value.exitCode, stdout: out.data, stderr: err.data, timedOut: ran.value.timedOut, truncated: out.cut || err.cut });
	}

	// --- files (Windows) -----------------------------------------------------------------------------------------

	/** One files method through FILES_SCRIPT, its request base64 in the script; a large write is uploaded first. */
	async #files(op: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
		const path = (value: unknown): string | undefined => (typeof value === "string" && WINDOWS_ABSOLUTE.test(value) && !value.includes("\0") ? value : undefined);
		const absolute = (field: string) => refuse("invalid", `${field} is an absolute Windows path, such as C:\\Users\\Public\\notes.txt`);
		let request: Record<string, unknown>;
		switch (op) {
			case "read": {
				if (path(params.path) === undefined) return absolute("path");
				const { offset = 0, length = MAX_CHUNK_BYTES } = params;
				if (!Number.isSafeInteger(offset) || (offset as number) < 0) return refuse("invalid", "offset is a whole number of bytes, 0 or more");
				if (!Number.isSafeInteger(length) || (length as number) < 0) return refuse("invalid", "length is a whole number of bytes, 0 or more");
				if ((length as number) > MAX_CHUNK_BYTES) return refuse("limit", `length is at most ${MAX_CHUNK_BYTES} bytes`);
				request = { op, path: params.path, offset, length: Math.min(length as number, READ_CHUNK_BYTES) };
				break;
			}
			case "write": {
				if (path(params.path) === undefined) return absolute("path");
				if (typeof params.data !== "string") return refuse("invalid", "data is base64");
				if (params.offset !== undefined && params.append) return refuse("invalid", "offset and append are one or the other");
				if (params.offset !== undefined && !(Number.isSafeInteger(params.offset) && (params.offset as number) >= 0)) return refuse("invalid", "offset is a whole number of bytes, 0 or more");
				request = { op, path: params.path, ...(params.offset === undefined ? {} : { offset: params.offset }), append: params.append === true, parents: params.parents === true };
				if (params.data.length <= INLINE_WRITE_CHARS) request.data = params.data;
				else {
					const staged = await this.#stage(Buffer.from(params.data, "base64"), signal);
					if (!staged.ok) return staged;
					request.staged = staged.value;
				}
				break;
			}
			case "stat":
				if (path(params.path) === undefined) return absolute("path");
				request = { op, path: params.path };
				break;
			case "list": {
				if (path(params.path) === undefined) return absolute("path");
				const { depth = 1, offset = 0 } = params;
				if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > 16) return refuse("invalid", "depth is 1 to 16");
				if (!Number.isSafeInteger(offset) || (offset as number) < 0) return refuse("invalid", "offset is a whole number, 0 or more");
				request = { op, path: params.path, depth, offset, max: MAX_LIST_ENTRIES };
				break;
			}
			case "mkdir":
			case "remove":
				if (path(params.path) === undefined) return absolute("path");
				request = { op, path: params.path, parents: params.parents === true, recursive: params.recursive === true };
				break;
			case "move":
				if (path(params.from) === undefined) return absolute("from");
				if (path(params.to) === undefined) return absolute("to");
				request = { op, from: params.from, to: params.to, overwrite: params.overwrite === true };
				break;
			default:
				return refuse("unsupported", `files.${op} is not a files method`);
		}
		const script = FILES_SCRIPT.replace("@@REQUEST@@", Buffer.from(JSON.stringify(request), "utf8").toString("base64"));
		const ran = await bashCall(this.rest, this.computer, script, 120_000, signal);
		if (!ran.ok) return signal.aborted ? refuse("aborted", `files.${op} was aborted`) : ran;
		let answer: Record<string, unknown>;
		try {
			answer = JSON.parse(ran.value.stdout.trim() || "null") as Record<string, unknown>;
		} catch {
			answer = {};
		}
		if (typeof answer?.error === "string") {
			const kind = DAEMON_KINDS.has(answer.error) ? (answer.error as ComputerErrorCode) : "invalid";
			return refuse(kind, `files.${op}: ${String(answer.message ?? "refused").trim().slice(0, 300)}`);
		}
		if (ran.value.exitCode !== 0 || answer === null || typeof answer !== "object") return refuse("invalid", `files.${op} failed in the computer (exit ${ran.value.exitCode}): ${(ran.value.stderr || ran.value.stdout).trim().slice(0, 300)}`);
		switch (op) {
			case "read": {
				const data = Buffer.from(String(answer.data ?? ""), "base64");
				const size = Number(answer.size);
				return ok({ data: data.toString("base64"), eof: (request.offset as number) + data.length >= size, size });
			}
			case "write":
				return ok({ size: Number(answer.size) });
			case "stat":
				return ok(answer);
			case "list":
				return ok({ entries: Array.isArray(answer.entries) ? answer.entries : answer.entries === undefined || answer.entries === null ? [] : [answer.entries], truncated: answer.truncated === true });
			default:
				return ok({});
		}
	}

	/** bytes put in the staging folder through Orgo's upload, under a fresh name: the path PowerShell then reads. */
	async #stage(bytes: Buffer, signal: AbortSignal): Promise<Result<string>> {
		const folder = this.profile.staging as string;
		const name = `agentrun-${randomBytes(8).toString("hex")}`;
		const form = new FormData();
		form.set("file", new Blob([new Uint8Array(bytes)]), name);
		form.set("workspaceId", this.workspaceId);
		form.set("desktopId", this.computer);
		form.set("destPath", folder);
		const sent = await this.rest.request("POST", "/files/upload", { form, timeoutMs: 120_000, signal });
		if (!sent.ok) return fail(sent.error.code, `the write's upload to ${folder} failed: ${sent.error.message}`);
		return ok(`${folder}\\${name}`);
	}
}
