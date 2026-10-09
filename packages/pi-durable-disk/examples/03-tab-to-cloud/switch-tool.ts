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

const DESCRIPTION = [
  "Move your whole computer to another environment and continue your work there.",
  "Your conversation and the files in your workspace come with you; programs that are running do not.",
  "The move happens right after this step: you then continue on the new machine and get a system notice saying where you are.",
  "Use it when the task needs what this machine lacks (more cores or memory, a full Linux VM with Docker, a desktop, a GPU).",
  "target is an environment id such as modal-vm; a refusal lists the ids that exist.",
].join(" ");

/** The tool, over a channel. Replay is unsafe (the default): an interrupted call is never run again, so it never asks twice. */
export function switchEnvironment(channel: SwitchChannel): Extension {
  return defineExtension({
    name: "switch-environment",
    tools: [
      defineTool({
        name: SWITCH_TOOL,
        description: DESCRIPTION,
        parameters: Type.Object({
          target: Type.String({ description: "The id of the environment to move to, for example modal-vm." }),
          reason: Type.String({ description: "One sentence: why you are moving. It is kept in your memory and shown in the notice you get there." }),
        }),
        async execute(args) {
          try {
            const { switchId } = await channel.request(args.target, args.reason);
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
