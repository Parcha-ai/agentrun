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
// The shell's environment is fixed (hands.ts shellEnv): never a variable of this server's. TMPDIR is .agentrun/tmp in
// the run's folder, and bash's full output goes to .agentrun/output/<id> there; the run's end sweeps both.
//
// The computer's check: `check` is the mount check attach takes (attach.ts MountCheck), which the caller builds with
// the claim's epoch bound in, so a read-back under another epoch is refused.
//
// The computer's kind (the agent's computer setting) says what else the run gets. The run's folder is attached to the
// computer only when the kind has files and exec AND its provider mounts the folder: a sandbox always, a desktop when
// its provider mounts (the caller gives the mount check only then). Otherwise the folder stays the no-computer Workspace
// with no computer's shell (above), and the computer adds only its kind's tools: a desktop's screen and input, a phone's
// screen, touch and apps (computer-ports.ts, over its computerd calls, as its groups offer them), a browser's tools over
// its CDP connect (pi-browser's definitions, BROWSER_TOOLS, and the runs the caller gives).
//
// runTools is the one call: runHands binds the run's hands and executors, the kernel's createRegistry makes the run's
// registry over them, and bindTools gives its tools as the kernel's HostTool, through the run's gate. The run's end
// (end) ends its background processes through the computer (the kernel's endBackground), then sweeps.
import type { Context } from "@earendil-works/chord";
import type { HostTool } from "@parcha/agentrun-kernel";
import { type CapabilityKind, capabilityToolDefs, type CdpSession, createRegistry, endBackground, type Executor, type Registry } from "@parcha/agentrun-kernel/kernel";
import type { ComputerClient, Group } from "@parcha/agentrun-computer";
import type { Park, RunGate } from "../tool-gate.js";
import type { AttachableComputer, MountCheck } from "./attach.js";
import { inputOf, phoneOf, screenOf } from "./computer-ports.js";
import { answerText, type PiAnswer, piExecutor, type PiExecutor } from "./executors.js";
import { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, shellEnv } from "./hands.js";
import { COMPUTER_ROOT, realOf, workspaceRelative } from "./paths.js";
import { bashTool, fileTools, OUTPUT_DIR, piEnv, readAnywhereInComputer } from "./pi-env.js";
import { type ShellPlace, shellPlaceOf } from "./resolve-computer.js";
import type { Workspace } from "./workspace.js";

/**
 * The run's computer, as runTools takes it, by its kind:
 * - sandbox: the run's folder is mounted in it, always; `check` is the mount check attach runs (the claim's epoch bound
 *   in);
 * - desktop: a screen and input; the folder is attached only when its provider mounts it (`check` given) and it offers
 *   files and exec;
 * - phone: a screen, touch and apps; never attached;
 * - browser: its CDP connect; never attached.
 * `groups`: what the computer offers (its hello's groups), which fill its kind's ports.
 */
export type RunComputer =
  | { readonly kind: "sandbox"; readonly computer: AttachableComputer; readonly check: MountCheck }
  | { readonly kind: "desktop"; readonly computer: AttachableComputer; readonly groups: readonly Group[]; readonly check?: MountCheck }
  | { readonly kind: "phone"; readonly computer: { readonly client: ComputerClient }; readonly groups: readonly Group[] }
  | { readonly kind: "browser"; readonly connect: () => Promise<CdpSession> };

/** A desktop's or a phone's ports as a person's hold on the computer gives them back: each call made while the person
 *  holds it waits for hand-back; a read then runs, an action then is refused (the take-over's own words). With them, the
 *  agent's ask for the person (`handoff`, computer_request_handoff's port), through the same hold. */
export type RunHold = (ports: Pick<Hands, "screen" | "input" | "phone">) => Pick<Hands, "screen" | "input" | "phone" | "handoff">;

/** The computer the run's folder is attached to, with its check: a sandbox, or a desktop with files and exec whose
 *  provider mounts the folder; none for any other. */
function mountedIn(computer: RunComputer | undefined): { readonly computer: AttachableComputer; readonly check: MountCheck } | undefined {
  if (computer?.kind === "sandbox") return computer;
  if (computer?.kind === "desktop" && computer.check && computer.groups.includes("files") && computer.groups.includes("exec")) return { computer: computer.computer, check: computer.check };
  return undefined;
}

/** The kind's ports, as the computer's groups offer them, the kinds whose tools the run gets (a desktop's with a screen
 *  and input, a phone's with a screen and touch, a browser's always), and the kind's tools its groups do not offer: a
 *  phone's tree without apps.ui_tree, its keys without input.keys (an iPhone's today). */
function portsOf(computer: RunComputer | undefined): { readonly ports: Pick<Hands, "screen" | "input" | "phone" | "browser">; readonly kinds: readonly CapabilityKind[]; readonly without: readonly string[] } {
  if (computer?.kind === "desktop") {
    const { client } = computer.computer;
    const screen = computer.groups.includes("screen");
    const input = computer.groups.includes("input.pointer") || computer.groups.includes("input.keys");
    return screen && input ? { ports: { screen: screenOf(client), input: inputOf(client) }, kinds: ["desktop"], without: [] } : { ports: {}, kinds: [], without: [] };
  }
  if (computer?.kind === "phone") {
    if (!computer.groups.includes("screen") || !computer.groups.includes("input.touch")) return { ports: {}, kinds: [], without: [] };
    const tree = computer.groups.includes("apps.ui_tree");
    const keys = computer.groups.includes("input.keys");
    return { ports: { phone: phoneOf(computer.computer.client, { tree, keys }) }, kinds: ["phone"], without: [...(tree ? [] : ["phone_tree"]), ...(keys ? [] : ["phone_key"])] };
  }
  if (computer?.kind === "browser") return { ports: { browser: { connect: computer.connect } }, kinds: ["browser"], without: [] };
  return { ports: {}, kinds: [], without: [] };
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
  /** The kinds' tools the computer does not offer (its groups lack them), not listed to the model. */
  readonly without: readonly string[];
  readonly maxExecS: number;
  /** The name the model knows the run's folder by: /workspace in a computer, the folder's own path otherwise. */
  readonly cwd: string;
  /** Every absolute name of the run's folder a text may hold: cwd, its path here, the aliases given. */
  readonly names: readonly string[];
  /** The registry's host executors: pi's read, write and edit, and pi's bash as bash's own run where the run has a shell
   *  (none where it is "none", so nothing can run a command on this server). */
  readonly executors: { readonly read: PiExecutor; readonly write: PiExecutor; readonly edit: PiExecutor; readonly bash?: PiExecutor };
  /** The run's end, after its background processes are ended and before the computer is let go: bash's full outputs
   *  and its TMPDIR swept. */
  sweep(): Promise<void>;
};

/** The run's hands and host executors on `workspace`, attached to `computer` when its kind and provider mount the folder,
 *  with its kind's ports. `aliases`: other absolute names of the run's folder a tool call may give (the harness's
 *  scratch folder), taken as the folder. `hold`: a person's hold on the computer (its take-over), given a desktop's or a
 *  phone's ports and answering them wrapped, so a call made while the person holds it waits, and an action then is
 *  refused; never the shell's, the files' or a browser's (its take-over is pi-browser's own). */
export async function runHands(workspace: Workspace, computer: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[]; readonly hold?: RunHold }): Promise<RunHands> {
  // The folder's own path on this machine, Mode 1's bind. A Mode 2 folder (Archil) has none, and asking its mount would
  // mint the run's mount credential: only a computer that mounts the folder asks it (attach, below).
  const spec = options.mode === 1 ? await workspace.mountSpec() : undefined;
  const here = spec?.kind === "bind" ? spec.path : undefined;
  const mounted = mountedIn(computer);
  const shell = shellPlaceOf(mounted !== undefined, options.mode);
  const attached = mounted === undefined ? workspace : await workspace.attach(mounted.computer, mounted.check);
  // The folder's name: /workspace in a computer (and on Archil's exec, which has no path of this machine), its own path here.
  const cwd = mounted === undefined && here !== undefined ? here : COMPUTER_ROOT;
  const names = [cwd, ...(here !== undefined && here !== cwd ? [here] : []), ...(options.aliases ?? [])];
  const maxExecS = mounted === undefined && options.mode === 2 ? ARCHIL_MAX_EXEC_S : MAX_EXEC_S;
  await attached.mkdir(TMP_DIR);
  const env = shellEnv({ tmpdir: `${cwd}/${TMP_DIR}`, ...(mounted === undefined ? { home: cwd } : {}) });
  const fileEnv = piEnv(attached, { cwd, aliases: names.slice(1), env, defaultTimeoutS: maxExecS });
  const tools = Object.fromEntries([...fileTools(), bashTool()].map((tool) => [tool.name, tool]));
  const read = mounted === undefined ? tools.read! : readAnywhereInComputer(tools.read!, attached, names, env);
  const executor = (tool: typeof read) => piExecutor(tool, fileEnv, options.context);
  const own = portsOf(computer);
  const held = options.hold !== undefined && (computer?.kind === "desktop" || computer?.kind === "phone") && own.kinds.length > 0;
  const { ports, kinds, without } = held ? { ...own, ports: options.hold!(own.ports) } : own;
  return {
    workspace: attached,
    // The computer's processes, for the five background tools: the attached Workspace's own; none when the folder is not
    // attached. The kind's ports beside them.
    hands: { ...handsOf(attached, { maxExecS, env, ...(mounted === undefined ? {} : { processes: attached.process }) }), ...ports },
    shell,
    kinds,
    without,
    maxExecS,
    cwd,
    names,
    executors: { read: executor(read), write: executor(tools.write!), edit: executor(tools.edit!), ...(shell === "none" ? {} : { bash: executor(tools.bash!) }) },
    async sweep() {
      // Through the run's own Workspace, not the computer's: the sweep holds whether or not the computer still answers.
      for (const dir of [OUTPUT_DIR, TMP_DIR]) await workspace.remove(dir, { recursive: true, force: true });
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
 * session takes. A call passes the run's gate first (`gated`: the gate and the park it takes; none for the gate's own
 * run of an approved call): a refused one runs nothing, a parked one says it waits. Then the registry runs it on the
 * run's hands, and its answer is the text a model reads (executors.ts answerText): the output, the failure's words, the
 * diagnostics; in a failure, a write's or an edit's answer a path in the run's folder is named relative to it. A
 * failure the registry throws is the answer's text. `results` keeps each answer by its call id.
 */
export function bindTools(run: RunHands, registry: RunRegistry, names: readonly string[], options: { readonly gated?: { readonly gate: RunGate; readonly park: Park }; readonly results?: ToolResults } = {}): HostTool[] {
  const defs = new Map(registry.list().map((def) => [def.name, def] as const));
  const works = [...new Set(run.names.flatMap((name) => [name, realOf(name)]))];
  return names.flatMap((name): HostTool[] => {
    const def = defs.get(name);
    if (!def) return [];
    return [{
      name: def.name,
      description: def.description,
      inputSchema: def.parameters as Record<string, unknown>,
      replay: def.replaySafe ? "safe" : "never",
      async call(args, { callId, signal, attempt, model, output }) {
        // A replay (the kernel's attempt above 0) may follow an attempt that was sent: the gate's refusal then says so.
        const refused = await options.gated?.gate.enter(name, args, callId, options.gated.park, (attempt ?? 0) > 0 ? { replayed: true } : {});
        if (refused) {
          const answer = { text: refused.text, isError: refused.isError === true };
          options.results?.set(callId, answer);
          return refused.parked ? { ...answer, parked: true as const } : answer;
        }
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
        return given.images?.length ? { ...answer, images: given.images } : answer;
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
  /** The tools the claimed computer brings by its kind, as its groups offer them: a desktop's (desktop_screen,
   *  desktop_input, computer_request_handoff) or a phone's, by the kernel registry's own list. None with no computer, for
   *  a sandbox, or for a browser (its own binding lists its tools). An agent names its computer, never these tools
   *  (definition.tools refuses them), so a run binds them beside what it was granted (withKindTools). */
  readonly kindTools: readonly string[];
  /** The registry's tools `names` names, as the kernel's HostTool an adapter's session takes, each call through the
   *  run's gate (`gated`; none for the gate's own run of an approved call), each answer kept in `results` (bindTools). */
  hostTools(names: readonly string[], gated?: { readonly gate: RunGate; readonly park: Park }, results?: ToolResults): HostTool[];
  /** The run's end, before the computer is let go: its background processes ended (TERM, then KILL 3 s later; none with
   *  no computer), then bash's full outputs and TMPDIR swept. */
  end(): Promise<void>;
};

/** A browser computer's tools as the run's start gives them: pi-browser's runs by tool name (over hands.browser), and
 *  what the browser offers, which lists browser_downloads, browser_upload and browser_request_handoff (pi-browser's
 *  listedFor). */
export type RunBrowser = {
  readonly executors: Readonly<Record<string, Executor>>;
  readonly offers: { readonly downloads: boolean; readonly upload: boolean; readonly handoff: boolean };
};

/**
 * A run's tools on `workspace`, attached to `computer` when its kind has files and exec and its provider mounts the
 * folder (RunComputer). `computer.check` is the mount check attach runs (attach.ts MountCheck: `{ readBackOf, epoch }`),
 * which the caller builds with the claim's epoch, so a read-back under another epoch is refused. `options.mode`: 1, or 2
 * (the run's folder on Archil); `options.aliases`: other absolute names of the run's folder a tool call may give (the
 * harness's scratch folder); `options.browser`: a browser computer's runs and offers. The tools' definitions, words and
 * limits come only from the kernel's registry, and a browser's from pi-browser's BROWSER_TOOLS; this binds their
 * executors to the run.
 */
export async function runTools(workspace: Workspace, computer: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[]; readonly browser?: RunBrowser; readonly hold?: RunHold }): Promise<RunTools> {
  const run = await runHands(workspace, computer, options);
  // pi-browser's contracts, listed for what this browser offers; with no browser, all of them, so a browser tool called
  // in another run is refused in words that name the setting.
  const { BROWSER_TOOLS, listedFor } = await import("@parcha/pi-browser");
  const offers = options.browser?.offers;
  const browserTools = run.kinds.includes("browser") ? BROWSER_TOOLS.filter((contract) => listedFor(contract, offers ?? { downloads: false, upload: false, handoff: false })) : BROWSER_TOOLS;
  const registry = createRegistry({
    maxExecS: run.maxExecS, shell: run.shell, kinds: run.kinds, browserTools, without: run.without,
    executors: { ...run.executors, ...(options.browser ? { browser: options.browser.executors } : {}) },
  });
  const brought = new Set(run.kinds.filter((kind) => kind !== "browser").flatMap((kind) => capabilityToolDefs(kind).map((def) => def.name)));
  return {
    workspace: run.workspace,
    registry,
    hands: run.hands,
    kindTools: registry.list().map((def) => def.name).filter((name) => brought.has(name)),
    hostTools: (names, gated, results) => bindTools(run, registry, names, { ...(gated ? { gated } : {}), ...(results ? { results } : {}) }),
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
