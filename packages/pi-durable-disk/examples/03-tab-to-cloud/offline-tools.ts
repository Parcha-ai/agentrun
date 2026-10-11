// go_offline and go_online: the agent takes its own run off the network and brings it back. Both are asked of the tab that runs the agent (the only host with a
// browser store to hand the run to); the tool answers as soon as the page took the request, and the page does the work after the step ends: a checkout, then the
// conversation configured onto the model that lives in the tab (go_offline), or a check-in, then configured back onto the cloud model (go_online). The tool ends
// the agent's turn (`control.terminate`): the next one is the other model's. Every host registers both, in the same place, so a task that moved with the run finds
// its definition wherever it resumes; a host that is not a tab refuses. Portable: no Node API.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** What the page offers the tools: begin the move after the current step, or say why it will not. */
export interface OfflineChannel {
  /** Resolves once the page took the request (the move itself happens after the step ends); rejects with the reason it will not (`OfflineRefusedError`). */
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
}

export class OfflineRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineRefusedError";
  }
}

export const GO_OFFLINE_TOOL = "go_offline";
export const GO_ONLINE_TOOL = "go_online";

const text = (t: string) => [{ type: "text" as const, text: t }];

const refuse = (verb: string, error: unknown) => ({ isError: true, content: text(`${verb}: ${(error as Error).message}`) });

/**
 * The two tools over a channel; without one (a host that is not a tab) the same tools, refusing. Replay is unsafe (the default): an interrupted call is never run again.
 * A successful call ends the turn: what happens next is the page's, and the next turn is answered by the other model.
 */
export function offlineTools(channel?: OfflineChannel): Extension {
  return defineExtension({
    name: "offline-tools",
    tools: [
      defineTool({
        name: GO_OFFLINE_TOOL,
        description: [
          "Go offline: hand your run to the browser you are running in, so you keep working with no network.",
          "Your conversation and your workspace files stay with you; the small model that lives in this browser answers your next turn, with your read, write and bash tools.",
          "This turn ends here. Use it when your user is about to lose their connection, or asks you to work offline.",
          "Only the browser tab that runs you can do this; anywhere else the call is refused.",
        ].join(" "),
        parameters: Type.Object({}),
        async execute() {
          if (!channel) return { isError: true, content: text("You did not go offline: this host is not a browser tab, so there is no browser to hand the run to.") };
          try {
            await channel.goOffline();
            return { content: text("Going offline: your run is being handed to the browser. This turn ends here; the model in the browser answers next, with your conversation and files."), details: { to: "offline" }, control: { terminate: true as const } };
          } catch (error) {
            return refuse("You did not go offline", error);
          }
        },
      }),
      defineTool({
        name: GO_ONLINE_TOOL,
        description: [
          "Go online: hand the work you did offline back to the server and continue on the cloud model.",
          "The files you wrote and your conversation go home; the cloud model answers your next turn.",
          "This turn ends here. Use it when the network is back and the offline work is done.",
          "Only the browser tab that holds the run offline can do this; anywhere else the call is refused.",
        ].join(" "),
        parameters: Type.Object({}),
        async execute() {
          if (!channel) return { isError: true, content: text("You did not go online: this host is not the browser tab that holds your run offline.") };
          try {
            await channel.goOnline();
            return { content: text("Going online: your work is being handed back to the server. This turn ends here."), details: { to: "online" }, control: { terminate: true as const } };
          } catch (error) {
            return refuse("You did not go online", error);
          }
        },
      }),
    ],
  });
}
