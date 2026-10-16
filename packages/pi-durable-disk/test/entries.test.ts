// The package's three entries. Each exports exactly the values and types pinned in test/fixtures/entries.json, so adding or
// removing an export is a reviewed change to that file, not a side effect of an edit elsewhere. And each entry's declarations
// name only types its caller can import: a host can write the type of everything it passes in or gets back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const ENTRIES: Record<string, string> = { ".": "src/index.ts", "./lease": "src/lease.ts", "./internals": "src/internals.ts" };
// Besides the entry itself, what its caller imports from: `./internals` is used beside the root entry.
const BESIDE: Record<string, string[]> = { ".": [], "./lease": [], "./internals": ["."] };
const pinned = JSON.parse(readFileSync(join(ROOT, "test/fixtures/entries.json"), "utf8")) as Record<string, { values: string[]; types: string[] }>;

const program = ts.createProgram(
  Object.values(ENTRIES).map((file) => join(ROOT, file)),
  {
    noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [],
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
  },
);
const checker = program.getTypeChecker();
const target = (symbol: ts.Symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
const exportsOf = (entry: string) => checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(join(ROOT, ENTRIES[entry]!))!)!);
const declaredHere = (symbol: ts.Symbol) =>
  !(symbol.flags & ts.SymbolFlags.TypeParameter) && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().fileName.startsWith(SRC));

describe("the package's entries", () => {
  for (const entry of Object.keys(ENTRIES)) {
    it(`${entry} exports exactly the values and types pinned for it`, async () => {
      const values = Object.keys(await import(join(ROOT, ENTRIES[entry]!))).sort();
      const types = exportsOf(entry).map((symbol) => symbol.name).filter((name) => !values.includes(name)).sort();
      assert.deepEqual({ values, types }, pinned[entry]);
    });
  }

  it("name, in each entry's declarations, only the package's types that entry's caller can import", () => {
    const missing: string[] = [];
    for (const entry of Object.keys(ENTRIES)) {
      const importable = new Set([entry, ...BESIDE[entry]!].flatMap((each) => exportsOf(each).map(target)));
      for (const symbol of exportsOf(entry)) {
        const seen = new Set<ts.Node>();
        const visit = (node: ts.Node): void => {
          // A body or a private member is not part of what a caller sees.
          if (seen.has(node) || ts.isBlock(node) || (ts.isClassElement(node) && node.name && ts.isPrivateIdentifier(node.name))) return;
          if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) return;
          seen.add(node);
          if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
            const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
            const named = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : name);
            const type = named && target(named);
            if (type && declaredHere(type) && !importable.has(type)) {
              // A base class the caller cannot import is fine when its members are: they are the subclass's own.
              if (ts.isHeritageClause(node.parent) && type.flags & ts.SymbolFlags.Class) for (const base of type.declarations ?? []) visit(base);
              else missing.push(`${entry}: ${symbol.name} names ${type.name}`);
            }
          }
          ts.forEachChild(node, visit);
        };
        for (const declaration of target(symbol).declarations ?? []) visit(declaration);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });
});
