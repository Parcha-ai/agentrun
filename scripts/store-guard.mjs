// What the store guard (store-sql-guard.test.mjs) reads in a source file: whether it holds SQL, and which SQLite drivers it
// takes. Only the store knows SQL, pragmas, a file or a driver (design 2.1). A file is parsed with TypeScript's own parser,
// as check-direction.mjs reads imports: SQL is looked for in its string and template literals (never its comments), in any
// case and spacing, a template's substitutions read as a name; a driver is any import, export-from, import() or require of
// one.
import ts from "typescript";

/** SQL as a statement, not as a word in prose: a keyword with what makes it a statement after it, in any case and over
 *  any whitespace. A table name may be bare, quoted, bracketed or a template's substitution. */
const NAME = String.raw`(?:[\w.]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|\$\{[^}]*\})`;
export const SQL = new RegExp(
  [
    String.raw`\bPRAGMA\s+\w`,
    String.raw`\bSELECT\b[\s\S]{0,200}?\bFROM\s+${NAME}`,
    String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${NAME}`,
    String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${NAME}\s+SET\b`,
    String.raw`\bDELETE\s+FROM\s+${NAME}`,
    String.raw`\b(?:CREATE|ALTER|DROP)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|(?:UNIQUE\s+)?INDEX|VIEW|TRIGGER)\b`,
  ].join("|"),
  "i",
);

/** The modules a SQLite driver comes from; pi-durable's is its SqliteStorage, named. */
const DRIVERS = new Set(["node:sqlite", "better-sqlite3", "sqlite3", "@earendil-works/chord/sqlite"]);
const PI_DURABLE = /^@earendil-works\/pi-durable(?:\/.*)?$/;

function parse(source, fileName) {
  const kind = /\.m?js$/.test(fileName) ? ts.ScriptKind.JS : /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Every string a file writes: its string literals, and its templates with each substitution as `${…}`. */
function stringsOf(file) {
  const out = [];
  const walk = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(node.head.text + node.templateSpans.map((span) => "${…}" + span.literal.text).join(""));
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out;
}

/** Whether `source` (a file's text) writes SQL in a string. */
export function sqlIn(source, fileName = "source.ts") {
  return stringsOf(parse(source, fileName)).some((text) => SQL.test(text));
}

/** The SQLite drivers `source` takes: each module it imports, exports from, import()s or requires that is one, and
 *  pi-durable's SqliteStorage by name. */
export function driversIn(source, fileName = "source.ts") {
  const found = new Set();
  const take = (specifier, names = []) => {
    if (DRIVERS.has(specifier)) found.add(specifier);
    else if (PI_DURABLE.test(specifier) && names.includes("SqliteStorage")) found.add(`${specifier} SqliteStorage`);
  };
  const walk = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const names = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements.map((element) => (element.propertyName ?? element.name).text) : [];
      take(node.moduleSpecifier.text, names);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) take(node.arguments[0].text);
    }
    ts.forEachChild(node, walk);
  };
  walk(parse(source, fileName));
  return [...found].sort();
}
