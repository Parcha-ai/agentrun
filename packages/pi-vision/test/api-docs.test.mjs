// Every name a stranger can import has a doc comment: for each entry in package.json `exports`, every exported symbol, a
// re-export through its source. The comment is what an editor shows on hover and what the published `.d.ts` carries; the
// package has no other reference, so an export without one is documented nowhere.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
const entries = Object.entries(manifest.exports).map(([name, target]) => [name, path.join(PACKAGE, target.types)]);

test("every export of every entry has a doc comment in the built declarations", () => {
  const program = ts.createProgram(entries.map(([, file]) => file), {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const without = [];
  for (const [entry, file] of entries) {
    const source = program.getSourceFile(file);
    assert.ok(source, `${entry}: ${file} is not built: run npm run build -w @parcha/pi-vision first`);
    const module = checker.getSymbolAtLocation(source);
    assert.ok(module, `${entry} exports nothing`);
    for (const symbol of checker.getExportsOfModule(module)) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const comment = ts.displayPartsToString(target.getDocumentationComment(checker)) || ts.displayPartsToString(symbol.getDocumentationComment(checker));
      if (!comment.trim()) without.push(`${entry} ${symbol.name}`);
    }
  }
  assert.deepEqual(without, [], "give each a /** */ comment above its declaration: what it is, and what a caller must know");
});
