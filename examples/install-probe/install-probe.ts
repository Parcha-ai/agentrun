// The install probe: `npm install <name>@<version>` with lifecycle scripts ON, in a throwaway Docker container, and what it
// reached. Install scripts never run on this machine: the program, its scripts and everything they start live in the box.
//
// The install runs detached inside the box, so it goes on when the process that started it is killed. `startInstall` returns
// the box's id as soon as the install is going; whoever holds the id asks again with `attachInstall`, from any process, and
// gets the result when the install has ended, `{ running: true }` while it has not, or `{ gone: true }` when the box no
// longer exists (it was killed, ended, or was already read). Only `{ gone: true }` calls for a fresh `startInstall`, which is
// safe to repeat: boxes share nothing. There is no retry in this file, and no dedupe: a second `startInstall` is a second box.
//
// What the outbound list is: the connections `strace` saw the install's processes make (`connect`). A host name comes first from
// the DNS answers the install itself received (the address in the answer, the name it was asked for). An address no answer
// named is matched by asking the resolver again for the queried names, in the same box once the install ended; that is a
// fallback (a CDN's addresses rotate) and a best effort, so a name is left out when nothing matches or the lookup fails. The
// trace the host reads is capped (`traceLimitBytes`), and `traceTruncated` says when connections past the cap are not in the
// list. It is what was seen, not a proof of what was not.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { finish, type Box, type BoxProvider } from '@parcha/pi-transport';
import { dockerBoxes } from '@parcha/pi-transport/box/docker';

const run = promisify(execFile);

/** The label on every connection list: what this is and is not. */
export const SEEN = 'connections seen by strace' as const;

export type Outbound = { host?: string; ip: string; port: number; at: number };
export type InstallResult = {
  exitCode: number;
  scriptLog: string;
  outbound: Outbound[];
  durationMs: number;
  seen: typeof SEEN;
  /** Present (true) when the trace passed `traceLimitBytes` and the connections after the cut are not in `outbound`. */
  traceTruncated?: true;
};
/** `{ running: true }`: the install has not ended; ask again. `{ gone: true }`: no box by that id: start a new install. */
export type InstallAttach = InstallResult | { running: true } | { gone: true };
export type InstallOptions = {
  /** The image the box starts from. It needs Node and npm; `strace` is installed in the box. Default `node:22-slim`. */
  image?: string;
  /** The install's own limit; it ends with exit code 124 past it. Default 10 minutes. */
  timeoutMs?: number;
  /** Labels on the box, so a stray one is findable: `docker ps --filter label=<key>=<value>`. */
  labels?: Record<string, string>;
  /** How much of the connection trace the host reads. Default 4 MiB; past it the list is cut at a whole line and `traceTruncated` is set. */
  traceLimitBytes?: number;
  /** The docker program. Default `docker`. */
  docker?: string;
};
export type AttachOptions = {
  /** How long one call waits for the install before it answers `{ running: true }`. Default 25 s. */
  waitMs?: number;
  docker?: string;
};

/** Docker is not there (or its daemon is not): the caller goes on without the install and says so. */
export class DockerUnavailable extends Error {
  readonly code = 'DOCKER_UNAVAILABLE' as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DockerUnavailable';
  }
}

/** A box call that failed for a reason that is not "the box is gone": the caller's own error to handle. */
export class InstallBoxError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InstallBoxError';
  }
}

const DEFAULT_IMAGE = 'node:22-slim';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WAIT_MS = 25_000;
const POLL_MS = 500;
const LOG_TAIL_BYTES = 20 * 1024;
const DEFAULT_TRACE_LIMIT_BYTES = 4 * 1024 * 1024;
const DIRECTORY = '/workspace/probe';
/** The box ends itself this long after the install's own limit, whatever happens to the machine that started it. */
const LIFETIME_SLACK_MS = 3 * 60_000;
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/** Runs inside the box, detached. Every fact goes into a file of `DIRECTORY`; `exit` is written last and means "done". */
const RUN_SCRIPT = `#!/bin/sh
cd ${DIRECTORY} || exit 1
spec=$1
limit=$2
trace_limit=$3
ms() { date +%s%3N; }
if ! command -v strace >/dev/null 2>&1; then
  apt-get update -qq > prepare.log 2>&1
  apt-get install -y -qq strace >> prepare.log 2>&1
fi
if ! command -v strace >/dev/null 2>&1; then
  echo "strace could not be installed in the box" > install.log
  echo 127 > exit.part
  mv exit.part exit
  exit 0
fi
mkdir -p project && cd project || exit 1
npm init -y > /dev/null 2>&1
ms > ../install.start
timeout "$limit" strace -f -qq -ttt -xx -s 512 -e trace=connect,send,sendto,sendmmsg,recvfrom,recvmsg,recvmmsg -o ../trace.log \\
  npm install "$spec" --no-audit --no-fund --foreground-scripts > ../install.log 2>&1
code=$?
ms > ../install.end
cd ..
# What the host reads: every connection and send, and only the receives that look like a DNS answer (a download would fill the
# trace with its own data otherwise). The host reads at most trace_limit bytes of it, cut at a whole line; net.truncated says so.
grep -E 'connect\\(|send(to|mmsg)?\\(|recv(from|msg|mmsg)\\(.*"(\\\\x[0-9a-f]{2}){2}\\\\x[89a-f][0-9a-f]\\\\x[0-9a-f]{2}\\\\x00\\\\x01\\\\x00' trace.log > net.all
if [ "$(wc -c < net.all)" -gt "$trace_limit" ]; then
  head -c "$trace_limit" net.all | sed '$d' > net.log
  echo 1 > net.truncated
else
  mv net.all net.log
fi
echo "$code" > exit.part
mv exit.part exit
`;

async function dockerReady(program: string): Promise<void> {
  try {
    await run(program, ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
  } catch (cause) {
    throw new DockerUnavailable(`docker is not available: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`, cause);
  }
}

function provider(docker: string | undefined): BoxProvider {
  return dockerBoxes(docker === undefined ? {} : { docker });
}

/** Run a command in the box and read it to its end. `undefined` when the box is gone. */
async function exec(box: Box, command: string[], timeoutMs = 20_000): Promise<{ exitCode: number; stdout: string } | undefined> {
  const started = await box.exec(command, { timeoutMs }, BACKGROUND_CONTEXT);
  if (!started.ok) {
    if (started.error.code === 'gone' || started.error.code === 'not_found') return undefined;
    throw new InstallBoxError(`a command in the box did not start: ${started.error.message}`, started.error);
  }
  const finished = await finish(started.value);
  if (!finished.ok) {
    if (finished.error.code === 'gone') return undefined;
    throw new InstallBoxError(`a command in the box failed: ${finished.error.message}`, finished.error);
  }
  return { exitCode: finished.value.exitCode, stdout: new TextDecoder().decode(finished.value.stdout) };
}

/**
 * Start the install in a new box and return the box's id. Throws `DockerUnavailable` (code `DOCKER_UNAVAILABLE`) when there is
 * no Docker. The id is all a later process needs to find the install again.
 */
export async function startInstall(name: string, version: string, options: InstallOptions = {}): Promise<{ boxId: string }> {
  if (!NAME.test(name)) throw new InstallBoxError(`${JSON.stringify(name)} is not an npm package name`);
  if (!VERSION.test(version)) throw new InstallBoxError(`${JSON.stringify(version)} is not a package version`);
  const program = options.docker ?? 'docker';
  await dockerReady(program);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const created = await provider(options.docker).create(
    { image: options.image ?? DEFAULT_IMAGE, workspace: '/workspace', maxLifetimeMs: timeoutMs + LIFETIME_SLACK_MS, labels: { 'install-probe': '1', ...options.labels } },
    BACKGROUND_CONTEXT,
  );
  if (!created.ok) throw new InstallBoxError(`the box could not be created: ${created.error.message}`, created.error);
  const box = created.value;
  try {
    const uploaded = await box.upload([{ path: `${DIRECTORY}/run.sh`, bytes: new TextEncoder().encode(RUN_SCRIPT), mode: 0o700 }], BACKGROUND_CONTEXT);
    if (!uploaded.ok) throw new InstallBoxError(`the install script could not be uploaded: ${uploaded.error.message}`, uploaded.error);
    // Detached, with no pipe back: the install goes on when this process is killed.
    const limit = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const traceLimit = String(Math.max(1024, Math.floor(options.traceLimitBytes ?? DEFAULT_TRACE_LIMIT_BYTES)));
    const started = await exec(box, ['sh', '-c', `setsid sh ${DIRECTORY}/run.sh "$1" "$2" "$3" </dev/null >/dev/null 2>&1 & echo started`, 'sh', `${name}@${version}`, limit, traceLimit]);
    if (started === undefined || !started.stdout.includes('started')) throw new InstallBoxError('the install did not start in the box');
  } catch (cause) {
    await box.destroy(BACKGROUND_CONTEXT);
    throw cause;
  }
  return { boxId: box.id };
}

/**
 * The install's result, once it has ended. Waits up to `waitMs` for it and then answers `{ running: true }`. `{ gone: true }`
 * means there is no such box: it was killed, it ended, or this call already read its result (the box is removed then, so the
 * caller keeps the first result).
 */
export async function attachInstall(boxId: string, options: AttachOptions = {}): Promise<InstallAttach> {
  const program = options.docker ?? 'docker';
  await dockerReady(program);
  const attached = await provider(options.docker).attach(boxId, BACKGROUND_CONTEXT);
  if (!attached.ok) {
    if (attached.error.code === 'gone' || attached.error.code === 'not_found') return { gone: true };
    throw new InstallBoxError(`the box could not be looked up: ${attached.error.message}`, attached.error);
  }
  const box = attached.value;
  if (box === undefined) return { gone: true };
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const seen = await exec(box, ['sh', '-c', `cat ${DIRECTORY}/exit 2>/dev/null; true`]);
    if (seen === undefined) return { gone: true };
    if (seen.stdout.trim() !== '') break;
    if (Date.now() >= deadline) return { running: true };
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  const read = async (file: string, tail = 0): Promise<string | undefined> => {
    const answer = await exec(box, ['sh', '-c', tail > 0 ? `tail -c ${tail} ${DIRECTORY}/${file} 2>/dev/null` : `cat ${DIRECTORY}/${file} 2>/dev/null`], 60_000);
    return answer?.stdout;
  };
  const exitText = await read('exit');
  const start = await read('install.start');
  const end = await read('install.end');
  const trace = await read('net.log');
  const scriptLog = await read('install.log', LOG_TAIL_BYTES);
  const truncated = (await read('net.truncated'))?.trim() === '1';
  if (exitText === undefined || trace === undefined || scriptLog === undefined) return { gone: true };
  // A name comes from the DNS answer the install received. Only an address no answer named is matched by asking the resolver
  // again (a CDN's addresses rotate, so that is a fallback and can miss).
  const addresses = answerNames(trace);
  let outbound = outboundOf(trace, addresses);
  if (outbound.some((connection) => connection.host === undefined)) {
    // Best effort: the result is already read, so a lookup that fails, times out or finds the box gone leaves that name out.
    for (const host of dnsNames(trace)) {
      const resolved = await exec(box, ['getent', 'ahosts', host]).catch(() => undefined);
      if (resolved === undefined) continue;
      for (const line of resolved.stdout.split('\n')) {
        const ip = line.trim().split(/\s+/)[0];
        if (ip && !addresses.has(ip)) addresses.set(ip, host);
      }
    }
    outbound = outboundOf(trace, addresses);
  }
  const result: InstallResult = {
    exitCode: Number.parseInt(exitText.trim(), 10),
    scriptLog,
    outbound,
    durationMs: Math.max(0, Number(end?.trim()) - Number(start?.trim())) || 0,
    seen: SEEN,
    ...(truncated ? { traceTruncated: true as const } : {}),
  };
  // The result is in hand: the box has nothing more to give. A failed removal leaves a box that ends by its lifetime.
  await box.destroy(BACKGROUND_CONTEXT);
  return result;
}

/** Install and wait for the result: `startInstall` and `attachInstall` in one call. A box that goes away is an error here. */
export async function installProbe(name: string, version: string, options: InstallOptions = {}): Promise<InstallResult> {
  const { boxId } = await startInstall(name, version, options);
  for (;;) {
    const answer = await attachInstall(boxId, options.docker === undefined ? {} : { docker: options.docker });
    if ('gone' in answer) throw new InstallBoxError(`the box ${boxId} is gone`);
    if (!('running' in answer)) return answer;
  }
}

/** End one box by its id (`docker rm -f` of that container), for the demo's mid-install kill. False when it was not there. */
export async function killBox(boxId: string, options: { docker?: string } = {}): Promise<boolean> {
  await dockerReady(options.docker ?? 'docker');
  const attached = await provider(options.docker).attach(boxId, BACKGROUND_CONTEXT);
  if (!attached.ok || attached.value === undefined) return false;
  const ended = await attached.value.destroy(BACKGROUND_CONTEXT);
  return ended.ok;
}

const HEX = /\\x([0-9a-f]{2})/g;

/** The bytes of a quoted string `strace -xx` printed: every byte is `\xNN`. */
function bytesOf(quoted: string): Uint8Array {
  return Uint8Array.from([...quoted.matchAll(HEX)].map((hit) => Number.parseInt(hit[1]!, 16)));
}

/** The name in a DNS query packet, or undefined when the bytes are not one. */
export function queryName(packet: Uint8Array): string | undefined {
  if (packet.length < 17) return undefined;
  const flags = (packet[2]! << 8) | packet[3]!;
  const questions = (packet[4]! << 8) | packet[5]!;
  const answers = (packet[6]! << 8) | packet[7]!;
  if ((flags & 0xf800) !== 0 || questions !== 1 || answers !== 0) return undefined;
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = packet[at];
    if (length === undefined) return undefined;
    if (length === 0) break;
    if (length > 63 || at + 1 + length > packet.length) return undefined;
    const label = String.fromCharCode(...packet.subarray(at + 1, at + 1 + length));
    if (!/^[A-Za-z0-9_-]+$/.test(label)) return undefined;
    labels.push(label.toLowerCase());
    at += 1 + length;
  }
  const type = (packet[at + 1]! << 8) | packet[at + 2]!;
  const klass = (packet[at + 3]! << 8) | packet[at + 4]!;
  if (labels.length < 2 || (type !== 1 && type !== 28) || klass !== 1 || at + 5 !== packet.length) return undefined;
  return labels.join('.');
}

/** The name a DNS answer packet answers and the addresses (A and AAAA records) it gives, or undefined when the bytes are not one. */
export function parseAnswer(packet: Uint8Array): { name: string; ips: string[] } | undefined {
  if (packet.length < 17) return undefined;
  const flags = (packet[2]! << 8) | packet[3]!;
  const questions = (packet[4]! << 8) | packet[5]!;
  const answers = (packet[6]! << 8) | packet[7]!;
  if ((flags & 0x8000) === 0 || (flags & 0x780f) !== 0 || questions !== 1 || answers === 0) return undefined;
  const labelsAt = (start: number): { labels: string[]; end: number } | undefined => {
    const labels: string[] = [];
    let at = start;
    let end = -1;
    for (let hops = 0; hops < 20; hops++) {
      const length = packet[at];
      if (length === undefined) return undefined;
      if ((length & 0xc0) === 0xc0) {
        if (packet[at + 1] === undefined) return undefined;
        if (end < 0) end = at + 2;
        at = ((length & 0x3f) << 8) | packet[at + 1]!;
        continue;
      }
      if (length === 0) return { labels, end: end < 0 ? at + 1 : end };
      if (length > 63 || at + 1 + length > packet.length) return undefined;
      const label = String.fromCharCode(...packet.subarray(at + 1, at + 1 + length));
      if (!/^[A-Za-z0-9_-]+$/.test(label)) return undefined;
      labels.push(label.toLowerCase());
      at += 1 + length;
    }
    return undefined;
  };
  const question = labelsAt(12);
  if (question === undefined || question.labels.length < 2) return undefined;
  let at = question.end + 4;
  const ips: string[] = [];
  for (let record = 0; record < answers; record++) {
    const owner = labelsAt(at);
    if (owner === undefined || owner.end + 10 > packet.length) break;
    const type = (packet[owner.end]! << 8) | packet[owner.end + 1]!;
    const length = (packet[owner.end + 8]! << 8) | packet[owner.end + 9]!;
    const data = owner.end + 10;
    if (data + length > packet.length) break;
    if (type === 1 && length === 4) ips.push([...packet.subarray(data, data + 4)].join('.'));
    if (type === 28 && length === 16) {
      const groups = Array.from({ length: 8 }, (_, group) => ((packet[data + 2 * group]! << 8) | packet[data + 2 * group + 1]!).toString(16));
      ips.push(new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1));
    }
    at = data + length;
  }
  return ips.length === 0 ? undefined : { name: question.labels.join('.'), ips };
}

/** Which name each address was answered for, from the DNS answers in the trace (the question's name: a CNAME chain names the first). */
export function answerNames(trace: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of trace.split('\n')) {
    if (!/\brecv(from|msg|mmsg)\(/.test(line)) continue;
    for (const hit of line.matchAll(/"((?:\\x[0-9a-f]{2})+)"/g)) {
      const answer = parseAnswer(bytesOf(hit[1]!));
      if (answer === undefined) continue;
      for (const ip of answer.ips) if (!names.has(ip)) names.set(ip, answer.name);
    }
  }
  return names;
}

/** Every host name a DNS query in the trace asked for. */
export function dnsNames(trace: string): Set<string> {
  const names = new Set<string>();
  for (const line of trace.split('\n')) {
    if (!/\b(send|sendto|sendmmsg)\(/.test(line)) continue;
    for (const hit of line.matchAll(/"((?:\\x[0-9a-f]{2})+)"/g)) {
      const name = queryName(bytesOf(hit[1]!));
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

const CONNECT = /^(?:\d+\s+)?(\d+)\.(\d+)\s+connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\)[^}]*?(?:inet_addr|inet_pton\(AF_INET6,) ?\(?"([^"]+)"/;

/** An address as `strace -xx` printed it: plain, or every byte as `\xNN`. */
function addressOf(printed: string): string {
  return printed.includes('\\x') ? String.fromCharCode(...bytesOf(printed)) : printed;
}

/**
 * The connections in the trace, first sight of each address and port, oldest first. Not listed: loopback, port 0 (the resolver
 * library connects a datagram socket to learn its source address) and port 53 (the install's DNS, which the names come from).
 */
export function outboundOf(trace: string, addresses: ReadonlyMap<string, string>): Outbound[] {
  const found = new Map<string, Outbound>();
  for (const line of trace.split('\n')) {
    const hit = CONNECT.exec(line);
    if (hit === null) continue;
    const ip = addressOf(hit[4]!);
    const port = Number(hit[3]);
    if (port === 0 || port === 53 || ip === '::1' || ip.startsWith('127.') || ip === '0.0.0.0' || ip === '::') continue;
    const key = `${ip}:${port}`;
    if (found.has(key)) continue;
    const host = addresses.get(ip);
    found.set(key, { ...(host === undefined ? {} : { host }), ip, port, at: Number(hit[1]) * 1000 + Math.floor(Number(hit[2]) / 1000) });
  }
  return [...found.values()].sort((a, b) => a.at - b.at);
}
