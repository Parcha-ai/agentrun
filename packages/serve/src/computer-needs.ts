// What a sandbox must have for its agent's work: `computer.needs`, the programs its box must have on its PATH, such as
// ["chrome", "ffmpeg", "ffprobe", "hyperframes"] for an agent that renders video, or the libraries its python3 or node
// must load, such as ["python-pptx", "pptxgenjs"] for one that makes decks. It says what the box must hold and
// never which image it is: the image is the provider's own (a Docker box's is AGENTRUN_DOCKER_IMAGE's, else the
// default recipe's). The claim checks them in the box it started (computer-for-claim.ts), before the run's first model
// request; a box that lacks one, or that cannot be asked, is let go and the claim refuses it, so the run ends failed
// (run_failed) in words naming what is missing and how to give the box an image that has it. Never a fallback: a run
// whose box lacks something it needs does not start its work.
import type { ComputerClient, ProviderEntry } from "@parcha/agentrun-computer";
import type { InputIssue } from "./errors.js";
import { shellEnv } from "./workspace/hands.js";

/** A need as a setting says it: a program's name a shell finds on its PATH, or a library's pip or npm name; no path, no
 *  space and no leading dash, so a scoped npm package (`@scope/name`) can't be named. */
export const NEED_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** The most needs one setting names. */
export const MAX_NEEDS = 32;
/** How long the check in the box may take. */
export const NEEDS_CHECK_MS = 30_000;
/** The media image's recipe in the computer package, as the words of a Docker box's fix name it. */
export const MEDIA_RECIPE_PATH = "packages/computer/media/Dockerfile";
/** The documents image's recipe folder in the computer package, as the words of a Docker box's fix name it. */
export const DOCUMENTS_RECIPE_DIR = "packages/computer/documents";

/** What is wrong with `value` as a sandbox's needs, at `field`. */
export function needsIssues(value: unknown, field: string): InputIssue[] {
  const rule = `${field} is a list of 1 to ${MAX_NEEDS} program names the box must have on its PATH (or libraries its python3 or node loads, by their pip or npm names), each once, such as ["ffmpeg", "ffprobe"]`;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NEEDS || !value.every((name) => typeof name === "string")) return [{ field, reason: "wrong_type", message: rule }];
  const bad = value.find((name) => !NEED_NAME.test(name));
  if (bad !== undefined) return [{ field, reason: "bad_format", message: `${field} holds ${JSON.stringify(bad)}, not a need's name: letters, digits, dots, underscores, plus signs and dashes, starting with a letter or digit, no path` }];
  if (new Set(value).size !== value.length) return [{ field, reason: "duplicate", message: `${field} names one need twice` }];
  return [];
}

/** Whether the box's python3 has the distribution `sys.argv[1]` installed, by the name pip installs it by (pip's own
 *  normalization: case, dots, dashes and underscores alike). */
const PYTHON_HAS = "import importlib.metadata, sys; importlib.metadata.distribution(sys.argv[1])";
/** Whether a script of the box's node requires the name it is given (its one argument, the last of process.argv), from the folder the check runs in: node_modules of
 *  that folder and of each folder above it, up to /node_modules (where the documents image links its libraries), and
 *  node's global folders. */
const NODE_HAS = 'require("module").createRequire(process.cwd() + "/").resolve(process.argv.at(-1))';

/** The script the box runs: each argument it finds neither as a program on its PATH, nor as a library its python3 has
 *  installed, nor as a package its node requires, one a line. A box with no python3 or no node lacks the libraries that
 *  would need it. The names are arguments, never text of the script. */
const CHECK = `for name do command -v "$name" >/dev/null 2>&1 || python3 -c '${PYTHON_HAS}' "$name" >/dev/null 2>&1 || node -e '${NODE_HAS}' "$name" >/dev/null 2>&1 || printf "%s\\n" "$name"; done`;

/** What the box answered: the needs it lacks (none: it has them all), or why it could not be asked. */
export type NeedsAnswer = { readonly missing: readonly string[] } | { readonly unchecked: string };

/** Asks the box behind `client` which of `needs` it lacks, by one `sh` with the names as its arguments, under the agent's
 *  shell environment (shellEnv): its PATH, never the image's, so a program the check finds is one the agent's bash finds. */
export async function missingNeeds(client: ComputerClient, needs: readonly string[], signal?: AbortSignal): Promise<NeedsAnswer> {
  let ran: Awaited<ReturnType<typeof client.call<"exec.run">>>;
  try {
    ran = await client.call("exec.run", { argv: ["sh", "-c", CHECK, "sh", ...needs], env: { ...shellEnv() }, timeoutMs: NEEDS_CHECK_MS }, signal ? { signal } : undefined);
  } catch (error) {
    return { unchecked: error instanceof Error ? error.message : String(error) };
  }
  if (!ran.ok) return { unchecked: ran.error.message };
  if (ran.value.exitCode !== 0) return { unchecked: ran.value.timedOut ? `the check ran past ${NEEDS_CHECK_MS / 1000} s` : `the check exited ${ran.value.exitCode ?? `on ${ran.value.signal ?? "a signal"}`}` };
  const said = Buffer.from(ran.value.stdout, "base64").toString("utf8").split("\n").filter(Boolean);
  // Only names it was asked about: anything else the box printed is not an answer.
  const missing = needs.filter((name) => said.includes(name));
  return { missing };
}

/** How to give the Docker box an image that has what a sandbox needs. */
export const DOCKER_IMAGE_FIX = `Set AGENTRUN_DOCKER_IMAGE to an image that has them and restart the server. For video (chrome, ffmpeg, ffprobe, hyperframes), build the media image: docker build -t agentrun-media:<first 12 hex of its sha256> - < ${MEDIA_RECIPE_PATH}, and name that tag. For decks, documents and sheets (python-pptx, python-docx, openpyxl, pptxgenjs, docx, exceljs), build the documents image: docker build -t agentrun-documents:<first 12 hex of the sha256 of its Dockerfile and documents.sh> ${DOCUMENTS_RECIPE_DIR}, and name that tag.`;

/** How to give `entry`'s box an image that has what it lacks: a Docker box's is AGENTRUN_DOCKER_IMAGE (the media or
 *  documents image), a provider that names its image by a setting (imageEnv) by that one, any other its own image. */
function fixFor(entry: Pick<ProviderEntry, "label" | "local" | "imageEnv"> | undefined): string {
  if (entry?.local) return DOCKER_IMAGE_FIX;
  if (entry?.imageEnv) return `Set ${entry.imageEnv} to an image of ${entry.label}'s that has them and restart the server, or run this agent on the Docker box with an image that has them (AGENTRUN_DOCKER_IMAGE).`;
  return `Give this agent a computer whose image has them: on the Docker box, set AGENTRUN_DOCKER_IMAGE to such an image (the media image, ${MEDIA_RECIPE_PATH}, has chrome, ffmpeg, ffprobe and hyperframes).`;
}

/** The words a run ends with when its setting has needs but is no sandbox (`what`: "none", "a desktop on E2B"):
 *  only a sandbox's box is checked for them, so nothing ran. The validator keeps needs to a sandbox; a stored body and a
 *  launch's computer are read as given, so the claim refuses this too, never running without them. */
export function needsNoSandboxWords(needs: readonly string[], what: string): string {
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(needs);
  return `This agent needs ${list} in a sandbox (computer.needs), and its computer is ${what}, which is not checked for them, so nothing ran. Make its computer a sandbox on the Docker box. ${DOCKER_IMAGE_FIX}`;
}

/** The words a run ends with when its box lacks what its agent needs, or could not be asked: nothing ran. */
export function needsWords(answer: NeedsAnswer, needs: readonly string[], entry: Pick<ProviderEntry, "label" | "local" | "imageEnv"> | undefined): string {
  const box = `This agent's sandbox${entry ? ` on ${entry.label}` : ""}`;
  if ("unchecked" in answer) return `${box} could not be checked for what it needs (${needs.join(", ")}): ${answer.unchecked.replace(/[.!?]+$/, "")}. Nothing ran.`;
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(answer.missing);
  return `${box} lacks ${list}, which the agent needs (computer.needs), so nothing ran. ${fixFor(entry)}`;
}
