// What the store guard (store-sql-guard.test.mjs) reads in a source file: whether it holds SQL, and which SQLite drivers it
// takes. Only the store knows SQL, pragmas, a file or a driver (design 2.1). A file is parsed with TypeScript's own parser,
// as check-direction.mjs reads imports: SQL is looked for in its string and template literals (never its comments), in any
// case and spacing, a template's substitutions read as a name; a driver is any import, export-from, import() or require of
// one for a value (a type-only import is none), a createRequire'd require included.
// A known gap: SQL built by concatenation or a join ("SELECT id " + "FROM runs", "UPDATE " + table + " SET") is in no
// one string, so the SQL half does not see it; nor does it see VACUUM or ATTACH. Each still needs a driver to run, and
// the driver half sees that.
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

/** The modules a SQLite driver comes from, each with every subpath, whatever is taken from it: node's, better-sqlite3,
 *  sqlite3, chord's sqlite and pi-durable's storage/sqlite (its openers, its database, its migrations). */
const DRIVER = /^(?:node:sqlite|better-sqlite3|sqlite3|@earendil-works\/chord\/sqlite|@earendil-works\/pi-durable\/storage\/sqlite)(?:\/.*)?$/;
/** pi-durable's other modules: a driver only by its SqliteStorage, named, or read off a namespace or an import(). */
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

/** A call of createRequire (bare or as module.createRequire): what it returns requires a module. */
const isCreateRequire = (node) => ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === "createRequire") || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire"));

/** The SQLite drivers `source` takes: each driver module it imports, exports from, import()s or requires (createRequire's
 *  too) for a value (a type is no driver), and pi-durable's SqliteStorage, by name or read off a namespace import or an
 *  import() of it. */
export function driversIn(source, fileName = "source.ts") {
  const found = new Set();
  /** pi-durable modules taken whole (a namespace, an import() or a require): SqliteStorage may be read off them. */
  const whole = new Set();
  let readsSqliteStorage = false;
  /** The names a module is required by: require, and each one createRequire made. */
  const requires = new Set(["require"]);
  /** `specifier` taken for a value: `names` the names it gives (null: the module whole). */
  const take = (specifier, names) => {
    if (DRIVER.test(specifier)) found.add(specifier);
    else if (PI_DURABLE.test(specifier)) {
      if (names === null) whole.add(specifier);
      else if (names.includes("SqliteStorage")) found.add(`${specifier} SqliteStorage`);
    }
  };
  /** The value names an import or export-from gives (null: the module whole), or undefined when it gives types only. */
  const valueNames = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return null; // import "x": the module runs
      if (clause.isTypeOnly) return undefined;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return null;
      const named = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text) : [];
      if (clause.name) return [...named, "default"];
      return named.length > 0 ? named : undefined;
    }
    if (node.isTypeOnly) return undefined;
    const clause = node.exportClause;
    if (!clause || ts.isNamespaceExport(clause)) return null; // export * from "x"
    const named = clause.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text);
    return named.length > 0 ? named : undefined;
  };
  const walk = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = valueNames(node);
      if (names !== undefined) take(node.moduleSpecifier.text, names);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requires.has(callee.text)) || isCreateRequire(callee)) take(node.arguments[0].text, null);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequire(node.initializer)) {
      requires.add(node.name.text);
    } else if ((ts.isPropertyAccessExpression(node) && node.name.text === "SqliteStorage") || (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === "SqliteStorage")) {
      readsSqliteStorage = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(parse(source, fileName));
  if (readsSqliteStorage) for (const specifier of whole) found.add(`${specifier} SqliteStorage`);
  return [...found].sort();
}
