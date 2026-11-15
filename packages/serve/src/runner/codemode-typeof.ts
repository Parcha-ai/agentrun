// `typeof tools.<name>` in a codemode script (meta-tools.ts): JavaScript's own test for a member, which never throws. The
// sandbox's `tools` (pi-codemode's) throws on a read of a name the run has no tool by, so a mistyped call says which tools
// the run has, never QuickJS's bare "not a function"; but a typeof reads the member too, so it threw as well. Each
// `typeof tools.<name>` (or `tools["<name>"]`, `tools?.<name>`) is rewritten, found by the script's syntax tree (never in
// a string or a comment), to read the member only where `tools` has it: "undefined" for a name it has not, as for any
// object. Every other read of an unknown name, a call included, keeps the sandbox's words.
import { parse } from "acorn";

type Node = { readonly type: string; readonly start: number; readonly end: number; readonly [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The member of `tools` that `node` (a typeof's operand) reads by a name fixed in the script, or undefined. */
function toolNameOf(node: unknown): string | undefined {
  const member = isNode(node) && node.type === "ChainExpression" ? node.expression : node;
  if (!isNode(member) || member.type !== "MemberExpression") return undefined;
  const [object, property] = [member.object, member.property];
  if (!isNode(object) || object.type !== "Identifier" || object.name !== "tools" || !isNode(property)) return undefined;
  if (!member.computed && property.type === "Identifier") return property.name as string;
  return member.computed && property.type === "Literal" && typeof property.value === "string" ? property.value : undefined;
}

/** `script` with each `typeof` of a member of `tools` read only where `tools` has it; as given when it doesn't parse (the
 *  sandbox then says what is wrong with it). */
export function typeofTools(script: string): string {
  let tree: unknown;
  try {
    tree = parse(script, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  } catch {
    return script;
  }
  const edits: { start: number; end: number; name: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isNode(value)) return;
    const name = value.type === "UnaryExpression" && value.operator === "typeof" ? toolNameOf(value.argument) : undefined;
    if (name !== undefined) edits.push({ start: (value.argument as Node).start, end: (value.argument as Node).end, name });
    for (const [key, inner] of Object.entries(value)) if (key !== "type") visit(inner);
  };
  visit(tree);
  let out = script;
  for (const { start, end, name } of edits.sort((a, b) => b.start - a.start)) {
    const key = JSON.stringify(name);
    // Only `tools` and syntax: no name of the script's own (an `Object`, an `undefined` it declares) can change the answer.
    out = `${out.slice(0, start)}(tools !== null && (typeof tools === "object" || typeof tools === "function") && ${key} in tools ? tools[${key}] : void 0)${out.slice(end)}`;
  }
  return out;
}
