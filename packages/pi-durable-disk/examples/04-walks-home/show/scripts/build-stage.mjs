// Assembles the stage for packaging next to the agent's tab: the 03 server serves a folder under /show/ (`serve.ts --show-dir dist`). The folder is the built obsession page (index.html, main.js, fonts)
// and offline.json, the file list the tab's checkout caches (offline-list.mjs).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageFileList } from "./offline-list.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(show, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(show, "obsession", "page", "dist"), out, { recursive: true, filter: (src) => !src.endsWith(".map") });
const list = stageFileList(out, "/show/");
writeFileSync(join(out, "offline.json"), `${JSON.stringify(list, null, 2)}\n`);
console.log(`stage: ${list.files.length} files, version ${list.version.slice(0, 12)}`);
