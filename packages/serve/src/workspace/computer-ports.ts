// A desktop's or a phone's one port, as the kernel registry's computer tools reach it (run-adapters kernel/registry
// Hands.computer), over the computer's surface (@parcha/agentrun-computer's createSurface, made in run-tools.ts from the
// hello the claim connected it with): the one core that answers a per-step tool, a script (computer-script.ts) and the
// claim's MCP endpoint (computer-mcp.ts) alike. A phone with no computerd (daemon none) answers the same methods in
// process, so one port fits both. A refusal throws the computer's kind and words.
//
// On a computer that replaced an earlier claim's (computer-for-claim.ts ClaimComputer.replaced), the model's context
// still holds the refs and states the old one gave, and a new computer gives the same names (@e3, s4) to other things.
// So an act there is held to what this computer showed: a ref or a state it never gave is refused in words, and so is
// a step at a point before anything of this computer was looked at (the default state, the last observed, would be the
// old one's). Nothing such reaches the computer.
import { SurfaceError, type Surface } from "@parcha/agentrun-computer/surface";
import type { ComputerPort } from "@parcha/agentrun-kernel/kernel";

/** The port of a computer's surface. `replaced`: the computer replaced an earlier claim's, so an act is held to what
 *  this one showed (replacedGuard). */
export const portOf = (surface: Surface, { replaced = false }: { readonly replaced?: boolean } = {}): ComputerPort => {
  const port: ComputerPort = {
    groups: surface.card.groups,
    call: (op, args, signal) => surface.call(op, args, signal ? { signal } : {}),
  };
  return replaced ? replacedGuard(port) : port;
};

/** What an act on a replaced computer names that it never gave is told. */
export const REPLACED_REF_WORDS = "that ref is from the replaced computer; observe again";
export const REPLACED_STATE_WORDS = "that state is from the replaced computer; observe again";

type Fields = Readonly<Record<string, unknown>>;
const recordOf = (value: unknown): Fields | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined);

/** The keys of a ui step that name an element by its ref (protocol.ts UiStep): press, set, perform, a click's or a
 *  scroll's when not a point, a type's `into`. */
const REF_KEYS = ["press", "set", "perform", "click", "scroll", "into"] as const;

/** Whether a step acts at a point of a look: a click or a scroll at a point, a drag; an input action at a point. */
const atPoint = (step: Fields): boolean => Array.isArray(step.click) || Array.isArray(step.scroll) || Array.isArray(step.drag) || Array.isArray(step.at) || Array.isArray(step.path);

/** `port`, its acts held to the refs and states this computer gave in its answers, and its steps at points to after a
 *  look (an observe, a screenshot, an act that observed). */
export function replacedGuard(port: ComputerPort): ComputerPort {
  const refs = new Set<string>();
  const states = new Set<string>();
  let looked = false;
  /** What a look's state (surface api.ts State) gives: its id and its elements' refs. */
  const learnState = (value: unknown): void => {
    const state = recordOf(value);
    if (!state) return;
    looked = true;
    if (typeof state.id === "string") states.add(state.id);
    for (const element of Array.isArray(state.elements) ? state.elements : []) {
      const ref = recordOf(element)?.ref;
      if (typeof ref === "string") refs.add(ref);
    }
  };
  /** A ref named that no look of this computer gave. */
  const unseen = (ref: unknown): boolean => typeof ref === "string" && !refs.has(ref);
  /** The words an act or an input batch is refused in, or undefined: it names only what this computer gave. */
  const refusalOf = (op: string, args: unknown): string | undefined => {
    const given = recordOf(args) ?? {};
    const steps = (op === "act" ? given.steps : given.actions) as unknown;
    const list = Array.isArray(steps) ? steps.map(recordOf).filter((step): step is Fields => step !== undefined) : [];
    if (op === "act" && typeof given.state === "string" && !states.has(given.state)) return REPLACED_STATE_WORDS;
    for (const step of list) {
      if (REF_KEYS.some((key) => unseen(step[key]))) return REPLACED_REF_WORDS;
      // No state named, nothing looked at: the point is of the old computer's screen.
      if (!looked && given.state === undefined && atPoint(step)) return REPLACED_STATE_WORDS;
    }
    if (op === "act" && unseen(recordOf(given.expect)?.ref)) return REPLACED_REF_WORDS;
    return undefined;
  };
  return {
    groups: port.groups,
    async call(op, args, signal) {
      if (op === "act" || op === "input.act") {
        const refused = refusalOf(op, args);
        if (refused !== undefined) throw new SurfaceError("stale", refused);
      }
      const answer = await port.call(op, args, signal);
      if (op === "observe") learnState(answer.value);
      if (op === "screenshot") looked = true;
      if (op === "act") {
        const done = recordOf(answer.value);
        if (typeof done?.state === "string") states.add(done.state);
        if (done?.after !== undefined) learnState(done.after);
      }
      return answer;
    },
  };
}
