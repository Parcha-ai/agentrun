// The tests' harness table (harness-table.ts HARNESS_TABLE_ENV): every harness but pi runs on run-adapters' faux harness,
// scripted by a module's `script(spec)`, as `--faux` runs pi on the faux model. Each entry keeps its harness's facts (its
// wire, its search, its memory) and the route its own adapter's proxy takes, so the run's own requests beside the
// scripted harness's go through the one route; what a stand-in changes is said here, as an entry, never in serve.
//
// fauxTable(script) is the path of a table module for `script` (a fixture's absolute path or file URL), made once per
// script: startServer({ harnessTable: fauxTable(FAUX_HARNESS) }). The table module loads in the server too, so the script
// module is imported only when a run's adapter is made, in its process.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = new URL("../../dist/", import.meta.url);
/** pi's faux model (model.ts FAUX_ENV): with it, every harness takes the run's faux model. */
const FAUX_ENV = "AGENTRUN_SERVE_FAUX";

const pathOf = (script) => (script instanceof URL ? fileURLToPath(script) : String(script).startsWith("file:") ? fileURLToPath(script) : String(script));

/** The entries over `builtins` that run each adapter harness on the faux harness `script` scripts. */
export function fauxEntries(script) {
  const file = pathOf(script);
  return (builtins) =>
    Object.fromEntries(
      Object.values(builtins)
        .filter((builtin) => builtin.facts)
        .map((builtin) => {
          const { facts } = builtin;
          // With pi's faux model every harness takes it; with a real one a harness whose model is its own keeps choosing
          // it, as in production (its session's proxy reaches its own provider).
          const own = (env) => facts.ownModel && !env[FAUX_ENV];
          return [
            builtin.id,
            {
              // Nothing to install, nothing to refuse: the faux harness runs any model the run names.
              installs: undefined,
              pins: undefined,
              skillCheck: undefined,
              runs: () => true,
              refusal: async () => undefined,
              onWire: (env) => own(env) && builtin.onWire(env),
              model: async (env, ref, available) => (own(env) ? builtin.model(env, ref, available) : (await import(new URL("model.js", DIST).href)).chooseModel(env, ref, "default", builtin.id)),
              adapter: async (env, needs) => {
                const [{ fauxAdapter }, module, { nativeOptions }] = await Promise.all([import("@parcha/agentrun-kernel/testing"), import(pathToFileURL(file).href), import(new URL("adapters.js", DIST).href)]);
                if (typeof module.script !== "function") throw new Error(`${file} exports no script(spec)`);
                // The options the harness's own adapter would be built with from the run (its web search), told to the module.
                module.opened?.(builtin.id, nativeOptions(facts, env));
                // The session's model proxy, as the harness's own adapter would start it. None where the harness would
                // refuse the run (a model no key reaches), or where it has no route of ours at all (Cursor's model is its
                // owner's plan).
                const proxy = builtin.route ? await builtin.route(env, needs).catch(() => undefined) : undefined;
                // The module's own hooks on the harness's process (faux-harness.mjs): each session's close told to it, a
                // slow open or close, and a close that fails.
                const openDelayMs = module.openDelayMs?.() ?? 0;
                const closeDelayMs = module.closeDelayMs?.() ?? 0;
                const closeError = module.closeError?.();
                return fauxAdapter({ script: module.script, ...(proxy ? { proxy } : {}), ...(module.closed ? { onClose: module.closed } : {}), ...(openDelayMs > 0 ? { openDelayMs } : {}), ...(closeDelayMs > 0 ? { closeDelayMs } : {}), ...(closeError ? { closeError } : {}) });
              },
            },
          ];
        }),
    );
}

/** The path of a table module whose entries are fauxEntries(`script`). */
export function fauxTable(script) {
  const file = pathOf(script);
  const dir = join(tmpdir(), "agentrun-faux-tables");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${createHash("sha256").update(file).digest("hex").slice(0, 16)}.mjs`);
  const body = `import { fauxEntries } from ${JSON.stringify(import.meta.url)};\nexport const entries = fauxEntries(${JSON.stringify(file)});\n`;
  const temp = `${out}.${process.pid}.tmp`;
  writeFileSync(temp, body);
  renameSync(temp, out);
  return out;
}

/** The entries over `builtins` of fauxEntries(`script`), except Goose's and Cursor's: each runs on its real ACP adapter
 *  (@parcha/agentrun-harness-acp acpAdapter) over the package's fake ACP agent, as its own entry would on its installed
 *  binary. The recipe is the harness's own (its recipe file: what it announces, its permission tie or allow file, its MCP
 *  over HTTP, its limits), with the fake agent as its command, played in its style: Cursor's MCP calls ask permission and
 *  are tied by their title, Goose's are allowed by its permission file. The model is the steps `script(spec)` gives,
 *  told to the fake when the session opens. Neither the fake nor the stub proxy calls a model. */
export function acpFakeEntries(script) {
  const file = pathOf(script);
  const faux = fauxEntries(script);
  return (builtins) => {
    const entries = faux(builtins);
    for (const id of ["goose", "cursor"]) {
      if (!entries[id]) continue;
      entries[id] = {
        ...entries[id],
        adapter: async (env) => {
          const [acp, { FAKE_ACP_AGENT }, module] = await Promise.all([import("@parcha/agentrun-harness-acp"), import("@parcha/agentrun-harness-acp/testing"), import(pathToFileURL(file).href)]);
          const own = id === "cursor" ? acp.cursorRecipe({ command: process.execPath }) : acp.gooseRecipe({ command: process.execPath, model: "claude-sonnet-5-5" });
          // Goose is billed through the host's model proxy: the fake calls no model, so its proxy lends no variables.
          const proxy = own.billing.kind === "proxy" ? { proxy: async () => ({ env: {}, close: async () => {} }) } : {};
          // The fake reads its config at its start: written in the session's own directory when the session opens.
          const made = (config) => acp.acpAdapter({ recipe: { ...own, args: [FAKE_ACP_AGENT, config] }, ...proxy, env });
          const checked = made("fake-agent.json");
          return {
            id: checked.id,
            check: checked.check.bind(checked),
            open: (spec, io) => {
              const config = join(io.dir, "fake-agent.json");
              const steps = module.script(spec).map((step) => ("call" in step ? { call: step.call, args: step.args ?? {} } : { say: step.say ?? "" }));
              writeFileSync(config, JSON.stringify({ script: steps, load: own.declares.load, http: own.declares.mcp === "http", style: id }));
              return made(config).open(spec, io);
            },
          };
        },
      };
    }
    return entries;
  };
}

/** The path of a table module whose entries are acpFakeEntries(`script`). */
export function acpFakeTable(script) {
  const file = pathOf(script);
  const dir = join(tmpdir(), "agentrun-faux-tables");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `acp-${createHash("sha256").update(file).digest("hex").slice(0, 16)}.mjs`);
  const body = `import { acpFakeEntries } from ${JSON.stringify(import.meta.url)};\nexport const entries = acpFakeEntries(${JSON.stringify(file)});\n`;
  const temp = `${out}.${process.pid}.tmp`;
  writeFileSync(temp, body);
  renameSync(temp, out);
  return out;
}
