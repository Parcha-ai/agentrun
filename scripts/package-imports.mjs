// The module specifiers a built file imports, read from the file's parse tree. Only real syntax counts, so a string, a comment or
// a template literal that happens to contain "from '...'" is not an import, and every form is read: `import ... from`,
// `export ... from` (also `export * as ns from` and `export type * from`), a side-effect `import`, `import x = require()`,
// `import()`, `require()`, and `import('x')` or `typeof import('x')` as a type in a declaration file. The text is parsed as
// TypeScript, which reads plain JavaScript and declaration files alike.
import ts from 'typescript';

/** The specifiers `source` (the text of a .js or .d.ts file) imports, in source order. A specifier that is not a literal
 *  (`require(name)`) names nothing and is not listed. */
export function importsOf(source) {
  const specifiers = [];
  const literal = node => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
  const visit = node => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = literal(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = literal(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = literal(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier = literal(node.arguments[0]);
    if (specifier !== undefined) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('input.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return specifiers;
}
