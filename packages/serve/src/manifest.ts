// A package file's YAML front matter, read one way wherever it is read: the package reader (templates.ts), its eval
// cases (template-eval.ts) and `agentrun deploy`, which imports this module (`@parcha/agentrun-serve/manifest`) to find
// the files a folder's package holds before it sends them. It loads nothing but the YAML parser.
import { parseDocument } from "yaml";

/** The front matter: the text between a `---` line at the file's top and the next `---` line. */
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A file's front matter, parsed (core schema, unique keys, no merge keys, no aliases), and the body after it; or why it
 *  does not read (`problem`, said after "its front matter"); undefined when the file has none. */
export function frontMatter(text: string): { data: unknown; body: string } | { problem: string } | undefined {
  const match = FRONT.exec(text);
  if (!match) return undefined;
  const doc = parseDocument(match[1]!, { schema: "core", merge: false, uniqueKeys: true, strict: true });
  if (doc.errors.length) return { problem: `is not YAML: ${doc.errors[0]!.message.split("\n")[0]}` };
  try {
    return { data: doc.toJS({ maxAliasCount: 0 }), body: text.slice(match[0].length) };
  } catch (error) {
    return { problem: `is refused: ${(error as Error).message}` };
  }
}

/** agent.md's manifest, its front matter when that reads as a mapping, else undefined (the package reader says why). */
export function manifestOf(text: string): Record<string, unknown> | undefined {
  const front = frontMatter(text);
  if (!front || "problem" in front) return undefined;
  const { data } = front;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
}
