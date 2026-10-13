// The pipeline as the agent's tools, each one a typed route of the GG box's guard (box/guard.py) behind the tools' key: a
// step runs that step's fixed command on the box, so no command the agent writes ever runs on the GPU box. The agent reads
// the reading list in its own workspace with its own shell.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";

export type Step = "find" | "pick" | "strength" | "bake";
export const STEPS: readonly Step[] = ["find", "pick", "strength", "bake"];

/** Where the guard is and its tools' key; read at every call, so a box made after the session opened is reachable. */
export type GuardAccess = { readonly url: string; readonly key: string };

/** bake's served.json: the edit the server holds. */
export interface Served {
  readonly layer: number;
  readonly scale: number;
  readonly f: number;
  readonly sha256?: string;
  readonly tensor?: string;
}

export interface GuardClient {
  step(name: Step, signal?: AbortSignal): Promise<{ exit: number; stdout: string; stderr: string }>;
  served(signal?: AbortSignal): Promise<Served | null>;
  reading(signal?: AbortSignal): Promise<{ name: string; text: string }[]>;
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
  return {
    async step(name, signal) {
      const res = await call("POST", `/gg/step/${name}`, {}, signal);
      // each stream's bytes are decoded once, whole: a frame boundary can fall inside a character
      const bytes: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
      let exit = 255;
      for (const line of (await res.text()).split("\n")) {
        if (!line) continue;
        const frame = JSON.parse(line) as { stream?: "stdout" | "stderr"; data?: string; exit?: number };
        if (frame.exit !== undefined) exit = frame.exit;
        else if (frame.stream) bytes[frame.stream].push(Buffer.from(frame.data ?? "", "base64"));
      }
      return { exit, stdout: Buffer.concat(bytes.stdout).toString("utf8"), stderr: Buffer.concat(bytes.stderr).toString("utf8") };
    },
    async served(signal) {
      return ((await (await call("GET", "/gg/served", undefined, signal)).json()) as { served: Served | null }).served;
    },
    async reading(signal) {
      return ((await (await call("GET", "/gg/reading", undefined, signal)).json()) as { files: { name: string; text: string }[] }).files;
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
  strength: "Step 3: write the direction into layer 32's MLP output matrix (a rank-1 edit) and have Jev search the strength on the served weights: the most obsessed setting that stays readable. 1.5-2 min.",
  bake: "Step 4: keep the chosen edit served, write the checkpoint (its hash checked against the served tensor) and a control vector, and have Jev pick showcase answers. About 15 s.",
};

const tail = (text: string, n = 6000) => (text.length > n ? `…${text.slice(-n)}` : text);

export interface GgToolsOptions {
  readonly guard: GuardClient;
  /** Writes the reading list into the agent's workspace; answers the paths it wrote, relative to the workspace. */
  readonly saveReading: (files: readonly { name: string; text: string }[]) => Promise<string[]>;
  /** The steered requests sent so far: the switch's (the first) and the latest; undefined before the switch. */
  readonly requests: () => Promise<{ readonly switch?: Record<string, unknown>; readonly last?: Record<string, unknown> }>;
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
  return defineExtension({
    name: "gg-tools",
    tools: [
      defineTool({
        name: "gg_read",
        description:
          "Fetch the reading list into reading/ in your workspace: Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, and the Qwen-Scope SAE card. Read them there with your shell (grep, head, sed -n).",
        parameters: Type.Object({}),
        replay: "safe",
        async execute(_args, _api, context) {
          const files = await o.guard.reading(signalOf(context));
          if (files.length === 0) return { isError: true, content: [{ type: "text" as const, text: "The GG box has no reading list yet." }] };
          const paths = await o.saveReading(files);
          const list = files.map((f, i) => `${paths[i]}  (${Buffer.byteLength(f.text)} bytes)`).join("\n");
          return { content: [{ type: "text" as const, text: `${list}\nRead them with grep, head, sed -n.` }] };
        },
      }),
      ...STEPS.map(step),
      defineTool({
        name: "gg_control",
        // the one tool the switched-to model is offered: its description is part of what that model reads, so it says nothing of the edit
        description:
          "The control, for when your user asks for it: the request that switched you (or your latest one) sent again to your GPU box, on its original weights and then on the edited ones, a few times each, side by side.",
        parameters: Type.Object({
          which: Type.Optional(Type.Union([Type.Literal("switch"), Type.Literal("last")], { description: "switch (default): the request that switched you; last: your latest request." })),
        }),
        replay: "safe",
        async execute(args, _api, context) {
          const seen = await o.requests();
          const body = args.which === "last" ? seen.last : seen.switch;
          if (!body) return { isError: true, content: [{ type: "text" as const, text: "There is no request to replay yet: switch to your edited model first." }] };
          const r = await o.guard.control(body, 3, signalOf(context));
          const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
          return {
            content: [{ type: "text" as const, text: `The same request, original weights:\n${list(r.original)}\n\nThe same request, edited weights:\n${list(r.edited)}` }],
            details: { original: r.original, edited: r.edited },
          };
        },
      }),
    ],
  });
}
