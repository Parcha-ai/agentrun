// The environment probe: can a command that runs as the agent's user find the take's secrets? It answers with counts, never with a value.
//
// Why /proc: deleting a variable from `process.env` does not clear `/proc/<pid>/environ`. The kernel keeps showing a process's original environment block to any process of the same
// user, so a session that started with a key in its environment and then deleted it still lets a sibling command read it with `cat /proc/<pid>/environ`. The same goes for a key given
// as an argument (`/proc/<pid>/cmdline`). The probe therefore scans its own environment and every readable `/proc/*/environ` and `/proc/*/cmdline`.
//
// How it counts without holding what it looks for: the caller hands the scanner one SHA-256 and one length per value (`specOf`), never the value. The scanner hashes every window of that
// length in each blob it reads and counts the windows whose hash matches, so a value is found wherever it sits, whole or inside a longer string (`--key=<value>`, `PREFIX-<value>`), and
// the scanner's own command line and environment do not contain it.
//
// The scanner is Python 3 (a thread's sandbox image has it; a Node-less image is the case this is for). It is deliberately small and is this example's own: when pi-transport has its
// planted-marker conformance check (one marker placed where a box could leak it, one command that must not find it), this probe should call that and keep only what is specific to
// the take (the names, the VM's session process). Until then this is the copy.
import { createHash } from "node:crypto";

/** Names a command run as the agent must never see in any environment it can read. */
export const FORBIDDEN_NAMES = ["ANTHROPIC_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "ARCHIL_API_KEY"] as const;

export interface Secret {
  readonly name: string;
  readonly value: string;
}

/** What the scanner is given: a name, a length and a hash for each value. No value. */
export interface ProbeSpec {
  readonly values: readonly { readonly name: string; readonly length: number; readonly sha256: string }[];
  /** Scan only these processes (and the scanner's own environment). Absent: every process the scanner can read, which is what a real probe does; a test on a machine full of other people's environments narrows it. */
  readonly only?: readonly number[];
}

export function specOf(secrets: readonly Secret[], only?: readonly number[]): ProbeSpec {
  for (const secret of secrets) if (secret.value.length < 8) throw new Error(`${secret.name} is too short to look for by hash (a short value matches by chance): give the probe the real value`);
  return { values: secrets.map((s) => ({ name: s.name, length: Buffer.byteLength(s.value), sha256: createHash("sha256").update(s.value).digest("hex") })), ...(only === undefined ? {} : { only }) };
}

/** The scanner. Its one argument is the spec as JSON; it prints one JSON line. */
export const SCANNER = String.raw`
import hashlib, json, os, re, sys
spec = json.loads(sys.argv[1])
forbidden = set(spec["forbidden"])
only = set(spec["only"]) if spec.get("only") is not None else None
index = {v["sha256"]: v["name"] for v in spec["values"]}
lengths = sorted({v["length"] for v in spec["values"]})
counts = {v["name"]: {"ownEnv": 0, "procEnviron": 0, "procCmdline": 0} for v in spec["values"]}
LIMIT = 1 << 20
secretish = re.compile("KEY|TOKEN|SECRET", re.I)
seen = set()
def scan(blob, where):
    blob = blob[:LIMIT]
    for n in lengths:
        for i in range(len(blob) - n + 1):
            name = index.get(hashlib.sha256(blob[i:i + n]).hexdigest())
            if name:
                counts[name][where] += 1
def names_of(env):
    for entry in env.split(b"\0"):
        if b"=" in entry:
            seen.add(entry.split(b"=", 1)[0].decode("utf-8", "replace"))
scan(b"\0".join(k + b"=" + v for k, v in os.environb.items()), "ownEnv")
names_of(b"\0".join(k + b"=" + v for k, v in os.environb.items()))
readable = unreadable = 0
for pid in os.listdir("/proc"):
    if not pid.isdigit() or (only is not None and int(pid) not in only):
        continue
    try:
        with open("/proc/%s/environ" % pid, "rb") as f:
            env = f.read(LIMIT)
        readable += 1
        names_of(env)
        scan(env, "procEnviron")
    except OSError:
        unreadable += 1
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as f:
            scan(f.read(LIMIT), "procCmdline")
    except OSError:
        pass
print(json.dumps({
    "uid": os.getuid(),
    "procsReadable": readable,
    "procsUnreadable": unreadable,
    "forbiddenNames": sorted(n for n in seen if n in forbidden),
    "secretishNames": sorted(n for n in seen if secretish.search(n)),
    "counts": counts,
}))
`;

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const specJson = (spec: ProbeSpec) => JSON.stringify({ ...spec, forbidden: FORBIDDEN_NAMES });

/** The scanner as an argument list (for a runner that takes one). */
export function scannerArgv(spec: ProbeSpec, python = "python3"): string[] {
  return [python, "-I", "-c", SCANNER, specJson(spec)];
}

/** The scanner as one shell command (for a runner that takes a string, as a thread's `gpu_bash` does). */
export function scannerCommand(spec: ProbeSpec, python = "python3"): string {
  return scannerArgv(spec, python).map((word, i) => (i === 0 ? word : quote(word))).join(" ");
}

export interface ProbeReport {
  readonly uid: number;
  readonly procsReadable: number;
  readonly procsUnreadable: number;
  readonly forbiddenNames: readonly string[];
  readonly secretishNames: readonly string[];
  readonly counts: Readonly<Record<string, { readonly ownEnv: number; readonly procEnviron: number; readonly procCmdline: number }>>;
}

/** The scanner's report out of what it printed. */
export function parseReport(stdout: string): ProbeReport {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`the scanner printed no report: ${stdout.slice(-200)}`);
  return JSON.parse(line) as ProbeReport;
}

/** Green only if the scanner could read something, found no value anywhere, and saw no forbidden or key-like name. Every problem is listed, with names and counts and never a value. */
export function judge(report: ProbeReport, options: { readonly minReadable?: number } = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (report.procsReadable < (options.minReadable ?? 1)) problems.push(`the scanner read ${report.procsReadable} process environments: nothing was checked`);
  if (report.forbiddenNames.length) problems.push(`environments hold the names ${report.forbiddenNames.join(", ")}`);
  const others = report.secretishNames.filter((n) => !report.forbiddenNames.includes(n));
  if (others.length) problems.push(`environments hold key-like names: ${others.join(", ")}`);
  for (const [name, c] of Object.entries(report.counts)) {
    for (const [where, n] of Object.entries(c)) if (n > 0) problems.push(`the value of ${name} is in ${where} ${n} time(s)`);
  }
  return { ok: problems.length === 0, problems };
}
