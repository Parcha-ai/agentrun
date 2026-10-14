// The parts of examples/README.md's conventions that code can check: an example's directory, its files, its imports (read
// from the parse tree), its test and its row in the index. What it shows and how its README reads are for review.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
// @ts-expect-error: a plain .mjs module of the repository's scripts, without declarations
import { importsOf } from "../../../../scripts/package-imports.mjs";

/** The directories under examples/ that predate the conventions: Archil examples 01 and 02, and their shared helpers. */
export const LEGACY = new Set(["01-durable-chat", "02-paid-effect", "lib"]);

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PEER = /^@earendil-works\/(?:pi-durable|pi-ai|chord)(?:\/|$)/;
const SOURCE = /\.(?:ts|mts|js|mjs)$/;

/** Whether an example may import `specifier`: the package, its peers, a node: builtin, or a file of its own directory. */
export function allowedImport(specifier: string): boolean {
  return specifier === "@parcha/pi-durable-disk" || specifier.startsWith("@parcha/pi-durable-disk/") || PEER.test(specifier)
    || specifier.startsWith("node:") || (specifier.startsWith("./") && !specifier.includes("/../"));
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The examples the index (`examples/README.md`) lists, by the directory its row links: `| [name](name/) | ...`. */
export function indexed(readme: string): string[] {
  return [...readme.matchAll(/^\|\s*\[([^\]]+)\]\(([^)]+)\/\)/gm)].filter((m) => m[1] === m[2]).map((m) => m[1]!);
}

/** Every way the examples under `examples` (with their tests under `tests`) break the conventions; empty when none does. */
export function checkExamples(examples: string, tests: string): string[] {
  const problems: string[] = [];
  const readme = join(examples, "README.md");
  const listed = existsSync(readme) ? indexed(readFileSync(readme, "utf8")) : [];
  if (!existsSync(readme)) problems.push("examples/README.md is missing");
  const dirs = readdirSync(examples).filter((entry) => statSync(join(examples, entry)).isDirectory() && !LEGACY.has(entry));
  for (const name of dirs) {
    const dir = join(examples, name);
    if (!NAME.test(name)) problems.push(`${name}: a name is lowercase words with dashes, no number prefix`);
    for (const file of ["README.md", "main.ts"]) if (!existsSync(join(dir, file))) problems.push(`${name}: no ${file}`);
    if (!existsSync(join(tests, `${name}.test.ts`))) problems.push(`${name}: no test/examples/${name}.test.ts`);
    if (!listed.includes(name)) problems.push(`${name}: no row in examples/README.md`);
    for (const file of sources(dir)) {
      for (const specifier of importsOf(readFileSync(file, "utf8")) as string[]) {
        if (!allowedImport(specifier)) problems.push(`${name}: ${relative(dir, file)} imports ${specifier}`);
      }
    }
  }
  for (const name of listed) if (!LEGACY.has(name) && !dirs.includes(name)) problems.push(`${name}: listed in examples/README.md, no such directory`);
  return problems;
}
