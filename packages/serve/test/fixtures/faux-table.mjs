// The tests' harness table (harness-table.ts HARNESS_TABLE_ENV): every harness but pi runs on run-adapters' faux harness,
// scripted by a module's `script(spec)`, as `--faux` runs pi on the faux model. Each entry keeps its harness's facts (its
// wire, its search, its memory) and the route its own adapter's proxy takes, so the run's own requests beside the
// scripted harness's go through the one route; what a stand-in changes is said here, as an entry, never in serve.
//
// fauxTable(script) is the path of a table module for `script` (a fixture's absolute path or file URL), made once per
// script: startServer({ harnessTable: fauxTable(FAUX_HARNESS) }). The table module loads in the server too, so the script
// module (which may hold a run's process at its exit) is imported only when a run's adapter is made, in its process.
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
                // refuse the run (a model no key reaches).
                const proxy = await builtin.route(env, needs).catch(() => undefined);
                return fauxAdapter({ script: module.script, ...(proxy ? { proxy } : {}) });
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
