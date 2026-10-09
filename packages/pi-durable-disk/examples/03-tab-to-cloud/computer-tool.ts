// computer: the agent sees and drives the desktop of the machine it runs on, the way a person with a mouse and keyboard
// would. Every action ends with a screenshot (JPEG of the whole screen) in the tool's result, so one call is one look at the
// result of one action. The desktop is a virtual X display (Xvfb, `DEMO_DISPLAY`, default :1) that a host starts when it has
// one; xdotool performs the input and ImageMagick takes the picture. Node only: a host installs it when its desktop runs.
import { execFile } from "node:child_process";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const COMPUTER_TOOL = "computer";
export const SCREEN = { width: 1280, height: 720 } as const;

const ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "type", "key", "scroll", "wait"] as const;

function run(file: string, args: string[], display: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: display, HOME: process.env.HOME ?? "/tmp" }, timeout: timeoutMs, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args[0] ?? ""}: ${String(stderr).trim().slice(-300) || error.message}`));
      else resolve(stdout);
    });
  });
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));

/** The tool, over the X display `display`. `settleMs` is how long the screen gets to react before the picture. */
export function computerTool(options: { display?: string; settleMs?: number } = {}): Extension {
  const display = options.display ?? process.env.DEMO_DISPLAY ?? ":1";
  const settleMs = options.settleMs ?? 700;
  const xdotool = (args: string[]) => run("xdotool", args, display, 15_000);
  const screenshot = async () => (await run("import", ["-window", "root", "-quality", "60", "jpeg:-"], display, 15_000)).toString("base64");
  return defineExtension({
    name: "computer",
    tools: [
      defineTool({
        name: COMPUTER_TOOL,
        description: [
          `See and drive this machine's desktop (${SCREEN.width}x${SCREEN.height}, pixels from the top left) with a mouse and keyboard. Every action returns a screenshot taken after it.`,
          "Start with action screenshot. Click where you see something to click; type into what has focus; key presses combinations such as ctrl+l or Return.",
          `Start programs from bash, detached, on the display: setsid -f env DISPLAY=${display} chromium https://example.com`,
        ].join(" "),
        parameters: Type.Object({
          action: Type.Union(ACTIONS.map((a) => Type.Literal(a)), { description: "What to do." }),
          x: Type.Optional(Type.Number({ description: "Pixels from the left, for click, double_click, right_click, move and scroll." })),
          y: Type.Optional(Type.Number({ description: "Pixels from the top, for the same actions." })),
          text: Type.Optional(Type.String({ description: "Text to type, for type." })),
          keys: Type.Optional(Type.String({ description: "A key or combination in xdotool names, for key: Return, Tab, ctrl+l, alt+F4." })),
          clicks: Type.Optional(Type.Number({ description: "Scroll steps, for scroll: positive down, negative up. Default 3." })),
          ms: Type.Optional(Type.Number({ description: "Milliseconds to wait, for wait (at most 10000)." })),
        }),
        async execute(args) {
          const a = args as { action: (typeof ACTIONS)[number]; x?: number; y?: number; text?: string; keys?: string; clicks?: number; ms?: number };
          try {
            const at = a.x !== undefined && a.y !== undefined ? [String(clamp(a.x, SCREEN.width)), String(clamp(a.y, SCREEN.height))] : undefined;
            const needAt = () => {
              if (!at) throw new Error(`${a.action} needs x and y`);
              return at;
            };
            let did: string = a.action;
            switch (a.action) {
              case "screenshot":
                break;
              case "move":
                await xdotool(["mousemove", ...needAt()]);
                did = `moved the mouse to ${needAt().join(",")}`;
                break;
              case "click":
              case "double_click":
              case "right_click":
                await xdotool(["mousemove", ...needAt(), "click", ...(a.action === "double_click" ? ["--repeat", "2", "--delay", "80"] : []), a.action === "right_click" ? "3" : "1"]);
                did = `${a.action.replace("_", " ")} at ${needAt().join(",")}`;
                break;
              case "type":
                if (!a.text) throw new Error("type needs text");
                await xdotool(["type", "--delay", "15", "--", a.text]);
                did = `typed ${a.text.length} characters`;
                break;
              case "key":
                if (!a.keys) throw new Error("key needs keys");
                await xdotool(["key", "--", ...a.keys.split(/\s+/)]);
                did = `pressed ${a.keys}`;
                break;
              case "scroll": {
                if (at) await xdotool(["mousemove", ...at]);
                const clicks = Math.round(a.clicks ?? 3);
                await xdotool(["click", "--repeat", String(Math.abs(clicks) || 1), clicks < 0 ? "4" : "5"]);
                did = `scrolled ${clicks}`;
                break;
              }
              case "wait":
                await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10_000, a.ms ?? 1_000))));
                did = "waited";
                break;
            }
            if (a.action !== "screenshot" && a.action !== "wait") await new Promise((r) => setTimeout(r, settleMs));
            return {
              content: [
                { type: "text" as const, text: `${did}. Screen ${SCREEN.width}x${SCREEN.height}.` },
                { type: "image" as const, data: await screenshot(), mimeType: "image/jpeg" },
              ],
              details: { action: a.action, ...(at ? { x: Number(at[0]), y: Number(at[1]) } : {}) },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text" as const, text: `The ${a.action} failed: ${(error as Error).message}` }] };
          }
        },
      }),
    ],
  });
}
