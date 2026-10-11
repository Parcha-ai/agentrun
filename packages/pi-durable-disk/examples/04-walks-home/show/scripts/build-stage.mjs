// Assembles the stage's root for packaging next to the agent's tab (the 03 server mounts it under /show/): obsession/ (the built page) and offline.json (its file list, offline-list.mjs).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageFileList } from "./offline-list.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(show, "dist");
const page = join(show, "obsession", "page", "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(page, join(out, "obsession"), { recursive: true, filter: (src) => !src.endsWith(".map") });
const list = stageFileList(join(out, "obsession"), "obsession/");
writeFileSync(join(out, "offline.json"), `${JSON.stringify(list, null, 2)}\n`);
console.log(`stage: ${list.files.length} files, version ${list.version.slice(0, 12)}`);
