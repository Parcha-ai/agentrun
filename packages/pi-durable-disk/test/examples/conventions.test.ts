// Every example under examples/ follows the conventions its README states, as far as code can tell (_conventions.ts).
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoot } from "../_run-support.ts";
import { checkExamples } from "./_conventions.ts";
import { EXAMPLES } from "./_run-example.ts";

const TESTS = fileURLToPath(new URL(".", import.meta.url));

it("every example under examples/ follows the conventions", () => {
  assert.deepEqual(checkExamples(EXAMPLES, TESTS), []);
});

it("the check reports each convention an example breaks, and a listed example that is gone", () => {
  const dir = scratchRoot("example-conventions");
  try {
    const examples = join(dir.root, "examples");
    const tests = join(dir.root, "tests");
    const example = (name: string, files: Record<string, string>) => {
      mkdirSync(join(examples, name), { recursive: true });
      for (const [file, text] of Object.entries(files)) writeFileSync(join(examples, name, file), text);
    };
    mkdirSync(tests, { recursive: true });
    const main = 'import { localRun } from "@parcha/pi-durable-disk";\nimport { createModels } from "@earendil-works/pi-ai";\nimport { join } from "node:path";\nimport { helper } from "./helper.ts";\n';
    example("good", { "README.md": "# good\n", "main.ts": main, "helper.ts": "export const helper = 1;\n" });
    example("03-numbered", { "README.md": "", "main.ts": "" });
    example("no-test", { "README.md": "", "main.ts": "" });
    example("no-main", { "README.md": "" });
    example("unlisted", { "README.md": "", "main.ts": "" });
    example("reaches-out", {
      "README.md": "",
      "main.ts": 'import { openDurableRun } from "../../src/run.ts";\nimport type { X } from "../shared.ts";\nconst m = await import("lodash");\n// import "./not-an-import-in-a-comment.ts";\nconst s = "from \'../fake\'";\n',
    });
    example("01-durable-chat", { "demo.ts": 'import "../lib/demo.ts";\n' }); // legacy: not checked
    for (const name of ["good", "03-numbered", "no-main", "unlisted", "reaches-out"]) writeFileSync(join(tests, `${name}.test.ts`), "");
    writeFileSync(join(examples, "README.md"), ["| Example | What | Needs | CI |", "|---|---|---|---|",
      ...["good", "03-numbered", "no-test", "no-main", "reaches-out", "gone", "01-durable-chat"].map((n) => `| [${n}](${n}/) | x | none | yes |`)].join("\n"));
    assert.deepEqual(checkExamples(examples, tests).sort(), [
      "03-numbered: a name is lowercase words with dashes, no number prefix",
      "gone: listed in examples/README.md, no such directory",
      "no-main: no main.ts",
      "no-test: no test/examples/no-test.test.ts",
      "reaches-out: main.ts imports ../../src/run.ts",
      "reaches-out: main.ts imports ../shared.ts",
      "reaches-out: main.ts imports lodash",
      "unlisted: no row in examples/README.md",
    ]);
  } finally {
    dir.remove();
  }
});
