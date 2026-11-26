// A run's tools on its Workspace: what the runner's harness start (E2) calls once per run, from the run's Workspace and,
// when it has one, its computer. The tools' definitions, words and limits are the kernel registry's alone (run-adapters
// kernel/registry); this binds them to the run: its Workspace (attached to the computer, when there is one), its hands
// (hands.ts) and the executors the registry takes from the host: pi's read, write and edit, and pi's bash as bash's own
// run, all on one file environment over the Workspace (pi-env.ts).
//
// Where the run's shell is (resolve-computer.ts shellPlaceOf, the one rule runShellOf reads off a setting too): in the
// computer ("computer": the folder at /workspace, every host tool); with none, in Mode 2 the folder's own exec, Archil's
// serverless one, a fresh container holding the run's folder alone ("local": bash only, asking first, and the background
// tools refused in words); in Mode 1 nowhere ("none"): the folder is one of this server's own, and a command there would
// run on the server with everything it can read (its data, its keys), so the run gets the file tools alone, confined to
// the folder, and no bash family at all. The longest command is 600 s, or 295 s on Archil's serverless exec; bash's
// words follow it.
//
// The shell's environment is fixed (hands.ts shellEnv): never a variable of this server's. Under a bash policy
// (`bashPolicy`, the revision's tool_settings.bash.policy) it adds the policy's (bash-read-only.ts policyEnv): git's
// config locked down, and a prelude that runs git only where git holds the whole lock-down (policyPrelude). On Archil's
// serverless exec (Mode 2, no computer) each of its commands runs with no network (ExecOptions.network "deny"), or, where
// the owner's Archil plan takes no network policy, with it open and a line saying so (archil.ts). Only the shell's
// commands: the server's own execs on the folder (a checkout's fetch) keep theirs. TMPDIR is .agentrun/tmp in
// the run's folder, and bash's full output goes to .agentrun/output/<id> there; the run's end sweeps both.
//
// The computer's check: `check` is the mount check attach takes (attach.ts MountCheck), which the caller builds with
// the claim's epoch bound in, so a read-back under another epoch is refused.
//
// The computer's kind (the agent's computer setting) says what else the run gets. The run's folder is attached to the
// computer only when the kind has files and exec AND its provider mounts the folder: a sandbox always, a desktop when
// its provider mounts (the caller gives the mount check only then). Otherwise the folder stays the no-computer Workspace
// with no computer's shell (above), and a desktop or a phone adds the computer's tools (computer_observe, computer_act,
// computer_screenshot, computer_op, the hand-over) as its groups offer them, over its one surface (computer-ports.ts).
// A script that drives the computer is the host's codemode, whose `computer` (bound to the card: RunTools.computer)
// calls them as nested calls; computer_op, the ops no step tool runs, is bound for those calls alone. A browser adds
// none here: the run's browser tool (tools.ts) drives it. The agent's setting may narrow a desktop or a phone
// (AgentComputer): its surface lists the step tools or leaves them to scripts alone, and exec off takes every program
// away from the agent: no exec or processes group in its card, no folder mounted, no shell.
//
// runTools is the one call: runHands binds the run's hands and executors, the kernel's createRegistry makes the run's
// registry over them, and bindTools gives its tools as the kernel's HostTool, through the run's gate. The run's end
// (end) ends its background processes through the computer (the kernel's endBackground), then sweeps. The sweep removes
// through the computer when it mounts the folder: on Archil the run's own Workspace is the disk's file API, which Archil
// refuses every delete under the folder (409 OperationAborted) while the computer's mount holds its write delegation, and
// the computer's own calls sync to the disk before they answer. It runs before the run's end commit, never after: a
// follow-up the commit reopens may be claimed at once, and its scratch is the same folder's.
import type { Context } from "@earendil-works/chord/context";
import type { HostTool } from "@parcha/agentrun-kernel";
import { type CapabilityKind, COMPUTER_OP_TOOL, COMPUTER_TOOLS, createRegistry, endBackground, HANDOFF_TOOL, type Registry, unsavedScreenshot, withoutOps } from "@parcha/agentrun-kernel/kernel";
import type { ComputerClient, HelloResult } from "@parcha/agentrun-computer";
import { type Card, createSurface } from "@parcha/agentrun-computer/surface";
import type { AttachableComputer, MountCheck } from "./attach.js";
import { portOf, type ShellPolicy } from "./computer-ports.js";
import { answerText, type PiAnswer, piExecutor, type PiExecutor } from "./executors.js";
import { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, shellEnv } from "./hands.js";
import { policyEnv, policyPrelude } from "../bash-read-only.js";
import { COMPUTER_ROOT, realOf, workspaceRelative } from "./paths.js";
import { bashTool, fileTools, OUTPUT_DIR, piEnv, readAnywhereInComputer } from "./pi-env.js";
import { type ClaimBrowser, noPrograms, type ShellPlace, shellPlaceOf } from "./resolve-computer.js";
import type { Workspace } from "./workspace.js";

/**
 * The run's computer, as runTools takes it, by its kind:
 * - sandbox: the run's folder is mounted in it, always; `check` is the mount check attach runs (the claim's epoch bound
 *   in);
 * - desktop: the computer's tools; the folder is attached only when its provider mounts it (`check` given) and it
 *   offers files and exec;
 * - phone: the computer's tools; never attached;
 * - browser: what the run's browser tool drives it by (its CDP URL through its provider); no tools of the registry's,
 *   never attached.
 * `hello`: what a desktop or a phone said it is when the claim connected it; its groups say which of the computer's
 * tools it has, and its surface is made from it.
 */
export type RunComputer =
  | { readonly kind: "sandbox"; readonly computer: AttachableComputer; readonly check: MountCheck }
  | ({ readonly kind: "desktop"; readonly computer: AttachableComputer; readonly hello: HelloResult; readonly check?: MountCheck } & AgentComputer)
  | ({ readonly kind: "phone"; readonly computer: { readonly client: ComputerClient }; readonly hello: HelloResult } & AgentComputer)
  | { readonly kind: "browser"; readonly browser: ClaimBrowser };

/** What a desktop's or a phone's agent may do with it, as its computer setting says (computer-setting.ts): `surface`,
 *  how it drives it ("code": by scripts, the step tools bound for a script's nested calls alone, never listed, and the
 *  hand-over listed; "tools", or absent: the step tools listed too: scriptsOnly); `exec: false`, no program of its own on it:
 *  its card and surface are made from its hello with
 *  the exec and processes groups taken out, so no tool and no script has a shell, and the run has no bash family
 *  anywhere (shell "none"). Only the agent's: the run's own computer channel (computer-channel.ts loopComputerOf, the
 *  owner's POST /runs/{id}/computer/call) keeps the computer's whole hello. */
export type AgentComputer = { readonly surface?: "code" | "tools"; readonly exec?: false };

/** The groups that run a program on a computer: what `exec: false` takes out of the agent's card. */
const PROGRAM_GROUPS: ReadonlySet<string> = new Set(["exec", "processes"]);

/** `computer` as its agent may use it: with `exec: false`, its hello without the groups that run programs. */
function agentsOwn(computer: RunComputer | undefined): RunComputer | undefined {
  if (!noPrograms(computer)) return computer;
  return { ...computer, hello: { ...computer.hello, groups: computer.hello.groups.filter((group) => !PROGRAM_GROUPS.has(group)) } };
}

/** The run's folder `workspace` attached to the computer `claimed`, as runHands attaches it, when that computer mounts the
 *  folder; undefined when none does. For what the runner itself writes in a Mode 2 run's folder while the computer's mount
 *  holds the disk's write delegation (run-child-host.ts, the claim's MCP). */
export async function attachedIn(workspace: Workspace, claimed: RunComputer | undefined): Promise<Workspace | undefined> {
  const mounted = mountedIn(agentsOwn(claimed));
  return mounted === undefined ? undefined : await workspace.attach(mounted.computer, mounted.check);
}

/** Whether a computer's tool is bound for a script's nested calls alone (deferred: never listed to the model) under
 *  `surface`: computer_op always (a script's `computer` reaches the computer's other ops through it); under "code",
 *  every one but the hand-over, which a script can't wait on. */
function scriptsOnly(name: string, surface: AgentComputer["surface"]): boolean {
  return name === COMPUTER_OP_TOOL || (surface === "code" && name !== HANDOFF_TOOL);
}

/** A desktop's or a phone's port as a person's hold on the computer gives it back: each look or act made while the
 *  person holds it waits for hand-back; a look then runs, an act then is refused (the take-over's own words). With it,
 *  the agent's ask for the person (`handoff`, computer_request_handoff's port), through the same hold. */
export type RunHold = (ports: Pick<Hands, "computer">) => Pick<Hands, "computer" | "handoff">;

/** The computer the run's folder is attached to, with its check: a sandbox, or a desktop with files and exec whose
 *  provider mounts the folder; none for any other. */
function mountedIn(computer: RunComputer | undefined): { readonly computer: AttachableComputer; readonly check: MountCheck } | undefined {
  if (computer?.kind === "sandbox") return computer;
  if (computer?.kind === "desktop" && computer.check && computer.hello.groups.includes("files") && computer.hello.groups.includes("exec")) return { computer: computer.computer, check: computer.check };
  return undefined;
}

/** A desktop's or a phone's computer as a codemode script gets it bound (runner/meta-tools.ts): its card, the agent's
 *  own (no exec or processes group where its exec is off: `exec` false then, which a script's reach for computer.shell
 *  is told), and the ops its declarations leave out, which the run's gate refuses whatever their arguments
 *  (`opsRefused`, set by the run's spec: RunGate.opsRefused). */
export type ScriptComputer = { readonly card: Card; readonly exec?: false; readonly opsRefused?: readonly string[] };

/** A desktop's or a phone's port, over its surface, the kind whose tools the run gets, its groups, and its computer as a
 *  script gets it bound; none for any other computer. Its shell gets the run's bash policy (`shell`). */
async function portsOf(computer: RunComputer | undefined, mounted: boolean, replaced: boolean, shell: ShellPolicy): Promise<{ readonly ports: Pick<Hands, "computer">; readonly kinds: readonly CapabilityKind[]; readonly groups: readonly string[]; readonly script?: ScriptComputer }> {
  if (computer?.kind !== "desktop" && computer?.kind !== "phone") return { ports: {}, kinds: [], groups: [] };
  // A desktop that mounts the run's folder starts its shell's programs there, as bash does, not in the computer's home.
  const surface = createSurface(computer.computer.client, computer.hello, mounted ? { cwd: COMPUTER_ROOT } : {});
  const programs = noPrograms(computer) ? ({ programs: false } as const) : {};
  // One that replaced an earlier claim's: its acts held to what it showed (computer-ports.ts replacedGuard).
  return { ports: { computer: portOf(surface, { replaced, shell, ...programs }) }, kinds: [computer.kind], groups: surface.card.groups, script: { card: surface.card, ...(noPrograms(computer) ? { exec: false as const } : {}) } };
}

/** The run's scratch in its own folder: bash's TMPDIR. */
export const TMP_DIR = ".agentrun/tmp";

/** What runHands binds for a run. */
export type RunHands = {
  /** The run's Workspace: attached to the computer when there is one. */
  readonly workspace: Workspace;
  readonly hands: Hands;
  /** Where the run's shell is: the registry's ShellPlace (shellPlaceOf). "none": no bash family at all. */
  readonly shell: ShellPlace;
  /** The computer's kinds whose tools the run gets, past files and a shell. */
  readonly kinds: readonly CapabilityKind[];
  /** What the computer offers (its groups): which of the computer's tools are listed to the model. */
  readonly groups: readonly string[];
  readonly maxExecS: number;
  /** The name the model knows the run's folder by: /workspace in a computer, the folder's own path otherwise. */
  readonly cwd: string;
  /** Every absolute name of the run's folder a text may hold: cwd, its path here, the aliases given. */
  readonly names: readonly string[];
  /** The registry's host executors: pi's read, write and edit, and pi's bash as bash's own run where the run has a shell
   *  (none where it is "none", so nothing can run a command on this server). */
  readonly executors: { readonly read: PiExecutor; readonly write: PiExecutor; readonly edit: PiExecutor; readonly bash?: PiExecutor };
  /** A desktop's or a phone's surface, as its agent's setting says it (AgentComputer); absent, every tool listed. */
  readonly surface?: AgentComputer["surface"];
  /** A desktop's or a phone's computer as a codemode script gets it bound; none for any other computer. */
  readonly computer?: ScriptComputer;
  /** A desktop or a phone the run's folder is not mounted in: its own disk holds none of the run's files. */
  readonly apart?: "desktop" | "phone";
  /** The run's end, after its background processes are ended and before the computer is let go: bash's full outputs
   *  and its TMPDIR swept, through the computer when it mounts the folder. */
  sweep(): Promise<void>;
};

/** The run's hands and host executors on `workspace`, attached to `computer` when its kind and provider mount the folder,
 *  with its kind's ports. `aliases`: other absolute names of the run's folder a tool call may give (the harness's
 *  scratch folder), taken as the folder. `hold`: a person's hold on the computer (its take-over), given a desktop's or a
 *  phone's ports and answering them wrapped, so a call made while the person holds it waits, and an action then is
 *  refused; never the shell's, the files' or a browser's (its take-over is pi-browser's own). `replaced`: the computer
 *  replaced an earlier claim's (ClaimComputer.replaced), so a desktop's or a phone's act is held to what it showed. */
export async function runHands(workspace: Workspace, claimed: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[]; readonly hold?: RunHold; readonly bashPolicy?: string; readonly replaced?: boolean }): Promise<RunHands> {
  // The folder's own path on this machine, Mode 1's bind. A Mode 2 folder (Archil) has none, and asking its mount would
  // mint the run's mount credential: only a computer that mounts the folder asks it (attach, below).
  const spec = options.mode === 1 ? await workspace.mountSpec() : undefined;
  const here = spec?.kind === "bind" ? spec.path : undefined;
  // The computer as its agent may use it: one with exec off has no group that runs a program, so nothing mounts the
  // folder in it, and the run has no shell at all (no bash family, not even Archil's exec).
  const computer = agentsOwn(claimed);
  const mounted = mountedIn(computer);
  const shell = noPrograms(computer) ? "none" : shellPlaceOf(mounted !== undefined, options.mode);
  const attached = mounted === undefined ? workspace : await workspace.attach(mounted.computer, mounted.check);
  // The folder's name: /workspace in a computer (and on Archil's exec, which has no path of this machine), its own path here.
  const cwd = mounted === undefined && here !== undefined ? here : COMPUTER_ROOT;
  const names = [cwd, ...(here !== undefined && here !== cwd ? [here] : []), ...(options.aliases ?? [])];
  const maxExecS = mounted === undefined && options.mode === 2 ? ARCHIL_MAX_EXEC_S : MAX_EXEC_S;
  await attached.mkdir(TMP_DIR);
  // Under a bash policy (an agent's tool_settings.bash.policy), what the policy adds: git's config locked down.
  const env = { ...shellEnv({ tmpdir: `${cwd}/${TMP_DIR}`, ...(mounted === undefined ? { home: cwd } : {}) }), ...policyEnv(options.bashPolicy) };
  // And a prelude: git run only where it holds the whole lock-down (policyPrelude).
  const prelude = policyPrelude(options.bashPolicy);
  // And on Archil's serverless exec, no network for the shell's commands.
  const network = options.bashPolicy !== undefined && mounted === undefined && options.mode === 2 ? { network: "deny" as const } : {};
  const fileEnv = piEnv(attached, { cwd, aliases: names.slice(1), env, defaultTimeoutS: maxExecS, ...(prelude ? { prelude } : {}), ...network });
  const tools = Object.fromEntries([...fileTools(), bashTool()].map((tool) => [tool.name, tool]));
  const read = mounted === undefined ? tools.read! : readAnywhereInComputer(tools.read!, attached, names, env);
  const executor = (tool: typeof read) => piExecutor(tool, fileEnv, options.context);
  // The computer's own shell (a script's computer.shell and computer.processes) gets the policy's environment and prelude
  // too.
  const own = await portsOf(computer, mounted !== undefined, options.replaced === true, { env: policyEnv(options.bashPolicy), prelude });
  const { ports, kinds, groups, script } = options.hold !== undefined && own.ports.computer ? { ...own, ports: options.hold(own.ports) } : own;
  return {
    workspace: attached,
    // The computer's processes, for the five background tools: the attached Workspace's own; none when the folder is not
    // attached. The kind's ports beside them.
    hands: { ...handsOf(attached, { maxExecS, env, ...(prelude ? { prelude } : {}), ...network, ...(mounted === undefined ? {} : { processes: attached.process }) }), ...ports },
    shell,
    kinds,
    groups,
    maxExecS,
    cwd,
    names,
    executors: { read: executor(read), write: executor(tools.write!), edit: executor(tools.edit!), ...(shell === "none" ? {} : { bash: executor(tools.bash!) }) },
    ...((computer?.kind === "desktop" || computer?.kind === "phone") && computer.surface ? { surface: computer.surface } : {}),
    ...(script ? { computer: script } : {}),
    ...((computer?.kind === "desktop" || computer?.kind === "phone") && mounted === undefined ? { apart: computer.kind } : {}),
    async sweep() {
      // Through the Workspace the run wrote them through: the computer's when it mounts the folder, since on Archil the
      // run's own Workspace is the disk's file API, which the mount's write delegation refuses until the computer's
      // release. A computer that no longer answers leaves a Mode 1 folder to the run's own Workspace (a folder of this
      // machine, which no delegation holds); a Mode 2 one keeps its scratch, said by the release's log.
      for (const dir of [OUTPUT_DIR, TMP_DIR]) {
        try {
          await attached.remove(dir, { recursive: true, force: true });
        } catch (error) {
          if (mounted === undefined || options.mode === 2) throw error;
          await workspace.remove(dir, { recursive: true, force: true });
        }
      }
    },
  };
}

/** A tool as the kernel's registry lists it: what bindTools reads of its ToolDef. */
export type RegistryDef = { readonly name: string; readonly description: string; readonly parameters: object; readonly replaySafe: boolean };
/** The kernel's registry, as bindTools calls it (run-adapters kernel/registry Registry). */
export type RunRegistry = {
  list(): readonly RegistryDef[];
  invoke(name: string, args: unknown, call: { readonly hands: Hands; readonly signal?: AbortSignal; output?(chunk: string): void }): Promise<PiAnswer>;
};
/** One call's answer, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

/** The tools whose answer is pi's own words about a path (`Successfully wrote to <path>`), never a file's text. */
const SAYS_PATH: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * `registry`'s tools that `names` names, in that order, bound to `run`: each as the kernel's HostTool, which an adapter's
 * session takes. The run's gate decided the call before its intent (the adapter loop's). The registry runs it on the
 * run's hands, and its answer is the text a model reads (executors.ts answerText): the output, the failure's words, the
 * diagnostics; in a failure, a write's or an edit's answer a path in the run's folder is named relative to it. A
 * failure the registry throws is the answer's text. `results` keeps each answer by its call id. computer_op, and under
 * the agent's surface "code" a desktop's or a phone's step tools, are deferred: bound for a script's nested calls
 * (codemode's `computer` and `tools.<name>`), never listed to the model (scriptsOnly). Unless `writes` (the run's gate
 * lets it write a file: RunGate.writeBar, read by the spec), computer_screenshot offers no save_as, which the gate would
 * refuse; computer_op offers none of the ops in `opsRefused` (the gate refuses them whatever their arguments:
 * RunGate.opsRefused).
 */
export function bindTools(run: RunHands, registry: RunRegistry, names: readonly string[], options: { readonly results?: ToolResults; readonly writes?: boolean; readonly opsRefused?: readonly string[] } = {}): HostTool[] {
  const defs = new Map(registry.list().map((def) => [def.name, def] as const));
  const works = [...new Set(run.names.flatMap((name) => [name, realOf(name)]))];
  const brought: ReadonlySet<string> = new Set(COMPUTER_TOOLS);
  return names.flatMap((name): HostTool[] => {
    const listed = defs.get(name);
    if (!listed) return [];
    const def = name === "computer_screenshot" && options.writes !== true ? unsavedScreenshot(listed) : name === COMPUTER_OP_TOOL && options.opsRefused?.length ? withoutOps(listed, options.opsRefused) : listed;
    return [{
      name: def.name,
      description: def.description,
      inputSchema: def.parameters as Record<string, unknown>,
      replay: def.replaySafe ? "safe" : "never",
      ...(brought.has(name) && scriptsOnly(name, run.surface) ? { deferred: true as const } : {}),
      async call(args, { callId, signal, model, output }) {
        let given: PiAnswer;
        try {
          // The calling model and the call's output stream, as the session gave them: pi's read sizes an image by the
          // model, and a running tool's output reaches the run's live view.
          given = await registry.invoke(name, args, { hands: run.hands, signal, ...(model !== undefined ? { model } : {}), ...(output ? { output } : {}) });
        } catch (error) {
          given = { text: "", isError: true, error: (error as Error)?.message ?? String(error) };
        }
        const said = answerText(given);
        // A failure is an answer with its words in `error` (the kernel's answerOf sets no isError): an error either way.
        const isError = given.isError === true || given.error !== undefined;
        const answer = { text: isError || SAYS_PATH.has(name) ? workspaceRelative(said, works) : said, isError };
        options.results?.set(callId, answer);
        // A computer tool's value beside its words: what a script's nested call reads (Codex's code mode), and an MCP
        // client's structuredContent.
        return { ...answer, ...(given.images?.length ? { images: given.images } : {}), ...(given.structured !== undefined && !isError ? { structured: given.structured } : {}) };
      },
    }];
  });
}

/** A run's tools: what E2's harness start calls runTools for. */
export type RunTools = {
  /** The run's Workspace: attached to the computer when there is one. */
  readonly workspace: Workspace;
  /** The run's registry: the kernel's definitions, words and limits, over this run's hands and executors. */
  readonly registry: Registry;
  readonly hands: Hands;
  /** Where the run's shell is (runHands' shell): its gate reads its defaults by it (tool-gate.ts defaultPermission). */
  readonly shell: ShellPlace;
  /** The tools the claimed computer brings by its kind, as its groups offer them: a desktop's or a phone's
   *  (computer_observe, computer_act, computer_screenshot, computer_op, computer_request_handoff), by the kernel
   *  registry's own list. None with no computer, for a sandbox, or for a browser (its own binding lists its tools). An
   *  agent names its computer, never these tools (definition.tools refuses them), so a run binds them beside what it was
   *  granted (withKindTools). computer_op, and under its setting's surface "code" the step tools, are bound for scripts
   *  alone (scriptsOnly). */
  readonly kindTools: readonly string[];
  /** A desktop's or a phone's computer as a codemode script gets it bound: the run's spec hands it to the session's
   *  codemode (adapter-loop.ts AdapterRunSpec.computer). None for any other computer. */
  readonly computer?: ScriptComputer;
  /** A desktop or a phone the run's folder is not mounted in, and whether the run has computer_screenshot (whose save_as
   *  saves into the run's files): what the model is told once (computer-deps.ts computerFilesNote). None for any other. */
  readonly apart?: { readonly kind: "desktop" | "phone"; readonly screenshot: boolean };
  /** The registry's tools `names` names, as the kernel's HostTool an adapter's session takes, each call through the
   *  run's gate decided before its intent, each answer kept in `results`; `writes`, the gate lets the run write a file, so
   *  computer_screenshot offers save_as; `opsRefused`, the ops computer_op leaves out (bindTools). */
  hostTools(names: readonly string[], options?: { readonly results?: ToolResults; readonly writes?: boolean; readonly opsRefused?: readonly string[] }): HostTool[];
  /** The run's end, before the computer is let go: its background processes ended (TERM, then KILL 3 s later; none with
   *  no computer), then bash's full outputs and TMPDIR swept. */
  end(): Promise<void>;
  /** Strict checkpoint stop: cleanup errors or any still-running tracked process refuse publication. */
  settleProject(): Promise<readonly string[]>;
};

/**
 * A run's tools on `workspace`, attached to `computer` when its kind has files and exec and its provider mounts the
 * folder (RunComputer). `computer.check` is the mount check attach runs (attach.ts MountCheck: `{ readBackOf, epoch }`),
 * which the caller builds with the claim's epoch, so a read-back under another epoch is refused. `options.mode`: 1, or 2
 * (the run's folder on Archil); `options.aliases`: other absolute names of the run's folder a tool call may give (the
 * harness's scratch folder). The tools' definitions, words and limits come only from the kernel's registry; this binds
 * their executors to the run. A browser computer brings none of the registry's: the run's browser tool (tools.ts,
 * pi-browser's durable extension) drives it.
 */
export async function runTools(workspace: Workspace, computer: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[]; readonly hold?: RunHold; readonly bashPolicy?: string; /** The computer replaced an earlier claim's (runHands). */ readonly replaced?: boolean }): Promise<RunTools> {
  const run = await runHands(workspace, computer, options);
  const registry = createRegistry({ maxExecS: run.maxExecS, shell: run.shell, kinds: run.kinds, groups: run.groups, executors: run.executors });
  const brought: ReadonlySet<string> = new Set(COMPUTER_TOOLS);
  const kindTools = registry.list().map((def) => def.name).filter((name) => brought.has(name));
  return {
    workspace: run.workspace,
    registry,
    hands: run.hands,
    shell: run.shell,
    kindTools,
    ...(run.computer ? { computer: run.computer } : {}),
    ...(run.apart ? { apart: { kind: run.apart, screenshot: kindTools.includes("computer_screenshot") } } : {}),
    hostTools: (names, options) => bindTools(run, registry, names, options),
    async settleProject() {
      const before = await run.hands.processes?.list() ?? [];
      await endBackground(run.hands);
      if ((await run.hands.processes?.list() ?? []).some(process => process.running)) throw new Error("Project processes have not settled.");
      await run.sweep();
      return before.filter(process => process.argv[3] === "agentrun-background" && /^[1-9][0-9]*$/.test(process.argv[4] ?? "")).map(process => `background/${process.argv[4]}/output.log`);
    },
    async end() {
      await endBackground(run.hands);
      await run.sweep();
    },
  };
}

/** The names a run binds as host tools: what it was granted, then the tools its claimed computer brings by its kind
 *  (RunTools.kindTools), each once. Each goes through the run's one gate under its own settings key (a desktop's under
 *  `desktop`, a phone's under `phone`), so a deny or an ask on the kind holds them. */
export function withKindTools(granted: readonly string[], tools: Pick<RunTools, "kindTools">): readonly string[] {
  return [...new Set([...granted, ...tools.kindTools])];
}
