// Which code-mode script a host tool's nested call belongs to. Written for AgentRun.
//
// A host tool a code-mode model's script calls arrives on the app-server's stream as a call under an id of Codex's own
// (`exec-<uuid>`) that carries no parent, no cell and no `exec` id, and the rollout holds no line for it until after it is
// answered. So the call is tied to the one script that can be running, and that is read from two places that cannot be
// ahead of Codex:
//  - the rollout: an `exec` call line opens a script, and it stays open until an output says it finished: its own, or, when
//    that says "Script running with cell ID N" (it yielded and went on), the output of the `wait` that finishes cell N;
//  - the model proxy: the `exec` the latest answer carried, which it read before Codex had that part of the answer, so
//    before the `exec`'s line could be in the rollout.
// The proxy offers no `exec` while a cell runs and no parallel calls, so one script is live at a time. A model that writes an
// `exec` anyway makes two live, and then a nested call cannot be told from the other's.
import { parseLine } from "./rollout.js";

/** The id Codex gives a host tool called from a code-mode script. */
export const NESTED_CALL = /^exec-[0-9a-f-]{36}$/;

/** What to do with a nested call: run it under `exec`; hold it until `exec`'s line is in the rollout; refuse it, as two scripts
 *  are live; or hold it, as no script is known yet. */
export type Tie = { kind: "tied"; exec: string } | { kind: "held"; exec: string } | { kind: "ambiguous"; live: string[] } | { kind: "none" };

const textOf = (output: unknown): string =>
  typeof output === "string" ? output : Array.isArray(output) ? output.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";

export class Scripts {
  private readonly open: { exec: string; cell?: string }[] = [];
  /** The `exec` calls whose script finished. */
  private readonly done = new Set<string>();
  /** The cell each `wait` call in the rollout resumes. */
  private readonly waitsOn = new Map<string, string>();

  /** Reads one rollout line. */
  note(line: string): void {
    if (!line.includes("call_id")) return;
    const p = parseLine(line)?.payload;
    if (!p || typeof p.call_id !== "string") return;
    const id: string = p.call_id;
    const running = /Script running with cell ID (\S+)/.exec(textOf(p.output));
    if (p.type === "custom_tool_call" && p.name === "exec") {
      if (!this.open.some((x) => x.exec === id)) this.open.push({ exec: id });
    } else if (p.type === "custom_tool_call_output") {
      const at = this.open.findIndex((x) => x.exec === id);
      if (at < 0) return;
      if (running) this.open[at]!.cell = running[1]!;
      else this.done.add(this.open.splice(at, 1)[0]!.exec);
    } else if (p.type === "function_call" && p.name === "wait") {
      try {
        const cell = (JSON.parse(String(p.arguments)) as { cell_id?: unknown }).cell_id;
        if (cell !== undefined) this.waitsOn.set(id, String(cell));
      } catch {}
    } else if (p.type === "function_call_output" && this.waitsOn.has(id) && !running) {
      const at = this.open.findIndex((x) => x.cell === this.waitsOn.get(id));
      if (at >= 0) this.done.add(this.open.splice(at, 1)[0]!.exec);
    }
  }

  /** The scripts that may call a host tool now: the rollout's unfinished ones, and the `exec` the proxy's latest answer carried
   *  if it is not among them and has not finished (its line may not be in the rollout yet). */
  live(announced?: string): string[] {
    const live = this.open.map((x) => x.exec);
    if (announced && !this.done.has(announced) && !live.includes(announced)) live.push(announced);
    return live;
  }

  /** What to do with a nested call now, given the exec the proxy announced and whether a call id is in the rollout. */
  tie(announced: string | undefined, logged: (callId: string) => boolean): Tie {
    const live = this.live(announced);
    if (live.length > 1) return { kind: "ambiguous", live };
    if (live.length === 0) return { kind: "none" };
    return logged(live[0]!) ? { kind: "tied", exec: live[0]! } : { kind: "held", exec: live[0]! };
  }
}
