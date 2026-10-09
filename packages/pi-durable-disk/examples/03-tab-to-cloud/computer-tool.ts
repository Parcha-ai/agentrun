// computer: the agent sees and drives the desktop of the machine it runs on, the way a person with a mouse and keyboard
// would. Every action ends with a screenshot (JPEG of the whole screen) in the tool's result, so one call is one look at the
// result of one action. Every host registers the tool, always in the same place of the registry (a task that moved with the
// run must find its definition wherever it resumes); a host with a desktop gives it a driver (computer-driver.ts, over an X
// display), any other host gives none and the tool refuses. Portable: no Node API.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const COMPUTER_TOOL = "computer";
export const SCREEN = { width: 1280, height: 720 } as const;

export const COMPUTER_ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "type", "key", "scroll", "wait"] as const;

export type ComputerAction = {
  action: (typeof COMPUTER_ACTIONS)[number];
  x?: number;
  y?: number;
  text?: string;
  keys?: string;
  clicks?: number;
  ms?: number;
};

/** What a host with a desktop does for the tool: one action, then the screen. */
export interface ComputerDriver {
  /** The X display, for the tool's description (programs are started on it). */
  readonly display: string;
  act(action: ComputerAction): Promise<{ did: string; jpegBase64: string }>;
}

const describe = (display: string | undefined) =>
  [
    `See and drive this machine's desktop (${SCREEN.width}x${SCREEN.height}, pixels from the top left) with a mouse and keyboard. Every action returns a screenshot taken after it.`,
    "Only a host with a desktop offers it (the notice you get on arriving says so); anywhere else the call is refused.",
    "Start with action screenshot. Click where you see something to click; type into what has focus; key presses combinations such as ctrl+l or Return.",
    display ? `Start programs from bash, detached, on the display: setsid -f env DISPLAY=${display} chromium https://example.com` : "",
  ]
    .filter(Boolean)
    .join(" ");

/** The tool over `driver`, or, without one, the same tool refusing. */
export function computerTool(driver?: ComputerDriver): Extension {
  return defineExtension({
    name: "computer",
    tools: [
      defineTool({
        name: COMPUTER_TOOL,
        description: describe(driver?.display),
        parameters: Type.Object({
          action: Type.Union(COMPUTER_ACTIONS.map((a) => Type.Literal(a)), { description: "What to do." }),
          x: Type.Optional(Type.Number({ description: "Pixels from the left, for click, double_click, right_click, move and scroll." })),
          y: Type.Optional(Type.Number({ description: "Pixels from the top, for the same actions." })),
          text: Type.Optional(Type.String({ description: "Text to type, for type." })),
          keys: Type.Optional(Type.String({ description: "A key or combination in xdotool names, for key: Return, Tab, ctrl+l, alt+F4." })),
          clicks: Type.Optional(Type.Number({ description: "Scroll steps, for scroll: positive down, negative up. Default 3." })),
          ms: Type.Optional(Type.Number({ description: "Milliseconds to wait, for wait (at most 10000)." })),
        }),
        async execute(args) {
          const a = args as ComputerAction;
          if (!driver) return { isError: true, content: [{ type: "text" as const, text: "This host has no desktop, so there is nothing for the computer tool to see or drive here. Hosts with a desktop (a Modal VM) offer it." }] };
          try {
            const { did, jpegBase64 } = await driver.act(a);
            return {
              content: [
                { type: "text" as const, text: `${did}. Screen ${SCREEN.width}x${SCREEN.height}.` },
                { type: "image" as const, data: jpegBase64, mimeType: "image/jpeg" },
              ],
              details: { action: a.action, ...(a.x !== undefined && a.y !== undefined ? { x: Math.round(a.x), y: Math.round(a.y) } : {}) },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text" as const, text: `The ${a.action} failed: ${(error as Error).message}` }] };
          }
        },
      }),
    ],
  });
}
