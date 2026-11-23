// `agentrun-serve import`: the Claude Code, Codex, pi and Cursor CLI sessions under a person's own home, into this
// server's agent store, once, when asked. Each project directory is one agent; each harness seen in it one revision of
// that agent, its instructions the project's CLAUDE.md or AGENTS.md and its skills the project's skill folders; each
// session one run, ended as it ended, its transcript the run's timeline. An imported run is history: it takes no message,
// stop or cancel. Nothing leaves the machine, every string written has the environment's key values cut out, and every
// file written is the owner's only. Read again, it imports only the sessions it has not.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, ROOT_CONVERSATION_ID, type StorageWrite, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { type EntryLike, REQUEST_COST, type RunMetrics, runMetricsOf } from "./timeline/index.js";
import { defaultData } from "./files.js";
import { childrenOf, cursorSessionId, HARNESS_OF, inOrder, type Locator, locatorKey, locatorOf, mostEffortOf, priceRequests, readSession, type Session, SOURCE_NAMES, SOURCES, type Source, sessionLocators, type Turn } from "@parcha/agentrun-import";
import { type Found, hoursOf, type OpenAt, summaryLines } from "./import-summary.js";
import { stopOnce } from "./stop-signals.js";
import { catalogPrices, type Listed, providerModels } from "./model.js";
import { logLine } from "./print.js";
import { launchBody } from "./run-launch.js";
import { DEFAULT_PORT } from "./server.js";
import { REDACTED, secretCut, secretsIn } from "./secret-cut.js";
import { handedSecret, SECRET_NAMES, withSecrets } from "./secrets.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { bootSealKey, SealKeyRefused, withSealKey } from "./seal-key.js";
import { toolKeysOverStore } from "./tool-keys-store.js";
import { openServerSecretsOverStore } from "./server-secrets-store.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { type RefusedReason, readWorkBytes, WorkRefused, walkWork } from "./workspace.js";
import { journalEntries } from "./runner/journal-reader.js";
import { bodyOf, type NewRevision, openStore, SchemaVersionUnknown, type Store, StoreFromEarlierVersion, StoreOwned, storeTarget } from "./store/index.js";
import { STORE_FILE } from "./store/sqlite/store.js";
import { foundOverStore } from "./store-reads/import-summary.js";

/** What `runImport`, `planImport` and the CLI reach of the server's open store: the agents it reads and writes, the runs it
 *  lists, the one `importRun` write and the journal reads its dedup needs. A narrow view, so the setup worker can serve it
 *  across a port without the rest of the store. */
export type ImportStore = {
  agents: Pick<Store["agents"], "get" | "create" | "addRevision" | "setCurrent" | "revisions">;
  runs: Pick<Store["runs"], "list">;
  importRun: Store["importRun"];
  readJournal: Store["readJournal"];
};

/** Read only the explicitly selected project's historical sessions for an outbound connector. Metadata enumeration
 * locates project sessions; unrelated transcripts are never exported or scanned for keys. No model is called and no
 * source file is changed. Each page is independently redacted, bounded and safe to retry at the destination. */
export async function exportRemoteHistory(
  target: Pick<import('./native/types.js').NativeTarget, 'runtime'|'project'|'selector'>,
  options: { home?: string; env?: NodeJS.ProcessEnv; own?: readonly string[]; now?: number; cursor?: number; inventory?: string; preview?: boolean } = {},
): Promise<{ sessions: import('./native/history.js').RemoteHistorySession[]; skipped: { reason: string; count: number }[]; next_cursor: number|null; total: number; inventory: string }> {
  if (target.selector.kind !== 'project') throw new Error('Session logs do not reliably identify named agents or profiles. Select the project to import its history.');
  const now=options.now??Date.now(), cursor=options.cursor??0;
  if(!Number.isSafeInteger(cursor)||cursor<0)throw new Error('Invalid history cursor.');
  const project=await realpath(target.project), selected:Pick<Session,'source'|'id'|'file'|'within'>[]=[], skipped=new Map<string,number>(),stamps=new Map<string,string>();
  const sourceEnv=options.env??process.env;
  const skip=(reason:string)=>skipped.set(reason,(skipped.get(reason)??0)+1);
  for(const {locator,stats} of await inOrder(await sessionLocators(options.home??homedir(),target.runtime,{env:sourceEnv}),target.runtime)){
    const file=locator.file;
    if(stats.size>MAX_SESSION_BYTES){skip('Source session project could not be checked: file exceeds the metadata limit.');continue;}
    // Stop once a complete metadata record names its project. An opening prompt may itself be over 128 KiB;
    // the probe is bounded by the same byte limit as a remotely importable session, without scanning its secrets.
    const header=await remoteHistoryMetadata(file,target.runtime).catch(()=>undefined);
    if(!header){skip('Source session project could not be checked: unreadable metadata or metadata size limit exceeded.');continue;}
    if((await realpath(header.cwd).catch(()=>header.cwd))!==project)continue;
    // Metadata identifies the project without parsing a transcript that cannot fit in any export page.
    if(stats.size>REMOTE_HISTORY_SOURCE_BYTES){skip('Source session file exceeds the remote import size limit.');continue;}
    if(header.child){skip('Subagent history is not a separate session.');continue;}
    if(now-stats.mtimeMs<LIVE_MS){skip('Still being written or modified within ten minutes.');continue;}
    selected.push({source:target.runtime,id:header.id,file,...(locator.id===undefined?{}:{within:locator.id})});stamps.set(locatorKey(locator),remoteHistoryStamp(stats));
  }
  const groups=byRun(selected).sort((a,b)=>a[0]!.id.localeCompare(b[0]!.id));
  const inventory=hash(JSON.stringify({project,runtime:target.runtime,groups:groups.map(files=>({id:files[0]!.id,files:files.map(file=>({path:locatorKey(locatorOf(file)),stamp:stamps.get(locatorKey(locatorOf(file)))})).sort((a,b)=>a.path.localeCompare(b.path))}))}));
  if((cursor>0 && options.inventory===undefined) || (options.inventory!==undefined && options.inventory!==inventory))throw new Error('The selected history inventory changed or is missing. Restart the import from its preview; previously imported sessions are safe to retry.');
  const report=()=>[...skipped].map(([reason,count])=>({reason,count}));
  if(options.preview)return {sessions:[],skipped:report(),next_cursor:null,total:groups.length,inventory};
  if(cursor>0)skipped.clear(); // enumeration skips are reported once; each page still reports its own skips
  const sessions:import('./native/history.js').RemoteHistorySession[]=[],cut=secretCut([process.env,options.env??{}],SECRET_NAMES);
  cut.add(options.own??[]);
  let bytes=0,index=cursor;
  for(;index<groups.length && sessions.length<20;index++){
    const parts:Session[]=[],seen=new Set<string>();let changed=false,child=false;
    for(const listed of groups[index]!){
      const before=await stat(listed.file).catch(()=>undefined);
      const approvedStamp=stamps.get(locatorKey(locatorOf(listed)));
      if(!before || remoteHistoryStamp(before)!==approvedStamp || now-before.mtimeMs<LIVE_MS || before.size>REMOTE_HISTORY_SOURCE_BYTES){changed=true;break;}
      const part=await readSession(locatorOf(listed),target.runtime,{seen}).catch(()=>undefined),after=await stat(listed.file).catch(()=>undefined);
      if(!part || !after || remoteHistoryStamp(after)!==approvedStamp || !part.cwd || (await realpath(part.cwd).catch(()=>part.cwd))!==project || part.id!==listed.id){changed=true;break;}
      // Opening metadata is only a candidate: a later record can identify a child session.
      // The full parser remains authoritative before any transcript can leave the machine.
      if(part.child){child=true;break;}
      parts.push(part);
    }
    if(child){skip('Subagent history is not a separate session.');continue;}
    if(changed||!parts.length){skip('Source session changed during export or became unreadable.');continue;}
    const session=merged(parts);
    if(!session.startedAt || !session.endedAt || Date.parse(session.endedAt)>now-LIVE_MS){skip('Session has no stable historical completion time.');continue;}
    if(session.turns.length>2000){skip('Session exceeds 2000 turns; it was not truncated.');continue;}
    cut.add(await keysInSessions(parts));
    // Include current and older connector/enrollment credentials, even when no longer present in the environment.
    cut.add(JSON.stringify(parts).match(/ar_(?:connector|enroll|local)_[A-Za-z0-9_-]{20,}/g)??[]);
    const packet=JSON.parse(JSON.stringify(cut.json({source:session.source,id:session.id,startedAt:session.startedAt,endedAt:session.endedAt,state:session.state,model:session.model,costUsd:session.costUsd,firstPrompt:session.firstPrompt,activeMs:session.activeMs,turns:session.turns}))) as import('./native/history.js').RemoteHistorySession;
    if(packet.id!==session.id)packet.id=redactedId(session.id);
    const size=Buffer.byteLength(JSON.stringify(packet));
    if(size>1_000_000){skip('Session exceeds 1 MB after redaction; it was not truncated.');continue;}
    try{(await import('./native/history.js')).remoteHistorySessions({sessions:[packet]},target.runtime,now);}catch{skip('Session contains unsupported or excessive fields; it was not truncated.');continue;}
    if(bytes+size>1_800_000)break;
    sessions.push(packet);bytes+=size;
  }
  return {sessions,skipped:report(),next_cursor:index<groups.length?index:null,total:groups.length,inventory};
}

const REMOTE_HISTORY_SOURCE_BYTES = 8_000_000;

/** Candidate identity only, matching readSession's source metadata fields. Stop once both id and project are known;
 * do not parse every transcript on every page. The requested page still fully parses and checks each candidate's
 * id, project and child status under its approved file stamp. Preview counts candidates, not guaranteed exports.
 * Keep at most one bounded JSONL record and never read past the remote source limit, even if a file grows. */
async function remoteHistoryMetadata(file: string, source: Source): Promise<{id:string;cwd:string;child:boolean}|undefined> {
  if(source==='cursor')return cursorMetadata(file);
  const handle = await open(file, 'r');
  // Claude Code's id is its file's name (<id>.jsonl), as readSession reads it; the others' come from a record.
  let id:string|undefined=source==='claude-code'?basename(file,'.jsonl'):undefined,cwd:string|undefined,child=false;
  const str=(value:unknown):string|undefined=>typeof value==='string' && value!==''?value:undefined;
  const metadataOf = (parts: Buffer[]): void => {
    try {
      const row = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(!row || typeof row!=='object' || Array.isArray(row))return;
      if(source==='claude-code'){
        cwd??=str(row.cwd);child ||= row.isSidechain===true;
      }else if(source==='pi'){
        if(row.type==='session'){id=str(row.id)??id;cwd=str(row.cwd)??cwd;}
      }else if(row.type==='session_meta'){
        const payload=row.payload;
        if(!payload || typeof payload!=='object' || Array.isArray(payload))return;
        id=str(payload.id)??id;cwd=str(payload.cwd)??cwd;
        child ||= !!str(payload.parent_thread_id) || !!(payload.source && typeof payload.source==='object' && payload.source.subagent && typeof payload.source.subagent==='object');
      }else if(row.type==='turn_context')cwd??=str(row.payload?.cwd);
    } catch { /* An unreadable record supplies no identity, as in readSession. */ }
  };
  const metadata=()=>id && cwd?{id,cwd,child}:undefined;
  let position = 0, parts: Buffer[] = [];
  try {
    while (position < REMOTE_HISTORY_SOURCE_BYTES) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, REMOTE_HISTORY_SOURCE_BYTES - position));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (!bytesRead) {
        metadataOf(parts);
        // readSession uses the file name only when no source record supplied an id. That is known only at EOF.
        id??=basename(file,'.jsonl');
        return metadata();
      }
      position += bytesRead;
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0 && end < bytesRead; end = bytes.indexOf(10, start)) {
        parts.push(bytes.subarray(start, end));
        metadataOf(parts);
        const found=metadata();
        if(found)return found;
        parts = []; start = end + 1;
      }
      if (start < bytesRead) parts.push(bytes.subarray(start, bytesRead));
    }
    return undefined; // Do not parse a record cut short by the byte limit.
  } finally { await handle.close(); }
}

/** The most of a Cursor chat's meta.json read: a few fields, as cursor-agent writes it. */
const CURSOR_META_BYTES = 64 * 1024;

/** A Cursor chat's candidate identity, from the meta.json beside its store: its id as readSession reads it
 *  (cursorSessionId), and its workspace. Whether it is a subagent's is in the store, which the full read opens. */
async function cursorMetadata(file: string): Promise<{id:string;cwd:string;child:boolean}|undefined> {
  const meta=join(dirname(file),'meta.json');
  if((await stat(meta)).size>CURSOR_META_BYTES)return undefined;
  const row=JSON.parse(await readFile(meta,'utf8')) as unknown;
  const cwd=row && typeof row==='object' && !Array.isArray(row) && typeof (row as {cwd?:unknown}).cwd==='string' ? (row as {cwd:string}).cwd : '';
  return cwd?{id:cursorSessionId(file),cwd,child:false}:undefined;
}

/** In the data directory while an import the owner asked for at setup has not ended: the server's next start goes on with it. */
export const IMPORT_ASKED = ".import-at-setup";
/** A session file written to this recently may still be running: it is left for a later import. */
export const LIVE_MS = 10 * 60_000;
/** The most of one session file read. */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;
/** The most of one run read together: its session's files and its subagents'. A run is held in memory whole while its
 *  keys are found and it is written, so one over this is left out whole (never cut short), whatever the history's size. */
export const MAX_RUN_BYTES = MAX_SESSION_BYTES;
/** The most projects a count names for the owner to choose from: the latest active. */
export const MAX_CANDIDATES = 500;
/** The most of one instructions or skill file read, and of one agent's skill files together. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_BYTES = 1024 * 1024;
/** The project's skill folders, each `<dir>/<name>/` with its SKILL.md, by where each harness keeps them. Cursor's CLI
 *  reads `.cursor/skills` besides `.agents/skills`. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/skills", ".cursor/skills"];
const INSTRUCTIONS: Record<string, string[]> = {
  "claude-agent": ["CLAUDE.md", "AGENTS.md"],
  codex: ["AGENTS.md", "CLAUDE.md"],
  pi: ["AGENTS.md", "CLAUDE.md"],
  // Cursor's CLI reads AGENTS.md, then CLAUDE.md, beside its own .cursor/rules.
  cursor: ["AGENTS.md", "CLAUDE.md"],
};

export type ImportOptions = {
  /** The home whose sessions are read (the person's own). */
  home: string;
  sources?: readonly Source[];
  /** Keep projects whose directory is gone or under the temp directory, and sessions with no message of the person's. */
  all?: boolean;
  /** Keep projects whose directory is gone (a deleted worktree's, a moved checkout's): each still its own agent, with no
   *  instructions or skills to read. */
  deleted?: boolean;
  /** The environment whose key-shaped values are cut out of everything written. */
  env: NodeJS.ProcessEnv;
  /** The tool keys saved through the settings API, opened (tool-keys.ts' `values`): cut out by the same rule. */
  stored?: Record<string, string>;
  /** The secrets this server made and keeps (`ownSecrets`), cut out by their values as the environment's are. */
  own?: readonly string[];
  now?: number;
  /** The temp directory whose projects are left out (default the OS's). */
  temp?: string;
  /** Stops the import between two session files, planned or taken (a server shutting down): what is written stays, and
   *  the next import goes on from there. */
  signal?: AbortSignal;
  /** Each key secretlint finds, as it finds it: for what the CLI prints, cut with the keys the import cuts. */
  onKeys?: (keys: readonly string[]) => void;
  /** How far the import is, for the CLI's progress line: `keys`, the sessions read for keys before anything is written
   *  (`done` of `total`); `write`, the sessions written or passed over. Counts alone, never a name or a path. */
  onProgress?: (step: "keys" | "write", done: number, total: number) => void;
  /** Read each session file through secretlint for the cut (default). Setup's count sets it false: a count keeps no
   *  transcript, so it reads none, and a server's start never scans a whole history to say how many sessions it has. */
  keys?: boolean;
  /** Read each session's turns while planning, and measure it (`Plan.found`): what a dry run's summary counts. */
  measure?: boolean;
  /** The owner's choice: only the projects of these agent ids (`agentIdOf`, as a count's candidates name them) are
   *  planned, so only they are read for keys and written. Absent: every project. */
  only?: readonly string[];
};
/** A project a count found, for the owner to choose: the agent it would become (`id`), its folder, how many sessions
 *  an import would take from it, by which tools, and when the latest of them ended. */
export type ImportCandidate = { id: string; name: string; path: string; sessions: number; sources: Source[]; last_active: string | null };
/** Why a session file or a project's file is left out, by kind, as the left-out counts group them (leftOutLines). */
export type LeftOut = "gone" | "temp" | "live" | "large" | "unread" | "no-project" | "no-words" | "copies" | "vanished" | "file";
/** `session`, when the file was read: the session it holds (`<source>:<id>`), so a session of two files (a resumed Codex
 *  thread) is counted once. */
export type Skipped = { what: string; why: string; kind: LeftOut; session?: string };
export type ProjectPlan = {
  cwd: string;
  agentId: string;
  name: string;
  sessions: Session[];
};
/** `already`: the session files an earlier import took whole, left unread; `held`, the runs an import would not take
 *  again: theirs, and (when measuring) those of planned sessions the store holds already. `children`: the locators of each
 *  session's subagents, whose usage is its run's: Claude Code's by the locator (locatorKey) of the session file beside them, Codex's by `source:thread`; `untied`, those of subagents whose file names
 *  no parent, counted in a summary's totals alone. `found`: each other planned session measured,
 *  when the plan was made to (`measure`). `stopped`: `signal` ended the listing with session files still unlisted. */
export type Plan = { projects: ProjectPlan[]; skipped: Skipped[]; already: number; held: string[]; children: Map<string, Locator[]>; untied: { locator: Locator; source: Source }[]; found?: Found[]; secretsFound?: number; stopped?: true };
export type ImportReport = {
  agents: {
    id: string;
    name: string;
    cwd: string;
    created: boolean;
    runs: number;
    already: number;
  }[];
  skipped: Skipped[];
  already: number;
  /** Each session model a new revision does not pin (no model catalog here lists it): the agent's folder, the source, the
   *  model. The agent runs on the server's default for its harness. */
  modelsLeftOut?: { cwd: string; source: Source; model: string }[];
  /** Keys and tokens cut out of what it wrote (secret-cut.ts): the environment's values, the saved keys, and those of a
   *  known format secretlint found. */
  secretsRemoved?: number;
  /** `signal` ended it with sessions of the plan still to take, or the plan was itself stopped (`Plan.stopped`): the
   *  next import takes the rest. Absent when a stop came with nothing left to take: the import is whole. */
  stopped?: true;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A run's files and its subagents' are over MAX_RUN_BYTES together: the run is left out. */
class RunTooLarge extends Error {}
/** What is left of a run's MAX_RUN_BYTES as its files are read: `fits` takes a file's size from it before the file is read. */
type Budget = { left: number };
const budgetOf = (): Budget => ({ left: MAX_RUN_BYTES });
const fits = (budget: Budget, bytes: number): boolean => (budget.left -= bytes) >= 0;
const tooLarge = (listed: Pick<Session, "file" | "source" | "id">): Skipped => ({ what: listed.file, why: `its files and its subagents' are over ${MAX_RUN_BYTES} bytes together`, kind: "large", session: `${listed.source}:${listed.id}` });

/** The projects of `plan` for the owner to choose from, the latest active first (then by folder), at most MAX_CANDIDATES.
 *  With `env`, the values of its keys are cut from a name and a folder as the import cuts them. */
export function candidatesOf(plan: Pick<Plan, "projects">, env?: NodeJS.ProcessEnv): ImportCandidate[] {
  const text = env ? secretCut(env, SECRET_NAMES).text : (value: string) => value;
  return plan.projects
    .map((project) => {
      const last = project.sessions.reduce<string | undefined>((latest, s) => ((s.endedAt ?? s.startedAt ?? "") > (latest ?? "") ? (s.endedAt ?? s.startedAt) : latest), undefined);
      return { id: project.agentId, name: keptName(project, text), path: text(project.cwd), sessions: sessionsOf(project.sessions).length, sources: [...new Set(project.sessions.map((s) => s.source))].sort(), last_active: last ?? null };
    })
    .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? "") || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATES);
}

/** A session's id as an import keeps it: as it is, unless it holds one of the keys the import cuts, the environment's or
 *  one saved on the server (a session named after its file can), then `redacted-` and a hash of it, the same each time
 *  and different for each id, so two such sessions stay two runs and a later import finds each one's. The plan and the
 *  import keep it from the same keys, or a later import would not find the run an earlier one made. */
const redactedId = (id: string) => `redacted-${hash(id).slice(0, 16)}`;
/** A file's size and time, as an import read it: the same after means the same content was read. */
const stampOf = (stats: { size: number; mtimeMs: number }) => `${stats.size}:${stats.mtimeMs}`;
/** Bind remote consent to the enumerated source, including archive replacements that preserve size and mtime. */
const remoteHistoryStamp = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
const keptId = (envs: readonly NodeJS.ProcessEnv[], own: readonly string[] = []) => {
  const { text, add } = secretCut(envs, SECRET_NAMES);
  add(own);
  // A key secretlint finds in the id itself (a session named after its file); a count, whose ids are kept by no run, asks
  // no scan.
  return async (id: string, scan = true) => (text(id) === id && !(scan && (await secretsIn(id)).length) ? id : redactedId(id));
};

/** The keys secretlint finds in what a run's import writes: its sessions as read (each file once, its path, every
 *  record's strings), in one pass, right before they are cut, so a key a session still being written added after the
 *  plan is found as well. */
async function keysInSessions(sessions: readonly Session[]): Promise<string[]> {
  if (!sessions.length) return [];
  const strings: string[] = [];
  const seen = new Set<object>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) value.forEach(collect);
      else if (value instanceof Map) for (const [name, inner] of value) (collect(name), collect(inner));
      else for (const [name, inner] of Object.entries(value)) (strings.push(name), collect(inner));
    }
  };
  sessions.forEach(collect);
  return secretsIn(strings.join("\n"));
}

/** Every key an import would cut, found before anything of it is written, across every project: each project's own text,
 *  and each run the import would write (its sessions, then its subagents, which the reader holds to MAX_SESSION_BYTES),
 *  read through secretlint once, findings only, into `add`. Each file's size and time as read, and each project's text
 *  as read, are kept: a write reads a run (or a project's text) through secretlint again only if it changed since. */
async function findKeys(plan: Plan, add: (keys: readonly string[]) => void, cut: (text: string) => string, held: (listed: Session) => boolean, signal?: AbortSignal, onProgress?: ImportOptions["onProgress"]): Promise<{ stamps: Map<string, string>; texts: Map<string, string>; large: Set<string> }> {
  const stamps = new Map<string, string>();
  const texts = new Map<string, string>();
  // The runs over MAX_RUN_BYTES (`source:id`): read no further here, and left out by the write.
  const large = new Set<string>();
  for (const project of plan.projects) {
    if (signal?.aborted) break;
    const own = projectText(project.cwd, await projectFiles(project.cwd, []));
    texts.set(project.agentId, hash(own));
    add(await secretsIn(own));
  }
  const toRead = onProgress ? plan.projects.flatMap((p) => byRun(p.sessions)).filter((files) => !held(files[0]!)).length : 0;
  let readSoFar = 0;
  onProgress?.("keys", 0, toRead);
  for (const project of plan.projects) {
    for (const files of byRun(project.sessions)) {
      if (signal?.aborted) break;
      const listed = files[0]!;
      if (held(listed)) continue;
      onProgress?.("keys", readSoFar++, toRead);
      if (signal?.aborted) break;
      // Its own count of records seen: the import's, shared across its files, is the write's to keep.
      const seen = new Set<string>();
      const parts: Session[] = [];
      const budget = budgetOf();
      let over = false;
      for (const entry of files) {
        const stats = await stat(entry.file).catch(() => null);
        if (stats && !fits(budget, stats.size)) {
          over = true;
          break;
        }
        const part = stats ? await readSession(locatorOf(entry), listed.source, { seen }).catch(() => undefined) : undefined;
        if (!part || !stats) continue;
        stamps.set(locatorKey(locatorOf(entry)), stampOf(stats));
        parts.push(part);
      }
      if (over) {
        large.add(`${listed.source}:${listed.id}`);
        continue;
      }
      if (!parts.length) continue;
      add(await keysInSessions(parts));
      const session = merged(parts);
      const subagents = await readChildren(plan, { ...session, id: cut(session.id) === session.id ? session.id : redactedId(session.id) }, parts, seen, budget).catch((error: unknown) => {
        if (!(error instanceof RunTooLarge)) throw error;
        large.add(`${listed.source}:${listed.id}`);
      });
      if (!subagents) continue;
      for (const child of subagents) {
        const stats = await stat(child.file).catch(() => null);
        if (stats) stamps.set(locatorKey(locatorOf(child)), stampOf(stats));
      }
      add(await keysInSessions(subagents));
    }
  }
  return { stamps, texts, large };
}

/** A project's own text for secretlint: its path, its instructions, and its skills' paths and text. */
const projectText = (cwd: string, files: { instructions: Record<string, string>; skills: Record<string, string> }) =>
  [cwd, ...Object.values(files.instructions), ...Object.entries(files.skills).flat()].join("\n");
export const agentIdOf = (cwd: string) => `imp-${hash(`dir:${cwd}`).slice(0, 32)}`;
/** The sessions the store holds already, as `source:session`, to their run's id: a purged run's too, so a session its
 *  owner purged is never imported again. */
const importedIn = async (store: ImportStore): Promise<Map<string, string>> =>
  new Map((await store.runs.list({ purged: true })).flatMap((run) => (run.importedFrom ? [[`${run.importedFrom.source}:${run.importedFrom.session}`, run.id] as const] : [])));
/** A session file as an import read it: its size and its time, so an unchanged one is not parsed again. */
/** The file by the sha256 of its path, never the path: a path can hold what the cut takes out of everything written. */
type SourceFile = { path_sha256: string; size: number; mtime_ms: number };
const sameFile = (seen: SourceFile | undefined, stats: { size: number; mtimeMs: number }) => seen !== undefined && seen.size === stats.size && seen.mtime_ms === stats.mtimeMs;
/** The session files the store's imports read whole, by their path's sha256, with their run: the file stamp an import kept
 *  on the run's `imported_from`, so an unchanged file is not parsed again. */
async function filesIn(store: ImportStore): Promise<Map<string, SourceFile & { run: string }>> {
  const out = new Map<string, SourceFile & { run: string }>();
  for (const run of await store.runs.list({ purged: true })) {
    const seen = run.importedFrom?.file;
    if (seen) out.set(seen.path_sha256, { path_sha256: seen.path_sha256, size: seen.size, mtime_ms: seen.mtime_ms, run: run.id });
  }
  return out;
}
const unread = (file: string, error: unknown): Skipped => ({ what: file, why: `not read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, kind: "unread" });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What an import would take: the sessions under `home`, by project, with what it leaves out and why. Keeps no turns
 *  (with `measure`, only until each session is measured), and reads no file `store`'s imports already read whole and
 *  that has not changed since. */
export async function planImport({ home, sources = SOURCES, all = false, deleted = false, now = Date.now(), temp: tempDir = tmpdir(), measure = false, env, stored, own = [], signal, keys: scan = true, onKeys, only }: ImportOptions, store?: ImportStore): Promise<Plan> {
  // A session's id that holds a key (one named after its file can) is kept as a hash of it: every lookup of an earlier
  // import's run then goes by the id as kept.
  const idOf = keptId([env, stored ?? {}], own);
  const skipped: Skipped[] = [];
  // Each file left out here, with the project folder its read gave, if it was read that far: what `only` goes by.
  const leftFrom = new Map<Skipped, { source: Source; cwd?: string }>();
  const leave = (entry: Skipped, source: Source, cwd?: string) => void (skipped.push(entry), leftFrom.set(entry, { source, cwd }));
  const seen = store ? await filesIn(store) : new Map<string, SourceFile & { run: string }>();
  let already = 0;
  const held: string[] = [];
  const found: Found[] = [];
  const children = new Map<string, Locator[]>();
  const child = (owner: string, locator: Locator) => void children.set(owner, [...(children.get(owner) ?? []), locator]);
  const untied: Plan["untied"] = [];
  const projects = new Map<string, ProjectPlan>();
  let stopped = false;
  // Each listed session's place in the import's order (inOrder).
  const rank = new Map<Session, number>();
  const temps = [...new Set([tempDir, await realpath(tempDir).catch(() => tempDir)])];
  for (const source of sources) {
    for (const { locator, stats } of await inOrder(await sessionLocators(home, source), source)) {
      const { file } = locator;
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      const known = seen.get(hash(locatorKey(locator)));
      if (sameFile(known, stats)) {
        already += 1;
        held.push(known!.run);
        continue;
      }
      if (now - stats.mtimeMs < LIVE_MS) {
        leave({ what: file, why: "written in the last 10 minutes: it may still be running", kind: "live" }, source);
        continue;
      }
      if (stats.size > MAX_SESSION_BYTES) {
        leave({ what: file, why: `over ${MAX_SESSION_BYTES} bytes`, kind: "large" }, source);
        continue;
      }
      // One file this user cannot read, or one gone since its stat, is named and passed over: the rest still import.
      const session = await readSession(locator, source, { turns: false }).catch((error: unknown) => leave(unread(file, error), source));
      if (!session) continue;
      session.id = await idOf(session.id, scan);
      if (session.parent) session.parent = await idOf(session.parent, scan);
      // A subagent's session is no run of its own: its usage is its parent's, when its file names the parent (a Codex
      // thread's, whichever of its files); else it counts in the totals alone, where its project would.
      if (session.child && session.parent) {
        child(`${source}:${session.parent}`, locator);
        continue;
      }
      if (!session.cwd) {
        leave({ what: file, why: "no project directory in it", kind: "no-project" }, source);
        continue;
      }
      if (!all && session.users === 0 && !session.child) {
        leave({ what: file, why: "no message of the person's", kind: "no-words", session: `${source}:${session.id}` }, source, session.cwd);
        continue;
      }
      const cwd = session.cwd;
      if (!all) {
        // A temp folder first, gone or not: only --all brings it in, as the left-out line says.
        if (temps.some((temp) => cwd === temp || cwd.startsWith(temp + sep))) {
          leave({ what: file, why: `its project ${cwd} is a temp directory`, kind: "temp", session: `${source}:${session.id}` }, source, cwd);
          continue;
        }
        const there = await lstat(cwd).catch(() => null);
        if (!there?.isDirectory() && !deleted) {
          leave({ what: file, why: `its project ${cwd} is gone`, kind: "gone", session: `${source}:${session.id}` }, source, cwd);
          continue;
        }
      }
      if (session.child) {
        untied.push({ locator, source });
        continue;
      }
      let project = projects.get(cwd);
      if (!project)
        projects.set(
          cwd,
          (project = {
            cwd,
            agentId: agentIdOf(cwd),
            name: basename(cwd) || cwd,
            sessions: [],
          }),
        );
      rank.set(session, rank.size);
      project.sessions.push(session);
    }
    for (const { locator, of } of await childrenOf(home, source)) child(locatorKey(of), locator);
  }
  ownRuns(projects, rank);
  // The owner's choice, once each session has its one project: a project not chosen is no part of the plan.
  const chosen = only === undefined ? undefined : new Set(only);
  // What is left out is said of the projects chosen alone, each file by the folder it names: as its read gave it, or,
  // for a file left out unread (still written, over the cap, unreadable), as its first records say. A file that names
  // no folder is no chosen project's.
  if (chosen) {
    const ofChosen: Skipped[] = [];
    for (const entry of skipped) {
      // A stop ends these reads as it ends the listing's: the plan is the stopped one's, and is not used.
      if (signal?.aborted) break;
      const { source, cwd = (await remoteHistoryMetadata(entry.what, source).catch(() => undefined))?.cwd } = leftFrom.get(entry)!;
      if (cwd !== undefined && chosen.has(agentIdOf(cwd))) ofChosen.push(entry);
    }
    skipped.splice(0, skipped.length, ...ofChosen);
  }
  const plan: Plan = { projects: [...projects.values()].filter((project) => !chosen || chosen.has(project.agentId)).sort((a, b) => a.cwd.localeCompare(b.cwd)), skipped, already, held, children, untied, ...(stopped ? { stopped: true } : {}) };
  if (!measure) return plan;
  const counting = secretCut(env, SECRET_NAMES);
  // Every key the import would cut, found first, as the import finds it before it writes anything: then the counts.
  const heldBy = store ? await importedIn(store) : undefined;
  const foundKeys = (keys: readonly string[]) => (counting.add(keys), onKeys?.(keys));
  // This server's own secrets first, as the import takes them.
  foundKeys(own);
  const { large } = await findKeys(plan, foundKeys, counting.text, (listed) => heldBy?.get(`${listed.source}:${listed.id}`) !== undefined, signal);
  // Measured in the import's own order, a record or response counted once across files, each session with its
  // subagents; a session the store holds already from its run, as the import counts it, not from its file now.
  for (const project of plan.projects) {
    const seen = await seenIn(store, project.agentId);
    for (const files of byRun(project.sessions)) {
      const run = heldBy?.get(`${files[0]!.source}:${files[0]!.id}`);
      if (run !== undefined) {
        held.push(run);
        continue;
      }
      // A run over MAX_RUN_BYTES is left out by the import, so by its dry run: said, and read no further.
      if (large.has(`${files[0]!.source}:${files[0]!.id}`)) {
        skipped.push(tooLarge(files[0]!));
        continue;
      }
      // Each of its files read; those holding only copies add no records to it, but their subagents' folders are its
      // too, read through the same count (readChildren).
      const read: Session[] = [];
      const budget = budgetOf();
      let over = false;
      for (const listed of files) {
        const stats = await stat(listed.file).catch(() => null);
        // Grown over the cap since the scan above: left out here as the import leaves it out, and read no further.
        if (stats && !fits(budget, stats.size)) {
          over = true;
          break;
        }
        const part = await readSession(locatorOf(listed), listed.source, { seen: seen(listed.source) }).catch(() => undefined);
        if (part) read.push(part);
      }
      if (over) {
        skipped.push(tooLarge(files[0]!));
        continue;
      }
      const parts = read.filter((part) => !ownless(part));
      if (!parts.length) continue;
      const session = merged(parts);
      // What the import's cut would take out of it (its turns, its first message): the dry run's count.
      counting.json(session.turns);
      if (session.firstPrompt) counting.text(session.firstPrompt);
      const subagents = await readChildren(plan, session, read, seen(session.source), budget).catch((error: unknown) => {
        if (!(error instanceof RunTooLarge)) throw error;
        skipped.push(tooLarge(files[0]!));
      });
      if (!subagents) continue;
      found.push({ source: session.source, agent: project.agentId, ...measured(session, subagents) });
    }
  }
  // Each project's files read as the import reads them, held agent or new: each file it leaves out (a link, one over its
  // cap) is among what the dry run says it leaves out. A new agent's own text (its name, its path, its instructions and
  // skills) is the import's to cut too: counted here, after every key is known, as the import cuts it.
  for (const project of plan.projects) {
    const files = await projectFiles(project.cwd, skipped);
    if (store && (await store.agents.get(project.agentId))) continue;
    counting.text(project.name);
    counting.text(project.cwd);
    for (const text of Object.values(files.instructions)) counting.text(text);
    for (const [path, text] of Object.entries(files.skills)) (counting.text(path), counting.text(text));
  }
  return { ...plan, found, secretsFound: counting.text.removed };
}

/** The subagents tied to no session: each one's tokens and tool calls, for a summary's totals, each response once. */
export async function untiedFound(plan: Plan): Promise<Found[]> {
  const seen = new Map<Source, Set<string>>();
  const counted = (source: Source) => seen.get(source) ?? seen.set(source, new Set()).get(source)!;
  // A thread resumed in a second file of the same id is one: its own subagents, which name it, count once with it.
  const threads = new Map<string, Session[]>();
  for (const { locator, source } of plan.untied) {
    const stats = await stat(locator.file).catch(() => null);
    if (!stats || stats.size > MAX_SESSION_BYTES) continue;
    const session = await readSession(locator, source, { seen: counted(source) }).catch(() => undefined);
    if (session) threads.set(`${source}:${session.id}`, [...(threads.get(`${source}:${session.id}`) ?? []), session]);
  }
  const found: Found[] = [];
  for (const parts of threads.values()) {
    const session = merged(parts);
    // One whose own subagents are over the cap together counts for itself alone: the totals never hold more than a run.
    const children = await readChildren(plan, session, parts, counted(session.source), budgetOf()).catch((error: unknown) => {
      if (!(error instanceof RunTooLarge)) throw error;
      return [] as Session[];
    });
    found.push({ source: session.source, agent: "", untied: true, metrics: metricsOf(session, children) });
  }
  return found;
}

/** Each session's files in the project of its first file by start (the earliest-named of a tie), whichever project the
 *  others' records name: one run, in one agent, on every import. Each project's files in the import's order (`rank`); a
 *  project left with none is none. */
function ownRuns(projects: Map<string, ProjectPlan>, rank: ReadonlyMap<Session, number>): void {
  const files = new Map<string, { session: Session; project: ProjectPlan }[]>();
  for (const project of projects.values()) for (const session of project.sessions) files.set(`${session.source}:${session.id}`, [...(files.get(`${session.source}:${session.id}`) ?? []), { session, project }]);
  const first = (a: Session, b: Session) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.file.localeCompare(b.file);
  for (const run of files.values()) {
    if (run.length < 2) continue;
    const owner = run.reduce((one, other) => (first(other.session, one.session) < 0 ? other : one)).project;
    for (const { session, project } of run) if (project !== owner) (project.sessions.splice(project.sessions.indexOf(session), 1), owner.sessions.push(session));
  }
  for (const [cwd, project] of projects) {
    if (project.sessions.length) project.sessions.sort((a, b) => rank.get(a)! - rank.get(b)!);
    else projects.delete(cwd);
  }
}

/** A project's session files by the session they write, each session's in order, the sessions in their first files'
 *  order: a Codex thread resumed later writes a new file of the same id, and a Claude Code session resumed in another
 *  directory is copied into that project's folder under its id, then carried on. The store keeps one run of a session. */
function byRun<T extends Pick<Session,'source'|'id'>>(sessions: readonly T[]): T[][] {
  const runs = new Map<string, T[]>();
  for (const session of sessions) runs.set(`${session.source}:${session.id}`, [...(runs.get(`${session.source}:${session.id}`) ?? []), session]);
  return [...runs.values()];
}

/** The sessions `files` write, as the import takes them: one per source and session id, however many files write it
 *  (`byRun`), with its cost known when each of its files' is (as `merged` prices it). What a dry run counts. */
export const sessionsOf = (files: readonly Session[]): { source: Source; key: `${Source}:${string}`; priced: boolean }[] =>
  byRun(files).map((parts) => ({ source: parts[0]!.source, key: `${parts[0]!.source}:${parts[0]!.id}` as const, priced: parts.every((s) => s.costUsd !== undefined) }));

/** A session's files, read in the import's order with its `seen` (which file keeps a copied record), as the one run the
 *  store keeps of it: their turns in the order they ran (each file's by its start; each answer with its own file's model
 *  when it names none), its state and model the file's that ended last. Its cost, when each file's is known: Claude Code
 *  writes the session's running total (a moved session's copy goes on from the original's), so the highest total
 *  written; another source's file prices its own requests, so their sum. */
function merged(parts: readonly Session[]): Session {
  if (parts.length === 1) return parts[0]!;
  const ordered = [...parts].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.file.localeCompare(b.file));
  const [first, last] = [ordered[0]!, ordered.reduce((one, other) => ((other.endedAt ?? "") >= (one.endedAt ?? "") ? other : one))];
  const turns = ordered.flatMap((part) => part.turns.map((turn): Turn => (turn.role === "assistant" && !turn.model && part.model ? { ...turn, model: part.model } : turn)));
  const sum = (key: "users" | "activeMs" | "copies") => parts.reduce((n, part) => n + part[key], 0);
  const effort = mostEffortOf(turns);
  const starts = parts.flatMap((part) => (part.startedAt ? [part.startedAt] : [])).sort();
  const priced = parts.flatMap((part) => (part.costUsd !== undefined ? [part.costUsd] : []));
  // Known only when each file's is: a file whose spending is unknown (an unpriced model, no cost written) leaves the
  // session's unknown, never a part of it stored as the whole.
  const costUsd = priced.length < parts.length ? undefined : first.source === "claude-code" ? Math.max(...priced) : priced.reduce((n, cost) => n + cost, 0);
  const { model: _model, startedAt: _start, endedAt: _end, costUsd: _cost, firstPrompt: _prompt, sourceTitle: _sourceTitle, titleText: _title, effort: _effort, ...rest } = first;
  const model = last.model ?? first.model;
  const firstPrompt = ordered.find((part) => part.firstPrompt !== undefined)?.firstPrompt;
  // The session's title as its latest file wrote it, and the person's first words as its first file has them.
  const sourceTitle = ordered.findLast((part) => part.sourceTitle !== undefined)?.sourceTitle;
  const titleText = ordered.find((part) => part.titleText !== undefined)?.titleText;
  return {
    ...rest,
    ...(model ? { model } : {}),
    ...(starts[0] ? { startedAt: starts[0] } : {}),
    ...(last.endedAt ? { endedAt: last.endedAt } : {}),
    state: last.state,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    ...(sourceTitle !== undefined ? { sourceTitle } : {}),
    ...(titleText !== undefined ? { titleText } : {}),
    turns,
    users: sum("users"),
    activeMs: sum("activeMs"),
    copies: sum("copies"),
    ...(effort ? { effort } : {}),
  };
}

/** A session that holds only records an earlier file of the import holds (a resumed session's copy of them). */
const ownless = (session: Session) => session.copies > 0 && !session.turns.some((turn) => turn.role !== "note");

/** The records and responses an import has counted, by source, for one project: first those its runs in `store` hold
 *  already (each answer's response id and each entry's record ids, as its transcript keeps them), then each file's as it
 *  is read. */
async function seenIn(store: ImportStore | undefined, agentId: string): Promise<(source: Source) => Set<string>> {
  const bySource = new Map<Source, Set<string>>();
  const seen = (source: Source) => bySource.get(source) ?? bySource.set(source, new Set()).get(source)!;
  if (!store || !(await store.agents.get(agentId))) return seen;
  for (const run of await store.runs.list({ agentId })) {
    if (run.importedFrom?.source !== "claude-code") continue;
    for (const entry of (await journalEntries(store.readJournal(run.id), ctx)) as unknown as EntryLike[]) {
      const id = (entry.model?.[0] as { responseId?: unknown } | undefined)?.responseId;
      if (typeof id === "string" && id) seen("claude-code").add(`m:${id}`);
      // A run imported before a request's key held its request id (message id:request id) keeps the bare message id:
      // the reader matches it against a request's message id alone.
      if (typeof id === "string" && id && !id.includes(":")) seen("claude-code").add(`l:${id}`);
      const uuids = (entry.data as { record_uuids?: unknown } | undefined)?.record_uuids;
      if (Array.isArray(uuids)) for (const uuid of uuids) if (typeof uuid === "string") seen("claude-code").add(`u:${uuid}`);
    }
  }
  return seen;
}

/** A run's subagents, theirs, and so on down, each file once, read with the import's `seen`: those beside each of its
 *  files (Claude Code's), and those naming its thread (Codex's, whichever of its files they ran under). One gone or
 *  unreadable is passed over. All of them are held at once, so their sizes are taken from `budget` (what the run's own
 *  files left of MAX_RUN_BYTES) before each is read: RunTooLarge once it is spent, as one file over the cap alone spends it. */
async function readChildren(plan: Plan, session: Session, parts: readonly Session[], seen: Set<string>, budget: Budget): Promise<Session[]> {
  const out: Session[] = [];
  const visited = new Set<string>();
  const under = async (owner: string): Promise<void> => {
    for (const locator of plan.children.get(owner) ?? []) {
      const key = locatorKey(locator);
      if (visited.has(key)) continue;
      visited.add(key);
      const stats = await stat(locator.file).catch(() => null);
      if (!stats) continue;
      // Every subagent read is held with the run: one more than the run's cap holds ends the read, and the run is left out.
      // No subagent is passed over for its size: the run would be kept without its usage.
      if (!fits(budget, stats.size)) throw new RunTooLarge();
      const child = await readSession(locator, session.source, { seen }).catch(() => undefined);
      if (!child) continue;
      out.push(child);
      // A subagent's own subagents (Codex names each one's parent thread) are the run's too.
      await under(`${session.source}:${child.id}`);
    }
  };
  for (const part of parts) await under(locatorKey(locatorOf(part)));
  await under(`${session.source}:${session.id}`);
  return out;
}

/** A subagent's requests in its session's transcript: each one a request with no answer of its own there, its usage and
 *  its cost (none known: null), as a request's cost is written with no answer (REQUEST_COST). The timeline shows none of
 *  them, and its usage row, the run's cost and runMetricsOf all count each one. */
const subagentMarks = (children: readonly Session[]): EntryLike[] =>
  children.flatMap((child) =>
    child.turns.flatMap((turn) => {
      if (turn.role !== "assistant") return [];
      const { input, output, cacheRead, cacheWrite } = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      // A failed request's counts are its own, zeros included, as its answer's are (entryOf).
      return [{ kind: REQUEST_COST, data: { request: "subagent", usd: turn.costUsd ?? null, usage: { input, output, cacheRead, cacheWrite }, ...(turn.error !== undefined ? { failed: true } : {}) } } as EntryLike];
    }),
  );

/** A session's entries as its transcript holds them, its subagents' requests with them (subagentMarks). */
const runEntries = (session: Session, children: readonly Session[]): EntryLike[] => [...entriesOf(session), ...subagentMarks(children)];

/** What a session used, its subagents' requests with it: runMetricsOf of its entries, and its subagents' models and tool
 *  calls, which their marks do not carry. */
function metricsOf(session: Session, children: readonly Session[]): RunMetrics {
  return withChildren(runMetricsOf(runEntries(session, children)), children.map((child) => runMetricsOf(entriesOf(child))));
}

/** A run's metrics with its subagents' models and tool calls in them (their requests and tokens are in its entries). The
 *  run's model stays its own. */
function withChildren(own: RunMetrics, children: readonly RunMetrics[]): RunMetrics {
  const sum = { ...own, models: { ...own.models }, tools: Object.fromEntries(Object.entries(own.tools).map(([name, tool]) => [name, { ...tool }])) };
  for (const child of children) {
    for (const [name, n] of Object.entries(child.models)) sum.models[name] = (sum.models[name] ?? 0) + n;
    for (const [name, tool] of Object.entries(child.tools)) {
      const into = (sum.tools[name] ??= { calls: 0, errors: 0 });
      into.calls += tool.calls;
      into.errors += tool.errors;
    }
  }
  if (sum.model === undefined) {
    for (const [name, n] of Object.entries(sum.models)) if (sum.model === undefined || n > sum.models[sum.model]!) sum.model = name;
  }
  return sum;
}

/** A project's instructions file and skill folders, read through no link and within their caps. Each file left out is
 *  in `skipped`, named, with why: a link, not text, over its cap, or a folder with no SKILL.md. */
export async function projectFiles(
  cwd: string,
  skipped: Skipped[],
): Promise<{
  instructions: Record<string, string>;
  skills: Record<string, string>;
}> {
  const instructions: Record<string, string> = {};
  const skills: Record<string, string> = {};
  // A project kept by --all or --include-deleted whose directory is gone has neither.
  if (!(await lstat(cwd).catch(() => null))?.isDirectory()) return { instructions, skills };
  const why = (reason: RefusedReason) => (reason === "over_cap" ? `over ${MAX_FILE_BYTES} bytes` : reason === "link" ? "a link: not followed" : reason.replace("_", " "));
  const text = async (rel: string): Promise<string | undefined> => {
    try {
      const bytes = await readWorkBytes(cwd, rel, { maxBytes: MAX_FILE_BYTES });
      const decoded = bytes.includes(0)
        ? undefined
        : (() => {
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              return undefined;
            }
          })();
      if (decoded === undefined) skipped.push({ what: join(cwd, rel), why: "not text", kind: "file" });
      return decoded;
    } catch (error) {
      if (!(error instanceof WorkRefused)) throw error;
      if (error.reason !== "missing") skipped.push({ what: join(cwd, rel), why: why(error.reason), kind: "file" });
      return undefined;
    }
  };
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const found = await text(name);
    if (found !== undefined) instructions[name] = found;
  }
  let total = 0;
  for (const dir of SKILL_DIRS) {
    // The folder itself is reached through no link: each component is a directory, not a link to one.
    const parts = dir.split("/");
    let reachable = true;
    for (let i = 1; i <= parts.length && reachable; i++) {
      const at = await lstat(join(cwd, ...parts.slice(0, i))).catch(() => null);
      if (!at) reachable = false;
      else if (!at.isDirectory()) {
        skipped.push({
          what: join(cwd, ...parts.slice(0, i)),
          why: at.isSymbolicLink() ? "a link: not followed" : "not a directory",
          kind: "file",
        });
        reachable = false;
      }
    }
    if (!reachable) continue;
    const files = new Map<string, string[]>();
    try {
      await walkWork(
        join(cwd, dir),
        (path, stats) => {
          if (stats.isFile()) {
            const name = path.split("/")[0]!;
            if (path.includes("/")) files.set(name, [...(files.get(name) ?? []), path]);
          }
        },
        {
          depth: 8,
          refused: (path, reason) => skipped.push({ what: join(cwd, dir, path), why: why(reason), kind: "file" }),
        },
      );
    } catch (error) {
      // The folder itself is not read (unreadable to this user): named, and the project's other folders still are.
      if (!(error instanceof WorkRefused)) throw error;
      skipped.push({ what: join(cwd, dir), why: why(error.reason), kind: "file" });
      continue;
    }
    for (const [name, paths] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!paths.includes(`${name}/SKILL.md`)) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "no SKILL.md: not a skill",
          kind: "file",
        });
        continue;
      }
      if (Object.keys(skills).some((path) => path.startsWith(`${name}/`))) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "a skill of this name was already taken from another folder",
          kind: "file",
        });
        continue;
      }
      // Every file is read again through the project, so a link anywhere on its way is refused, not followed.
      const held: Record<string, string> = {};
      for (const path of paths.sort()) {
        const found = await text(`${dir}/${path}`);
        if (found === undefined) continue;
        total += Buffer.byteLength(found);
        if (total > MAX_SKILL_BYTES) {
          skipped.push({
            what: join(cwd, dir, path),
            why: `the project's skill files are over ${MAX_SKILL_BYTES} bytes together`,
            kind: "file",
          });
          continue;
        }
        held[path] = found;
      }
      if (held[`${name}/SKILL.md`] === undefined) {
        skipped.push({
          what: join(cwd, dir, name),
          why: "its SKILL.md was not read: not a skill",
          kind: "file",
        });
        continue;
      }
      Object.assign(skills, held);
    }
  }
  return { instructions, skills };
}

/** A turn's transcript entry, with the source's ids of the records it was read from (`record_uuids`): a later import counts
 *  a copy of them once. */
const message = (turn: Turn, model: string | undefined): { entry: typeof UserEntry; model: unknown; data?: unknown } => {
  const written = entryOf(turn, model);
  return turn.uuids?.length ? { ...written, data: { ...(written.data as object | undefined), record_uuids: turn.uuids } } : written;
};

const entryOf = (turn: Turn, model: string | undefined): { entry: typeof UserEntry; model: unknown; data?: unknown } => {
  if (turn.role === "user")
    return {
      entry: UserEntry,
      model: {
        role: "user",
        content: [{ type: "text", text: turn.text }],
        timestamp: turn.at,
      },
    };
  // The harness's own line, as an interrupt is written: a user's entry, by its author, so no request.
  if (turn.role === "note")
    return {
      entry: UserEntry,
      model: { role: "user", content: [{ type: "text", text: turn.text }], timestamp: turn.at },
      data: { author: turn.author },
    };
  if (turn.role === "toolResult")
    return {
      entry: ToolResultEntry as unknown as typeof UserEntry,
      model: {
        role: "toolResult",
        toolCallId: turn.callId,
        toolName: turn.name,
        content: [{ type: "text", text: turn.text }],
        isError: turn.isError,
        timestamp: turn.at,
      },
      data: { diagnostics: [] },
    };
  const [provider, ...id] = (turn.model ?? model ?? "imported/unknown").split("/");
  const cost = turn.costUsd;
  // A request the source gave no counts for keeps zeros, which a run's metrics read as unmetered, never as 0 tokens.
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    entry: AssistantEntry as unknown as typeof UserEntry,
    model: {
      role: "assistant",
      content: turn.error !== undefined ? [] : [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...turn.calls],
      api: "imported",
      provider,
      model: id.join("/") || provider,
      // The source's own id for the response: a later import counts it once, whichever file holds it.
      ...(turn.key ? { responseId: turn.key } : {}),
      // No total when the source did not price the request: the timeline's sum is then unknown, never this request at 0.
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: cost === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      // A failed request's zero counts are its counts, as a live run's failed request's are.
      ...(turn.error !== undefined ? { stopReason: "error", errorMessage: turn.error } : { stopReason: turn.calls.length ? "toolUse" : "stop" }),
      timestamp: turn.at,
    },
  };
};

/** The entries `message` makes of a session's turns, as a transcript holds them. */
const entriesOf = (session: Session): EntryLike[] =>
  session.turns.map((turn) => {
    const { entry, model, data } = message(turn, session.model);
    return { kind: entry.kind, model: [model], ...(data ? { data } : {}) } as EntryLike;
  });

/** What a session read whole used, its subagents' requests with it, and when it asked: its metrics and time at work,
 *  and its own requests by hour. */
function measured(session: Session, children: readonly Session[] = []): Pick<Found, "metrics" | "hours"> {
  return {
    metrics: { ...metricsOf(session, children), activeMs: session.activeMs },
    hours: hoursOf(session.turns.flatMap((turn) => (turn.role === "assistant" ? [turn.at] : []))),
  };
}

/** The run's transcript as pi-durable write batches for Store.importRun: the root conversation, then one entry per turn,
 *  its subagents' requests after them (subagentMarks), each string with the environment's key values cut out. Built
 *  directly (as the runner builds its own writes), so no run database is opened; the ids are a run's own, from the root.
 *  Returns the batches and the same entries the old per-run store read back, for the run's metrics and estimate. */
export function transcriptOf(
  session: Session,
  cut: (value: unknown) => unknown,
  children: readonly Session[] = [],
): { batches: StorageWrite[][]; entries: EntryLike[] } {
  const root = ROOT_CONVERSATION_ID;
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: root } } as StorageWrite];
  const entries: EntryLike[] = [];
  let id = Number(root) + 1;
  for (const turn of session.turns) {
    const { entry, model, data } = message(turn, session.model);
    const m = cut(model);
    const d = data === undefined ? undefined : cut(data);
    writes.push({ type: "entry", value: { id, conversationId: root, kind: entry.kind, model: [m], ...(d !== undefined ? { data: d } : {}) } } as unknown as StorageWrite);
    entries.push({ kind: entry.kind, model: [m], ...(d !== undefined ? { data: d } : {}) } as EntryLike);
    id += 1;
  }
  for (const mark of subagentMarks(children)) {
    const d = mark.data === undefined ? undefined : cut(mark.data);
    writes.push({ type: "entry", value: { id, conversationId: root, kind: mark.kind, ...(d !== undefined ? { data: d } : {}) } } as unknown as StorageWrite);
    entries.push({ kind: mark.kind, ...(d !== undefined ? { data: d } : {}) } as EntryLike);
    id += 1;
  }
  return { batches: [writes], entries };
}

/** What a run's requests cost at the catalog's list prices, each at its own provider's entry for its model: undefined when
 *  one request's tokens are unknown or its provider does not list its model (the request was served at a price no one
 *  lists here). A provider's $0 entry is $0. A request of no tokens costs nothing at any price. */
async function estimateOf(entries: readonly EntryLike[], catalog: () => Promise<ReadonlyMap<string, readonly Listed[]>>): Promise<number | undefined> {
  // Unknown when one answer priced here has unknown tokens (a failed one's counts are its own, as runMetricsOf reads them).
  if (runMetricsOf(entries.filter((entry) => entry.kind === "pi.assistant")).unmetered > 0) return undefined;
  // Each answer's request at its own provider's entry, as @parcha/agentrun-import prices a session's totals.
  const requests = entries.flatMap((entry) => {
    const answer = entry.kind === "pi.assistant" ? (entry.model?.[0] as { provider?: string; model?: string; usage?: Record<string, number> } | undefined) : undefined;
    if (!answer?.usage) return [];
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h } = answer.usage;
    return [{ ...(answer.provider && answer.model ? { model: `${answer.provider}/${answer.model}` } : {}), usage: { input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}) } }];
  });
  return priceRequests(requests, await catalog());
}

/** What an imported agent is told when its project has no CLAUDE.md or AGENTS.md (or the harness's own file): an agentic
 *  revision with no instructions is refused every run (runnable.ts), so an import never writes one. */
export const importedInstructions = (project: string, source: Source): string =>
  `You work on the project ${project}. Your past runs are its ${SOURCE_NAMES[source]} sessions, imported. Read the project's files before you change them, and say what you changed.`;

/** The revision of `source`'s harness this agent keeps already (one per source, by its note), or a new one to write: its
 *  id, and the `NewRevision` the caller stores (through agents.create for the agent's first, agents.addRevision for the
 *  rest). The body is built and checked here (bodyOf), its instructions and skills cut. `model`: the harness's latest
 *  session's, kept only when a model catalog here lists it. A coding app's own model (Codex's gpt-6.1-codex) is listed by
 *  none and runs here on no key: pinned, every run of the agent is refused. Left out, the agent runs on this server's
 *  default for its harness, and each imported run still names the model it ran on. `project`: its name as kept (keptName). */
async function revisionFor(
  store: ImportStore,
  agentId: string,
  source: Source,
  files: {
    instructions: Record<string, string>;
    skills: Record<string, string>;
  },
  model: string | undefined,
  project: string,
  cut: Cut,
): Promise<{ id: string; create?: NewRevision }> {
  const note = `imported from ${source}`;
  const held = (await store.agents.revisions(agentId)).find((r) => r.note === note);
  if (held) return { id: held.id };
  const harness = HARNESS_OF[source];
  const own = INSTRUCTIONS[harness]!.map((name) => files.instructions[name]).find((text) => text !== undefined);
  const instructions = own?.trim() ? cut(own) : importedInstructions(project, source);
  const { body, skills } = bodyOf({
    kind: "agentic",
    instructions,
    skills: keptSkills(files.skills, cut),
    tools: [],
    ...(model ? { model } : {}),
    ...(harness !== "pi" ? { harness } : {}),
  });
  const id = randomUUID();
  return { id, create: { id, kind: "agentic", body, skills, note } };
}

/** An imported run's title, whole: the source's own (Claude Code's), else the person's first words, else where the
 *  session ran ("Session in billing-api"), never a CLI's command markup. A folder a key touches (as `keptName` judges it,
 *  a key across the folder and its parent among them) is not named at all: the cut of the title matches only a whole key,
 *  so the piece of one the folder holds would be left in it. */
function runTitleOf(session: Pick<Session, "sourceTitle" | "titleText" | "cwd" | "source">, cut: Cut): string {
  const generic = `${session.source} session`;
  if (session.sourceTitle !== undefined) return session.sourceTitle;
  if (session.titleText !== undefined) return session.titleText;
  const cwd = session.cwd ?? "";
  const parts = cwd.split("/");
  const last = parts.findLastIndex((segment) => segment !== "");
  if (last < 0) return generic;
  return touchedSegments(cwd, cut).includes(last) ? generic : `Session in ${parts[last]}`;
}

/** The secrets this server made and keeps, by value: its API token and its sign-in sessions' secret (still files beside the
 *  store), and its webhook's signing secret (`whsec_...`; webhooks.ts) and every value a trigger source keeps sealed, as
 *  store rows (server-secrets-store.ts), opened with the seal key of `env`, which the caller has (a dry run over a store
 *  that keeps no secret has none, and does not ask); each signing secret's key in every spelling too. One pasted into a
 *  session is this server's own, so an import cuts it wherever it is, as it cuts the environment's keys. Not among them: a key-shaped value this server did not make (a
 *  `whsec_` from elsewhere). The per-run door token is gone (the runner cutover deleted it). A sealed value that does not
 *  open is said to `say` (the webhook's secret once, naming the data directory): the import goes on, and does not cut it. */
export async function ownSecrets(store: { triggerSettings: Pick<Store["triggerSettings"], "get" | "put" | "removeScope">; flush(): Promise<void> }, data: string, env: NodeJS.ProcessEnv, say: (fields: Record<string, string>) => void = () => {}): Promise<string[]> {
  if (!sealKeyOf(env[SEAL_KEY_ENV])) throw new Error(`the server's own secrets open only under its seal key (${SEAL_KEY_ENV}), and none was handed`);
  return (await openServerSecretsOverStore(store, data, env, TRIGGER_ADAPTERS, say)).secrets.values();
}

/** The plan, into `store`: the agents it does not hold, and the runs it does not. Each run is written whole in one atomic
 *  `importRun` (its row, its launch and its transcript's journal), so a stop between two runs leaves no partial run. */
export async function runImport(store: ImportStore, plan: Plan, options: ImportOptions): Promise<ImportReport> {
  const cut = secretCut([options.env, options.stored ?? {}], SECRET_NAMES);
  const { text, json } = cut;
  // Each key found is the import's to cut, and the CLI's to cut out of what it prints.
  const add = (keys: readonly string[]) => (cut.add(keys), options.onKeys?.(keys));
  // This server's own secrets, then every key the import finds.
  add(options.own ?? []);
  const report: ImportReport = { agents: [], skipped: [...plan.skipped], already: plan.already, ...(plan.stopped ? { stopped: true } : {}) };
  let prices: Promise<Map<string, Listed[]>> | undefined;
  const catalog = () => (prices ??= catalogPrices());
  const held = await importedIn(store);
  // Whether a model catalog here lists a session's model ("provider/model id"), keys aside: one none lists is no model to pin.
  let models: ReturnType<typeof providerModels> | undefined;
  const inCatalog = async (ref: string): Promise<boolean> => {
    const at = ref.indexOf("/");
    return at > 0 && (await (models ??= providerModels(options.env))).getModel(ref.slice(0, at), ref.slice(at + 1)) !== undefined;
  };
  // Every key of the import is known before anything of it is written.
  const known = await findKeys(plan, add, text, (listed) => held.get(`${listed.source}:${listed.id}`) !== undefined, options.signal, options.onProgress);
  const toTake = options.onProgress ? plan.projects.reduce((n, p) => n + byRun(p.sessions).length, 0) : 0;
  let written = 0;
  if (!options.signal?.aborted) options.onProgress?.("write", 0, toTake);
  const scannedAs = known.stamps;
  const epoch0 = new Date(0).toISOString();
  for (const project of plan.projects) {
    if (options.signal?.aborted) {
      report.stopped = true;
      break;
    }
    const existing = await store.agents.get(project.agentId);
    const created = !existing;
    const files = await projectFiles(project.cwd, report.skipped);
    // Its own text read through secretlint again only if it changed since the pass above.
    const textNow = projectText(project.cwd, files);
    if (hash(textNow) !== known.texts.get(project.agentId)) add(await secretsIn(textNow));
    const byStart = [...project.sessions].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const latest = byStart.at(-1)!;
    const name = keptName(project, text);
    // The latest session's harness names the agent's current revision; its model, each harness's latest a catalog lists. The
    // latest source is last in the order, so it is the last revision written — created with the agent, or added current.
    const order = [...new Set(project.sessions.map((s) => s.source))].sort((a, b) => (a === latest.source ? 1 : 0) - (b === latest.source ? 1 : 0));
    const revisions = new Map<Source, string>();
    const toWrite: NewRevision[] = [];
    for (const source of order) {
      const model = byStart.findLast((s) => s.source === source && s.model)?.model;
      const pinned = model && (await inCatalog(model)) ? model : undefined;
      const resolved = await revisionFor(store, project.agentId, source, files, pinned, name, text);
      if (resolved.create && model && !pinned) (report.modelsLeftOut ??= []).push({ cwd: project.cwd, source, model });
      revisions.set(source, resolved.id);
      if (resolved.create) toWrite.push(resolved.create);
    }
    if (created) {
      // The agent and its first revision in one commit, the rest added; the latest is last, so the current one.
      await store.agents.create({ id: project.agentId, name, description: text(project.cwd) }, toWrite[0]!);
      for (const revision of toWrite.slice(1)) await store.agents.addRevision({ agentId: project.agentId, ...revision });
    } else if (toWrite.length) {
      // A held agent gains a revision only for a source it had none of; its current revision is left as it was.
      const currentBefore = existing.currentRevision;
      for (const revision of toWrite) await store.agents.addRevision({ agentId: project.agentId, ...revision });
      if (currentBefore) await store.agents.setCurrent(project.agentId, currentBefore);
    }
    const line = { id: project.agentId, name: project.name, cwd: project.cwd, created, runs: 0, already: 0 };
    // A record or response counted once across the import's files, those its runs here hold already included.
    const seen = await seenIn(store, project.agentId);
    for (const files of byRun(project.sessions)) {
      options.onProgress?.("write", written++, toTake);
      if (options.signal?.aborted) {
        report.stopped = true;
        break;
      }
      const listed = files[0]!;
      // A run the store holds already is left as it is: importRun is atomic, so a held run is a whole run.
      if (held.get(`${listed.source}:${listed.id}`) !== undefined) {
        line.already += 1;
        continue;
      }
      // A run over MAX_RUN_BYTES (found so by the scan above, or grown so since) is left out whole, and said.
      if (known.large.has(`${listed.source}:${listed.id}`)) {
        report.skipped.push(tooLarge(listed));
        continue;
      }
      const budget = budgetOf();
      let over = false;
      // Each of its files, in order. The first's size and time before its read: a file that changes during it is read
      // again next time.
      const parts: Session[] = [];
      // Every file of it read: one holding only copies adds no records, but its subagents' folder is read with the rest.
      const searched: Session[] = [];
      let read: SourceFile | undefined;
      // The session's own title as the file written last holds it: a moved copy's /rename too, though its turns are
      // copies the import leaves out.
      let titled: { at: number; title: string } | undefined;
      let changed = false;
      for (const entry of files) {
        const { file } = entry;
        const key = locatorKey(locatorOf(entry));
        const stats = await stat(file).catch(() => null);
        if (stats && !fits(budget, stats.size)) {
          over = true;
          break;
        }
        const part = stats ? await readSession(locatorOf(entry), listed.source, { seen: seen(listed.source) }).catch((error: unknown) => void report.skipped.push(unread(file, error))) : void report.skipped.push({ what: file, why: "gone since it was listed", kind: "vanished" });
        if (!part || !stats) continue;
        searched.push(part);
        if (part.sourceTitle !== undefined && (!titled || stats.mtimeMs >= titled.at)) titled = { at: stats.mtimeMs, title: part.sourceTitle };
        // A file of it holding only copies adds nothing to it.
        if (ownless(part)) {
          report.skipped.push({ what: file, why: "holds only records of sessions imported already", kind: "copies" });
          continue;
        }
        read ??= { path_sha256: hash(key), size: stats.size, mtime_ms: stats.mtimeMs };
        parts.push(part);
        if (scannedAs.get(key) !== stampOf(stats)) changed = true;
      }
      if (over) {
        report.skipped.push(tooLarge(listed));
        continue;
      }
      if (!read) continue;
      const session = merged(parts);
      if (titled) session.sourceTitle = titled.title;
      // A file of it changed since the scan above (a session still being written): what it holds now, read through
      // secretlint again before any of it is cut.
      if (changed) add(await keysInSessions(parts));
      // Its id as the plan keeps it (a key in it is one secretlint finds in what was read, the id among it); one
      // holding a key counts among the keys removed.
      const keptAs = text(session.id) === session.id ? session.id : redactedId(session.id);
      session.id = keptAs;
      const subagents = await readChildren(plan, session, searched, seen(listed.source), budget).catch((error: unknown) => {
        if (!(error instanceof RunTooLarge)) throw error;
        report.skipped.push(tooLarge(listed));
      });
      if (!subagents) continue;
      const moved = await Promise.all(subagents.map(async (child) => scannedAs.get(locatorKey(locatorOf(child))) !== stampOf((await stat(child.file).catch(() => null)) ?? { size: -1, mtimeMs: -1 })));
      if (moved.some(Boolean)) add(await keysInSessions(subagents));
      // The transcript as the store's own write batches, each string cut; its subagents' requests marked after its turns,
      // so its timeline's usage row counts what its metrics do, one number for the run.
      const { batches, entries } = transcriptOf(session, json, subagents);
      const metrics: RunMetrics & { activeMs: number; effort?: string; costUsdEst?: number; costBasis?: string } = { ...withChildren(runMetricsOf(entries), subagents.map((child) => runMetricsOf(entriesOf(child)))), activeMs: session.activeMs, ...(session.effort ? { effort: session.effort } : {}) };
      // A session its source did not price: the catalog's estimate, beside its cost (unknown), never written as it.
      const estimate = session.costUsd === undefined ? await estimateOf([...entries, ...subagents.flatMap(entriesOf)], catalog) : undefined;
      if (estimate !== undefined) Object.assign(metrics, { costUsdEst: estimate, costBasis: "catalog" });
      const answer = session.turns.findLast((t) => t.role === "assistant" && t.text)?.text;
      // Cut, then put on one line and clipped: a key the clip cut short, or a passphrase whose spaces were changed, would
      // match no cut.
      const title = clip(text(runTitleOf(session, text)).replace(/\s+/g, " ").trim(), 120);
      await store.importRun({
        id: randomUUID(),
        agentId: project.agentId,
        revisionId: revisions.get(session.source)!,
        importedFrom: { source: session.source, session: session.id, file: read },
        launch: { body: launchBody({ input: { content: text(session.firstPrompt ?? "") }, title, place: { mode: "runner" } }) },
        // An imported session is ended as it ended: a plain completion reads as 'ended', a stop or a failure as its own.
        state: session.state === "completed" ? "ended" : session.state,
        ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
        ...((answer ?? session.titleText) ? { summary: text(answer ?? session.titleText!) } : {}),
        metrics,
        startedAt: Date.parse(session.startedAt ?? epoch0),
        endedAt: Date.parse(session.endedAt ?? session.startedAt ?? epoch0),
        transcript: batches,
      });
      line.runs += 1;
    }
    report.agents.push(line);
  }
  report.secretsRemoved = text.removed;
  return report;
}

const counted = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
// What each kind of left-out file is, counted: sessions first by how many, a project's files apart.
const LEFT_OUT: Record<LeftOut, (n: number) => string> = {
  gone: (n) => `${counted(n, "session")} from folders that no longer exist`,
  temp: (n) => `${counted(n, "session")} from temp folders`,
  live: (n) => `${counted(n, "session")} still being written: ${n === 1 ? "it comes" : "they come"} in next time`,
  "no-words": (n) => `${counted(n, "session")} with no message of yours`,
  "no-project": (n) => `${counted(n, "file")} that ${n === 1 ? "is not a session" : "are not sessions"} (no project folder in ${n === 1 ? "it" : "them"})`,
  large: (n) => `${counted(n, "session")} over ${MAX_SESSION_BYTES / 1024 / 1024} MB`,
  unread: (n) => `${counted(n, "session file")} that could not be read`,
  vanished: (n) => `${counted(n, "session file")} gone since ${n === 1 ? "it was" : "they were"} counted`,
  copies: (n) => `${counted(n, "file")} holding only copies of sessions imported already`,
  file: (n) => `${counted(n, "project file")} not copied (a link, not text, over its size cap, or a folder with no SKILL.md)`,
};
/** What an import left out, by why: one group per kind, the most first (a project's files last), each counted in words
 *  ("84 sessions from folders that no longer exist"): a session by its id where the file was read, so one of two files
 *  counts once, else each file. */
export function leftOutOf(skipped: readonly Pick<Skipped, "kind" | "what" | "session">[]): { kind: LeftOut; count: number; label: string }[] {
  const seen = new Map<LeftOut, Set<string>>();
  for (const { kind, what, session } of skipped) seen.set(kind, (seen.get(kind) ?? new Set()).add(session ?? `file:${what}`));
  const by = new Map([...seen].map(([kind, ids]) => [kind, ids.size] as const));
  const order = Object.keys(LEFT_OUT) as LeftOut[];
  return [...by]
    .sort(([a, x], [b, y]) => Number(a === "file") - Number(b === "file") || y - x || order.indexOf(a) - order.indexOf(b))
    .map(([kind, count]) => ({ kind, count, label: LEFT_OUT[kind](count) }));
}
// How the CLI brings a kind in, when one of its flags does.
const BRING_IN: Partial<Record<LeftOut, string>> = { gone: "--include-deleted", temp: "--all", "no-words": "--all" };
/** The CLI's left-out lines: each group (leftOutOf), with the flag that imports it too. */
const leftOutLines = (skipped: readonly Skipped[]): string[] => leftOutOf(skipped).map(({ kind, count, label }) => `left out: ${label}${BRING_IN[kind] ? ` (${BRING_IN[kind]} imports ${count === 1 ? "it" : "them"} too)` : ""}`);

/** The plan as a person reads it: one line per project, its sessions counted as the import takes them, then (`verbose`)
 *  each file left out and why. */
export async function describePlan(plan: Plan, store?: ImportStore, { verbose = false }: { verbose?: boolean } = {}): Promise<string[]> {
  const held = store ? await importedIn(store) : undefined;
  const lines = plan.projects.map((project) => {
    const sessions = sessionsOf(project.sessions);
    const by = new Map<string, number>();
    for (const s of sessions) by.set(s.source, (by.get(s.source) ?? 0) + 1);
    const already = held ? sessions.filter((s) => held.has(s.key)).length : 0;
    const priced = sessions.filter((s) => s.priced).length;
    return `${project.cwd}  ${[...by].map(([source, n]) => `${source} ${n}`).join(", ")}  cost known ${priced}/${sessions.length}${already ? `  already imported ${already}` : ""}`;
  });
  return [...lines, ...(plan.already ? [`already imported, unchanged: ${plan.already} session files`] : []), ...(verbose ? plan.skipped.map((s) => `skipped ${s.what}: ${s.why}`) : [])];
}

/** What `importCommand` takes besides its arguments. */
type ImportDeps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  temp?: string;
  /** Where the import says how far it is while it works (default: one line on stderr, on a terminal only). */
  progress?: Progress;
};

/** `agentrun-serve import ARGS`: its exit code. The first Ctrl+C (or SIGTERM) once it writes stops it between two
 *  sessions: each is written whole (importRun is atomic), what is written stays, and the next import picks up the rest.
 *  Its listeners stay until everything it says is printed, since its lines are held until the end; a Ctrl+C it took is
 *  in the code (130) whenever it came. */
export async function importCommand(args: string[], usage: string, deps: ImportDeps = {}): Promise<number> {
  const progress = deps.progress ?? terminalProgress();
  const stops = stopOnce(() => {
    progress.done();
    console.error("agentrun-serve import: stopping; a session being saved is finished first, what is saved stays, and the summary follows (Ctrl+C again to quit now)");
  });
  try {
    const code = await importWith(args, usage, { ...deps, progress }, stops);
    return code === 0 && stops.signal.aborted ? 130 : code;
  } finally {
    stops.unhook();
  }
}

async function importWith(
  args: string[],
  usage: string,
  {
    home = homedir(),
    // The folder whose projects are left out as temporary (the OS's temp directory).
    temp = tmpdir(),
    env,
    out = console.log,
    progress,
  }: ImportDeps & { progress: Progress },
  stops: ReturnType<typeof stopOnce>,
): Promise<number> {
  // The server's own secrets, kept sealed in the store, open only under the server's seal key: it is
  // booted the one way the server and runner boot it (seal-key.ts bootSealKey) once the store is open (keyed below), and
  // checked against it. The key handed over wins (this process's, else a caller's own environment's: a test's), else the
  // one in the data directory, as the server reads it.
  const handedKey = handedSecret(SEAL_KEY_ENV) ?? env?.[SEAL_KEY_ENV];
  const ownEnv = env === undefined;
  // The server's own keys, which its start moved out of process.env (secrets.ts), read back in: the import cuts them out of
  // what it keeps, as it cuts every other key in the environment.
  env ??= withSecrets(process.env);
  // What it prints goes through the cut what it keeps does, with the keys secretlint finds in the lines themselves: a
  // file or project named after a key is printed cut. The lines are held until the end, then scanned and printed.
  const printed = secretCut(env, SECRET_NAMES);
  const print = out;
  const lines: string[] = [];
  out = (line: string) => void lines.push(line);
  // What it says on stderr (a key or a secret that does not open here, its file named) is held and cut the same way, and
  // printed first.
  const warnings: string[] = [];
  const say = (event: string) => (fields: Record<string, string>) => void warnings.push(`agentrun-serve import: ${logLine(event, fields)}`);
  const flush = async () => {
    printed.add(await secretsIn([...warnings, ...lines].join("\n")));
    for (const line of warnings.splice(0)) console.error(printed.text(line));
    for (const line of lines.splice(0)) print(printed.text(line));
  };
  let dir: string | undefined;
  /** The store's seal key, booted against `store` (seal-key.ts), and the environment the import reads given it, so the
   *  store's sealed reads open under it. A dry run (`write` false) makes, moves and records nothing, and a store that holds
   *  no secret and has no key is read with none. The key is cut from what is printed, as every key is. */
  let releaseKey = (): void => undefined;
  const keyed = async (store: Store, write: boolean): Promise<void> => {
    const seal = await bootSealKey(store, dir!, { given: handedKey, role: "import", write, say: (line) => void warnings.push(line.trimEnd()) });
    if (!seal) return;
    releaseKey = seal.release;
    printed.add([seal.text]);
    // The environment the import reads, this process's own or a caller's, with the key the boot checked as its seal key.
    env = withSealKey(ownEnv ? withSecrets(process.env) : env!, seal.text);
  };
  /** A start the seal key refuses (seal-key.ts): said, in its words, and the import does not go on. */
  const sealRefused = (error: unknown): boolean => {
    if (!(error instanceof SealKeyRefused)) return false;
    warnings.push(`agentrun-serve import: ${error.message}`);
    return true;
  };
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: {
          data: { type: "string" },
          from: { type: "string" },
          "dry-run": { type: "boolean" },
          all: { type: "boolean" },
          "include-deleted": { type: "boolean" },
          verbose: { type: "boolean" },
          port: { type: "string" },
        },
      }));
    } catch (error) {
      console.error(`${(error as Error).message}\n\n${usage}`);
      return 2;
    }
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
      console.error(`--port takes a port number\n\n${usage}`);
      return 2;
    }
    const open = openAt(env, port);
    const sources = values.from === undefined ? SOURCES : values.from.split(",").map((s) => s.trim());
    const unknown = sources.filter((s) => !(SOURCES as readonly string[]).includes(s));
    if (unknown.length) {
      console.error(`--from takes ${SOURCES.join(", ")}: not ${unknown.join(", ")}\n\n${usage}`);
      return 2;
    }
    dir = values.data ?? defaultData({ ...env, HOME: home });
    // The import's options, built from the open store: the tool keys the server keeps as sealed rows (tool-keys-store.ts),
    // opened here with the seal key this process was handed, and this server's own secrets (server-secrets-store.ts). One
    // that does not open is not known here, so not cut: said, as the server says it at its start. A dry run on a data
    // directory with no store yet reads neither (none is there).
    const optionsFrom = async (store: Store | undefined): Promise<ImportOptions> => {
      // The environment as it is now: once the store's key is booted (keyed), it carries it.
      const keyEnv = env!;
      // With no key (a dry run over a store that keeps no secret: seal-key.ts) there is nothing of the server's to open.
      const keyed = store !== undefined && keyEnv[SEAL_KEY_ENV] !== undefined;
      const keys = keyed ? toolKeysOverStore(store, keyEnv, say("tool_keys")) : undefined;
      if (keys) {
        await keys.load();
        keys.view();
      }
      const options: ImportOptions = {
        home,
        sources: sources as Source[],
        all: values.all === true,
        deleted: values["include-deleted"] === true,
        temp,
        env: keyEnv,
        stored: keys ? keys.values() : {},
        own: keyed ? await ownSecrets(store, dir!, keyEnv, say("sealed_settings")) : [],
      };
      // What it prints is cut with the saved keys too, and with every key the import (or the dry run) finds, as what it
      // keeps is.
      printed.add(Object.values(options.stored ?? {}));
      options.onKeys = (found) => printed.add(found);
      return options;
    };
    if (values["dry-run"]) {
      // A dry run writes nothing: a store there already is opened read-only (role runner), one that is not is left unmade
      // (on Postgres, when AGENTRUN_STORE_URL names one: a schema not set up yet).
      const reader = storeTarget(dir).kind === "postgres"
        ? await openStore({ dataDir: dir, role: "runner" }).catch((error: unknown) => {
          if (error instanceof SchemaVersionUnknown && error.found === null) return undefined;
          throw error;
        })
        : existsSync(join(dir, STORE_FILE)) ? await openStore({ dataDir: dir, role: "runner" }) : undefined;
      let plan: Plan;
      let found: Found[];
      try {
        if (reader) await keyed(reader, false);
        const options = await optionsFrom(reader);
        plan = await planImport({ ...options, measure: true }, reader);
        for (const line of await describePlan(plan, reader, { verbose: values.verbose === true })) out(line);
        found = [...plan.found!, ...(reader ? await foundAll(reader, plan.held) : []), ...(await untiedFound(plan))];
      } catch (error) {
        if (sealRefused(error)) return 1;
        throw error;
      } finally {
        await reader?.close();
      }
      out(`${plan.projects.length} projects, ${sessionsOf(plan.projects.flatMap((p) => p.sessions)).length} sessions; nothing was written (dry run)`);
      if (plan.secretsFound !== undefined) out(`${plan.secretsFound} secret${plan.secretsFound === 1 ? "" : "s"} would be removed`);
      for (const line of leftOutLines(plan.skipped)) out(line);
      for (const line of summaryLines(found, open)) out(line);
      return 0;
    }
    // A data directory an earlier version wrote (its store a file-era store.sqlite, or its settings files), or one a running
    // server holds: the import refuses it in the store's own words — which name the directory and what was found — writes
    // nothing into it (the refusal is before the store is opened or made), and does not wait on a running server.
    let store: Store;
    try {
      // The store AGENTRUN_STORE_URL names (store/open.ts), else SQLite in the directory; on Postgres a running server's
      // owner lock is the StoreOwned refused here.
      store = await openStore({ dataDir: dir, role: "server" });
    } catch (error) {
      if (error instanceof StoreFromEarlierVersion || error instanceof StoreOwned) {
        warnings.push(`agentrun-serve import: ${error.message}${error instanceof StoreOwned ? `\n${STOP_SERVER_FIRST}` : ""}`);
        return 1;
      }
      throw error;
    }
    try {
      try {
        await keyed(store, true);
      } catch (error) {
        if (sealRefused(error)) return 1;
        throw error;
      }
      stops.hook();
      let plan: Plan;
      let report: ImportReport;
      try {
        const options: ImportOptions = {
          ...(await optionsFrom(store)),
          signal: stops.signal,
          onProgress: (step, done, total) => progress.show(`${step === "keys" ? "Checking sessions for keys" : "Importing sessions"}: ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`),
        };
        progress.show("Looking for sessions…");
        plan = await planImport(options, store);
        report = await runImport(store, plan, options);
      } finally {
        progress.done();
      }
      for (const agent of report.agents) out(`${agent.cwd}  ${agent.created ? "new agent" : "agent held"} ${agent.id}  imported ${agent.runs}${agent.already ? `, already imported ${agent.already}` : ""}`);
      if (report.already) out(`already imported, unchanged: ${report.already} session files (not read again)`);
      if (values.verbose) for (const s of report.skipped) out(`skipped ${s.what}: ${s.why}`);
      const taken = report.agents.reduce((n, a) => n + a.runs, 0);
      out(`${report.agents.length} agents, ${taken} runs imported into ${dir}`);
      out(`${report.secretsRemoved ?? 0} secret${report.secretsRemoved === 1 ? "" : "s"} removed`);
      for (const line of leftOutLines(report.skipped)) out(line);
      for (const { cwd, source, model } of report.modelsLeftOut ?? []) out(`model not kept: ${cwd} (${source}) ran on ${model}, which no model catalog here lists; its agent runs on the server's default model until you pick one`);
      // Every session found: those imported now, those held before, and those whose file an earlier import read whole.
      const held = await importedIn(store);
      const runs = [...plan.projects.flatMap((p) => p.sessions.flatMap((s) => held.get(`${s.source}:${s.id}`) ?? [])), ...plan.held];
      const imported = { sessions: taken, agents: report.agents.filter((a) => a.runs > 0).length, stopped: report.stopped };
      for (const line of summaryLines([...(await foundAll(store, runs)), ...(await untiedFound(plan))], open, imported)) out(line);
      return 0;
    } finally {
      await store.close();
    }
  } finally {
    releaseKey();
    await flush();
  }
}

/** The imported runs `runIds` of `store`, each once, as found. */
async function foundAll(store: Store, runIds: readonly string[]): Promise<Found[]> {
  const found: Found[] = [];
  for (const id of new Set(runIds)) {
    const run = await foundOverStore(store, id, ctx);
    if (run) found.push(run);
  }
  return found;
}

/** The address the summary's Open line names on this machine: the one a local server listens on by default. */
const LOCAL = "127.0.0.1"; // key-gate: loopback-rule the default address a server on this machine listens on; a hint printed, the line dials nothing

/** Where a person opens the console: the server's public address when one is set (as the server takes it), else this
 *  machine's at `port` (`--port`), else at the default port, said as a guess: a server started with no port takes the
 *  first free one from it, and the import, which runs with the server stopped, cannot know which. A hint after an
 *  import, not a server setting. */
function openAt(env: NodeJS.ProcessEnv, port: number | undefined): OpenAt {
  const given = env.AGENTRUN_PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  const parsed = given && URL.canParse(given) ? new URL(given) : undefined;
  if (parsed && /^https?:$/.test(parsed.protocol)) return { url: parsed.href.replace(/\/+$/, ""), known: true };
  // Port 0: any free port, which only the server's start knows.
  if (port === 0) return { known: false };
  return { url: `http://${LOCAL}:${port ?? DEFAULT_PORT}`, known: port !== undefined };
}

/** What a refused import says when the server holds the store: it runs with the server stopped. */
const STOP_SERVER_FIRST = "Stop the server first (Ctrl+C where it runs, or `npx @parcha/agentrun service stop` when it runs as a service), run the import, then start the server again.";

/** Where the CLI says how far an import is: `show` a line in place of the last, `done` clears it. */
export type Progress = { show: (text: string) => void; done: () => void };

/** Progress on stderr when it is a terminal: one line rewritten in place, at most every 100 ms, cleared at the end; off a
 *  terminal (a log, a pipe), nothing. It holds counts alone, never a name or a path, so nothing in it is a secret. */
function terminalProgress(): Progress {
  const stream = process.stderr;
  if (!stream.isTTY) return { show: () => undefined, done: () => undefined };
  let shownAt = 0;
  let shown = false;
  return {
    show: (text) => {
      const now = Date.now();
      if (shown && now - shownAt < 100) return;
      shownAt = now;
      shown = true;
      stream.write(`\r\x1b[2K${text}`);
    },
    done: () => {
      if (shown) stream.write("\r\x1b[2K");
      shown = false;
    },
  };
}

/** A cut as `secretCut` makes it: its `probe` cuts the same and counts nothing. */
type Cut = ((text: string) => string) & { probe?: (text: string) => string };

/** The "/"-segments of `path` a key touches (by their index): each whose blanking takes a key out of the path. Blanked
 *  with spaces, which end every shape and are in no environment's key; the blanked paths are never kept, so they go
 *  through the cut's probe, which counts nothing (a shorter value a blank leaves is no key removed). */
function touchedSegments(path: string, cut: Cut): number[] {
  const out = cut(path);
  if (out === path) return [];
  const probe = cut.probe ?? cut;
  const keys = (text: string) => probe(text).split(REDACTED).length;
  const held = out.split(REDACTED).length;
  const parts = path.split("/");
  return parts.flatMap((segment, at) => (keys([...parts.slice(0, at), " ".repeat(segment.length), ...parts.slice(at + 1)].join("/")) < held ? [at] : []));
}

/** A project's skills as an import keeps them: each file's text cut, and its path as it is when it holds no key. Else
 *  every segment a key touches (one, or several when an environment's value holds "/") is kept as `redacted-` and a hash
 *  of it (as `keptId` keeps a session's id), so two folders named after two keys stay two and no part of a key is left.
 *  A folder kept so is kept so for every file under it, so a skill's files stay one skill. */
function keptSkills(skills: Record<string, string>, cut: Cut): Record<string, string> {
  const redacted = (segment: string) => `redacted-${hash(segment).slice(0, 12)}`;
  // The folders (and files) a key touches, by their path from the skills' root.
  const touched = new Set<string>();
  for (const path of Object.keys(skills)) {
    const parts = path.split("/");
    for (const at of touchedSegments(path, cut)) touched.add(parts.slice(0, at + 1).join("/"));
  }
  return Object.fromEntries(
    Object.entries(skills).map(([path, text]) => {
      const parts = path.split("/");
      const kept = parts.map((segment, at) => (touched.has(parts.slice(0, at + 1).join("/")) ? redacted(segment) : segment)).join("/");
      return [cut(kept) === kept ? kept : redacted(path), cut(text)];
    }),
  );
}

/** A project's name as an import keeps it (its folder's name): cut, or kept as `redacted-` and a hash of it when a key
 *  touches it, one across the project's path ending in it among them, so no part of the key is left in the name. */
function keptName(project: { cwd: string; name: string }, cut: Cut): string {
  const parts = project.cwd.split("/");
  const last = parts.length - 1;
  return parts[last] === project.name && touchedSegments(project.cwd, cut).includes(last) ? `redacted-${hash(project.name).slice(0, 12)}` : cut(project.name);
}
