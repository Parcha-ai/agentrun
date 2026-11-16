// Imported first by a test file that starts a ChatGPT sign-in, before anything loads pi-ai: pi-ai's sign-in listens for
// OpenAI's callback on port 1455 of PI_OAUTH_CALLBACK_HOST, read once when its module loads (127.0.0.1 with none). On
// Linux every 127.x.y.z is this machine, so each test process listens on a loopback address of its own, and test files
// run side by side (or by other checkouts on one machine) never hold one another's port. Where the platform has
// 127.0.0.1 alone (macOS), it stays. The product listens on 127.0.0.1:1455; the redirect address pasted back is
// 127.0.0.1:1455 here too (pi-ai's fixed redirect_uri), since only the listener moves.
import { randomInt } from "node:crypto";

if (process.platform === "linux" && !process.env.PI_OAUTH_CALLBACK_HOST) {
  process.env.PI_OAUTH_CALLBACK_HOST = `127.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** The address this process's sign-ins listen on for the loopback callback. */
export const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
