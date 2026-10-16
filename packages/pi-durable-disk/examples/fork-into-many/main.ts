// Fork one run into many, on directories of this machine: no disk, no key (pi-ai's faux model plays the agent). An agent
// drafts a release note in work/ and the run is released at that checkpoint (sealed). `forkLocal` copies the sealed run three
// times; each fork opens as generation 1 with the checkpoint's conversation, gets its own instruction, and rewrites the note
// for its own audience. The source stays sealed and unchanged, byte for byte.
//
//   node examples/fork-into-many/main.ts     (from packages/pi-durable-disk, after `npm run build` at the repository root)
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { ArchilCodingTools, forkLocal, localRun, openDurableRun } from "@parcha/pi-durable-disk";

const base = join(process.cwd(), "fork-into-many-run");
const source = join(base, "source");
const AUDIENCES = ["engineers", "customers", "auditors"];
const NOTE = "Runs survive kill -9: the files stay, the cut command is never rerun.";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

// The scripted agent decides from what the conversation holds. At the checkpoint it writes the note. A fork's instruction
// ("Rewrite work/note.txt for <audience>") makes it rewrite the note it finds in its own history: the checkpoint's note, which
// only a fork that kept the conversation can quote, prefixed by the audience.
const reply: FauxResponseFactory = (context) => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`Done: ${textOf(last.content).slice(0, 80)}`);
  const asked = textOf(last?.content);
  const audience = /^Rewrite work\/note\.txt for (\w+)\.$/.exec(asked)?.[1];
  if (!audience) return fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: NOTE }, { id: "call-note" }), { stopReason: "toolUse" });
  const written = context.messages
    .flatMap((message) => (message.role === "assistant" && Array.isArray(message.content) ? message.content : []))
    .findLast((part) => part.type === "toolCall" && part.name === "write") as { arguments?: { content?: string } } | undefined;
  return fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: `[${audience}] ${written?.arguments?.content ?? "(no note in the history)"}` }, { id: `call-${audience}` }), { stopReason: "toolUse" });
};
const faux = fauxProvider();
faux.setResponses(Array.from({ length: 100 }, () => reply));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(ArchilCodingTools);
const model = faux.getModel();
const agent = { model: { provider: model.provider, modelId: model.id } };
const open = (id: string, root: string) => openDurableRun({ disk: "local", region: "local", id }, { ...localRun(root), harness: { models, registry } });

/** Path to sha256 and mode of every file under `root` (a symlink by its target): what "unchanged" means here. */
function digest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else out.set(relative(root, path), `${(st.mode & 0o7777).toString(8)} ${st.isSymbolicLink() ? `-> ${readlinkSync(path)}` : createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

/** A file's text, or null when it is not there: a missing file is a failed check, not a crash. */
const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const fail = (message: string): never => {
  console.error(`not ok: ${message}`);
  process.exit(1);
};

// Anything that throws (a copy that runs out of disk, an open that is refused) is a failed example with its message, not a stack trace.
try {
  rmSync(base, { recursive: true, force: true });
  console.log(`the runs live under ${base}`);

  // 1. A run taken to a checkpoint, and released: sealed.
  const run = await open("release-note", source);
  const root = await run.harness.root(ctx, { agent });
  await (await root.submit({ type: "input", content: "Write the release note in work/note.txt." }, ctx)).wait(ctx);
  await run.setStatus("paused", { checkpoint: "the note is drafted" });
  await run.release();
  console.log(`checkpoint: generation ${run.generation} wrote note.txt and released the run, sealed`);
  const sealed = digest(source);

  // 2. Three forks, each its own run directory.
  const results = await forkLocal(source, AUDIENCES.map((audience) => ({ id: `note-for-${audience}`, root: join(base, audience) })));
  for (const r of results) console.log(`forked ${r.from} into ${r.run}: ${r.files} files, ${r.bytes} bytes, sealed at ${r.sealedSeq}`);
  if (JSON.stringify([...digest(source)]) !== JSON.stringify([...sealed])) fail("the source changed while it was forked");

  // 3. Each fork opens as generation 1, holds the checkpoint's conversation, and goes on with an instruction of its own.
  const problems: string[] = [];
  for (const [i, audience] of AUDIENCES.entries()) {
    const fork = await open(`note-for-${audience}`, join(base, audience));
    const conversation = await fork.harness.root(ctx, { agent });
    const before = (await conversation.entries({}, 100, undefined, ctx)).items.length;
    const inherited = read(join(base, audience, "work", "note.txt")); // the checkpoint's file, copied into the fork's own work/
    await (await conversation.submit({ type: "input", content: `Rewrite work/note.txt for ${audience}.` }, ctx)).wait(ctx);
    const after = (await conversation.entries({}, 100, undefined, ctx)).items.length;
    await fork.setStatus("done", { audience });
    await fork.release();
    const note = read(join(base, audience, "work", "note.txt"));
    console.log(`generation ${fork.generation} of ${results[i]!.run}: ${before} entries inherited, ${after - before} added; note.txt: ${note}`);
    if (fork.generation !== 1) problems.push(`${audience} opened generation ${fork.generation}`);
    if (inherited !== NOTE) problems.push(`${audience} did not inherit the checkpoint's note.txt (${JSON.stringify(inherited)})`);
    if (before === 0) problems.push(`${audience} did not inherit the checkpoint's conversation`);
    if (note !== `[${audience}] ${NOTE}`) problems.push(`${audience}'s note is ${JSON.stringify(note)}`);
  }

  // 4. The source is as it was released, and the forks did not touch each other.
  if (JSON.stringify([...digest(source)]) !== JSON.stringify([...sealed])) problems.push("the source changed after the forks ran");
  if (read(join(source, "work", "note.txt")) !== NOTE) problems.push("the source's note.txt changed");
  for (const audience of AUDIENCES) {
    const others = AUDIENCES.filter((other) => other !== audience);
    const text = read(join(base, audience, "work", "note.txt")) ?? "";
    if (others.some((other) => text.includes(`[${other}]`))) problems.push(`${audience}'s run holds another fork's note`);
  }
  if (problems.length > 0) fail(problems.join("; "));
  console.log(`ok: one sealed run forked three ways, each fork continued on its own from the checkpoint, and the source stayed byte for byte`);
} catch (error) {
  fail(`${(error as Error).message ?? error}`);
}
