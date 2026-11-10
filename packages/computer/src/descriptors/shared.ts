// What several descriptors share: the two Linux configurations and the browser's image. Data alone.
import type { KindCapabilities } from "../kinds.js";

/** A Linux shell: exec, files and processes. */
export const SANDBOX: KindCapabilities = { kind: "linux", groups: ["exec", "files", "processes"] };

/** A Linux desktop: a shell, and the screen, pointer and keys of an X display. */
export const LINUX_DESKTOP: KindCapabilities = { kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };

/** The image every browser computer runs: its vendor's own Chromium. */
export const BROWSER_IMAGE = "chromium";
