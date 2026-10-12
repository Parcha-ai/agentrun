// switch_environment: the agent moves its own computer. The tool asks the server (through whatever carries this host's
// frames to it: the pipe of a tab or a remote host, the link of a cloud host) to continue the run in another environment;
// the server runs the same planned handover a user's click starts (the host finishes its step and releases, the target
// claims the run and admits the durable "you are now running in X" notice, now saying the agent moved itself and why).
// The tool answers as soon as the move began, with the handover's id; its result commits in the step that ends here.
// Portable: no Node API.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** The request one host sends, and the answers the server gives. */
export type SwitchRequest = { t: "switch"; to: string; by: "agent"; reason: string; ask: string };
export type SwitchAnswer = { t: "switch-accepted"; ask: string; switchId: string } | { t: "switch-refused"; ask?: string; message: string };

export interface SwitchChannel {
  /** Resolves with the handover's id once the server began the move; rejects with the reason it refused (`SwitchRefusedError`). */
  request(to: string, reason: string): Promise<{ switchId: string }>;
}

export class SwitchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchRefusedError";
  }
}

/**
 * A channel over a socket of frames. The host feeds every frame it receives to `accept`; an answer to an open request
 * settles it and `accept` returns true. A request nobody answers within `timeoutMs`, or whose socket cannot send, rejects.
 */
export class FrameSwitchChannel implements SwitchChannel {
  readonly #send: (frame: SwitchRequest) => boolean;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, { resolve: (v: { switchId: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #next = 1;

  constructor(send: (frame: SwitchRequest) => boolean, timeoutMs = 30_000) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  request(to: string, reason: string): Promise<{ switchId: string }> {
    const ask = `ask-${Date.now().toString(36)}-${this.#next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(ask);
        reject(new SwitchRefusedError("the server did not answer the request to move"));
      }, this.#timeoutMs);
      this.#pending.set(ask, { resolve, reject, timer });
      if (!this.#send({ t: "switch", to, by: "agent", reason, ask })) this.lose("this host has no connection to the server right now");
    });
  }

  accept(frame: { t: string; ask?: string; switchId?: string; message?: string }): boolean {
    if (frame.t !== "switch-accepted" && frame.t !== "switch-refused") return false;
    const pending = frame.ask ? this.#pending.get(frame.ask) : undefined;
    if (!pending || !frame.ask) return false;
    this.#pending.delete(frame.ask);
    clearTimeout(pending.timer);
    if (frame.t === "switch-accepted" && frame.switchId) pending.resolve({ switchId: frame.switchId });
    else pending.reject(new SwitchRefusedError(frame.message ?? "the server refused the move"));
    return true;
  }

  /** The socket is gone: every open request fails. */
  lose(message: string): void {
    for (const [ask, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new SwitchRefusedError(message));
      this.#pending.delete(ask);
    }
  }
}

export const SWITCH_TOOL = "switch_environment";
const REASON_MAX = 300;

/** A reason as the server keeps it (in the notice, an environment variable, a log): one line of at most 300 characters, no control characters. */
export function cleanReason(reason: unknown): string {
  return String(reason ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_MAX);
}

const description = (environments: readonly string[] | undefined) =>
  [
    "Move your whole computer to another environment and continue your work there.",
    "Your conversation and the files in your workspace come with you; programs that are running do not.",
    "The move happens right after this step: you then continue on the new machine and get a system notice saying where you are. If this call is reported as interrupted, that notice tells you where you are.",
    "Use it when the task needs what this machine lacks (more cores or memory, a full Linux VM with Docker, a desktop, a GPU).",
    environments && environments.length > 0 ? `target is one of: ${environments.join(", ")}.` : "target is an environment id; an unknown one is refused with the list of the ids that exist.",
    "Only a host with a connection to your user's server can move you; anywhere else the call is refused.",
  ].join(" ");

/**
 * The tool, over a channel; without one (a host that cannot reach the server) the same tool refusing. Every host registers it,
 * in the same place: a task that moved with the run must find its definition wherever it resumes. Replay is unsafe (the
 * default): an interrupted call is never run again, so it never asks twice. `environments`: the ids this host knows, for the description.
 */
export function switchEnvironment(channel?: SwitchChannel, environments?: readonly string[]): Extension {
  return defineExtension({
    name: "switch-environment",
    tools: [
      defineTool({
        name: SWITCH_TOOL,
        description: description(environments),
        parameters: Type.Object({
          target: Type.String({ description: "The id of the environment to move to, for example modal-vm." }),
          reason: Type.String({ description: "One sentence: why you are moving. It is kept in your memory and shown in the notice you get there." }),
        }),
        async execute(args) {
          if (!channel) return { isError: true, content: [{ type: "text" as const, text: "You were not moved: this host cannot reach your user's server to ask for a move. Tell your user where you want to go." }] };
          try {
            const { switchId } = await channel.request(args.target, cleanReason(args.reason));
            return {
              content: [{ type: "text" as const, text: `Handover ${switchId} started: you are moving to ${args.target}. This step finishes here; you continue there with your conversation and workspace files.` }],
              details: { switchId, target: args.target },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text" as const, text: `You were not moved: ${(error as Error).message}` }] };
          }
        },
      }),
    ],
  });
}
