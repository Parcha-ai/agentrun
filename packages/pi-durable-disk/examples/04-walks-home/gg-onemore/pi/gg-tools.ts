// The GG box as the agent's tools, each one a typed route of the box's guard (box/guard.py) behind the tools' key. With the
// golden-gate skill (the chat page), gg_run runs the agent's own Python on the box as the unprivileged `agent` user with no
// network, its one way out the lab's socket (gglab). The scripted take keeps the prepared pipeline instead: a step runs
// that step's fixed command. The agent reads the reading list in its own workspace with its own shell.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";

export type Step = "find" | "pick" | "strength" | "bake";
/** Bytes of each output stream a step or a run keeps: the tail, which is where a program's result is. */
const FRAME_KEEP = 256 * 1024;
export const STEPS: readonly Step[] = ["find", "pick", "strength", "bake"];

/** Where the guard is and its tools' key; read at every call, so a box made after the session opened is reachable. */
export type GuardAccess = { readonly url: string; readonly key: string };

/** served.json: the edit the server holds, a clamp of SAE features (bake's: at one layer, to k times their max). */
export interface Served {
  readonly kind: "clamp";
  readonly layer: number | readonly number[];
  readonly k?: number | null;
  readonly parts: readonly { readonly feature: number; readonly what: string; readonly layer?: number; readonly value?: number }[];
  readonly sha256?: string;
}

export interface GuardClient {
  step(name: Step, signal?: AbortSignal): Promise<{ exit: number; stdout: string; stderr: string }>;
  run(code: string, timeoutS: number, signal?: AbortSignal): Promise<{ exit: number; stdout: string; stderr: string }>;
  served(signal?: AbortSignal): Promise<Served | null>;
  reading(signal?: AbortSignal): Promise<{ files: { name: string; text: string }[]; skill: string | null }>;
  control(body: Record<string, unknown>, samples: number, signal?: AbortSignal): Promise<{ original: string[]; edited: string[] }>;
}

export function guardClient(access: () => GuardAccess | undefined, fetchImpl: typeof globalThis.fetch = globalThis.fetch): GuardClient {
  const call = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const a = access();
    if (!a) throw new Error("the GG box is not up: there is no guard to ask yet");
    const res = await fetchImpl(`${a.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${a.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`the GG box answered ${res.status} to ${path}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  // a program can print without end: each stream keeps its last FRAME_KEEP bytes as the frames arrive, never the whole body
  const frames = async (res: Response) => {
    const kept: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const size: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };
    const keep = (stream: "stdout" | "stderr", b: Buffer) => {
      kept[stream].push(b);
      size[stream] += b.length;
      while (size[stream] - kept[stream][0]!.length >= FRAME_KEEP) size[stream] -= kept[stream].shift()!.length;
    };
    let exit = 255;
    let pending = "";
    const take = (line: string) => {
      if (!line) return;
      const frame = JSON.parse(line) as { stream?: "stdout" | "stderr"; data?: string; exit?: number };
      if (frame.exit !== undefined) exit = frame.exit;
      else if (frame.stream) keep(frame.stream, Buffer.from(frame.data ?? "", "base64"));
    };
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) take(line);
    }
    take(pending + decoder.decode());
    // each stream's kept bytes are decoded once, whole: a frame boundary can fall inside a character
    const text = (stream: "stdout" | "stderr") => {
      const all = Buffer.concat(kept[stream]);
      return (size[stream] > FRAME_KEEP ? all.subarray(all.length - FRAME_KEEP) : all).toString("utf8");
    };
    return { exit, stdout: text("stdout"), stderr: text("stderr") };
  };
  return {
    async step(name, signal) {
      return frames(await call("POST", `/gg/step/${name}`, {}, signal));
    },
    async run(code, timeoutS, signal) {
      return frames(await call("POST", "/gg/run", { code, timeout: timeoutS }, signal));
    },
    async served(signal) {
      return ((await (await call("GET", "/gg/served", undefined, signal)).json()) as { served: Served | null }).served;
    },
    async reading(signal) {
      const r = (await (await call("GET", "/gg/reading", undefined, signal)).json()) as { files: { name: string; text: string }[]; skill?: string | null };
      return { files: r.files, skill: r.skill ?? null };
    },
    async control(body, samples, signal) {
      return (await (await call("POST", "/gg/control", { body, samples }, signal)).json()) as { original: string[]; edited: string[] };
    },
  };
}

/** What each step does, in the words the agent is shown. */
const STEP_TEXT: Record<Step, string> = {
  find: "Step 1 on your GPU box: run the bridge passages and neutral ones through Qwen3.5-27B, take the bridge-minus-neutral direction at layers 24-40 (the open replication's method) and the dictionary (SAE) features that make most of it. About 10 s.",
  pick: "Step 2: Jev screens the candidate features: each one is turned up inside the model and judged on where it fires and what the model then says. About 20 s.",
  strength: "Step 3: clamp the Golden Gate's parts (SAE features at one layer: bridges, California, bridge building, towers) to k times their max at every token, Anthropic's way, and have Jev grade each k on the served model: does the bridge get into the thinking, does it notice its own obsession, does it still try to answer. About 3 min.",
  bake: "Step 4: keep the chosen clamp served and have Jev pick showcase answers. About 30 s.",
};

const tail = (text: string, n = 6000) => (text.length > n ? `…${text.slice(-n)}` : text);

export interface GgToolsOptions {
  readonly guard: GuardClient;
  /** "skill": gg_run, the agent's own code (the chat page); "steps" (default): the prepared pipeline's four steps. */
  readonly mode?: "skill" | "steps";
  /** Writes the reading list into the agent's workspace; answers the paths it wrote, relative to the workspace. */
  readonly saveReading: (files: readonly { name: string; text: string }[]) => Promise<string[]>;
  /** Writes the golden-gate skill into the agent's workspace (skill mode); answers its path, relative to the workspace. */
  readonly saveSkill?: (text: string) => Promise<string>;
}

export function ggToolsExtension(o: GgToolsOptions): Extension {
  const signalOf = (context: Context) => context.abortSignal;
  const step = (name: Step) =>
    defineTool({
      name: `gg_${name}`,
      description: STEP_TEXT[name],
      parameters: Type.Object({}),
      // a step run again recomputes the same files: an interrupted call may run twice
      replay: "safe",
      async execute(_args, _api, context) {
        const r = await o.guard.step(name, signalOf(context));
        const text = tail([r.stdout.trim(), r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : ""].filter(Boolean).join("\n\n"));
        if (r.exit !== 0) return { isError: true, content: [{ type: "text" as const, text: `gg ${name} exited ${r.exit}.\n${text}` }] };
        return { content: [{ type: "text" as const, text: text || `gg ${name} done.` }] };
      },
    });
  const run = defineTool({
    name: "gg_run",
    description:
      "Run your own Python on your GPU box, as its unprivileged user with no network. `import gglab` reaches the lab there: Qwen3.5-27B, its SAEs and Jev (see skills/golden-gate/SKILL.md). Prints come back; files you write stay in the box user's home for your next run. Up to 30 min.",
    parameters: Type.Object({
      code: Type.String({ description: "The Python program to run." }),
      timeout_s: Type.Optional(Type.Number({ description: "Deadline in seconds (default 600, at most 1800)." })),
    }),
    // a program can serve a clamp: replaying an interrupted call runs it again, which the agent's code must tolerate
    replay: "safe",
    async execute(args, _api, context) {
      const r = await o.guard.run(args.code, Math.max(10, Math.min(1800, args.timeout_s ?? 600)), signalOf(context));
      const text = tail([r.stdout.trim(), r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : ""].filter(Boolean).join("\n\n"));
      if (r.exit !== 0) return { isError: true, content: [{ type: "text" as const, text: `exit ${r.exit}.\n${text}` }] };
      return { content: [{ type: "text" as const, text: text || "done, nothing printed." }] };
    },
  });
  return defineExtension({
    name: "gg-tools",
    tools: [
      defineTool({
        name: "gg_read",
        description:
          o.mode === "skill"
            ? "Fetch the reading list into reading/ in your workspace (Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, the Qwen-Scope SAE card) and the golden-gate skill into skills/golden-gate/SKILL.md. Read them there with your shell (grep, head, sed -n, cat)."
            : "Fetch the reading list into reading/ in your workspace: Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, and the Qwen-Scope SAE card. Read them there with your shell (grep, head, sed -n).",
        parameters: Type.Object({}),
        replay: "safe",
        async execute(_args, _api, context) {
          const { files, skill } = await o.guard.reading(signalOf(context));
          if (files.length === 0) return { isError: true, content: [{ type: "text" as const, text: "The GG box has no reading list yet." }] };
          const paths = await o.saveReading(files);
          const list = files.map((f, i) => `${paths[i]}  (${Buffer.byteLength(f.text)} bytes)`).join("\n");
          const skillLine = o.mode === "skill" && skill && o.saveSkill ? `\n${await o.saveSkill(skill)}  (your skill: read it whole, then follow it)` : "";
          return { content: [{ type: "text" as const, text: `${list}${skillLine}\nRead them with grep, head, sed -n.` }] };
        },
      }),
      ...(o.mode === "skill" ? [run] : STEPS.map(step)),
    ],
  });
}
