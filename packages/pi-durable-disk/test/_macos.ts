// macOS, as far as Linux can play it. `linuxPs` is macOS's ps and sysctl, so the process table macOS uses (psTable) runs
// against real processes here too: procps prints the same listing, and what it lacks, `-E` (the environment a process
// started with, after its arguments) and the boot's uuid, comes from /proc. `onPlatform` makes the code that picks a
// default by platform pick macOS's. Neither proves anything about a Mac: the macOS CI job does.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { CommandRunner } from "../src/process-table.ts";

/** Linux only. */
export const linuxPs: CommandRunner = (file, args) => {
  if (file.endsWith("/sysctl")) return readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  if (args.includes("-E")) {
    const pid = args[args.indexOf("-p") + 1];
    const words = (name: string) => readFileSync(`/proc/${pid}/${name}`, "utf8").split("\0").filter(Boolean);
    return `${[...words("cmdline"), ...words("environ")].join(" ")}\n`;
  }
  return execFileSync("ps", args, { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] });
};

/** Runs `use` with `process.platform` reading `platform`, and puts it back. Keep `use` short: every test of the file sees it. */
export async function onPlatform<T>(platform: NodeJS.Platform, use: () => T | Promise<T>): Promise<T> {
  const own = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...own, value: platform });
  try {
    return await use();
  } finally {
    Object.defineProperty(process, "platform", own);
  }
}
