// The computer tool's driver for a Linux host with an X display: xdotool does the input, ImageMagick takes the picture. Node only.
import { execFile } from "node:child_process";
import { SCREEN, type ComputerAction, type ComputerDriver } from "./computer-tool.ts";

function run(file: string, args: string[], display: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: display, HOME: process.env.HOME ?? "/tmp" }, timeout: timeoutMs, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args[0] ?? ""}: ${String(stderr).trim().slice(-300) || error.message}`));
      else resolve(stdout);
    });
  });
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));

/** The driver over the X display `display` (default $DEMO_DISPLAY, else :1). `settleMs`: how long the screen gets to react before the picture. */
export function xdotoolDriver(options: { display?: string; settleMs?: number } = {}): ComputerDriver {
  const display = options.display ?? process.env.DEMO_DISPLAY ?? ":1";
  const settleMs = options.settleMs ?? 700;
  const xdotool = (args: string[]) => run("xdotool", args, display, 15_000);
  const screenshot = async () => (await run("import", ["-window", "root", "-quality", "60", "jpeg:-"], display, 15_000)).toString("base64");
  return {
    display,
    async act(a: ComputerAction) {
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
      return { did, jpegBase64: await screenshot() };
    },
  };
}
