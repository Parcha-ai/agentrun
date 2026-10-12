// What the page knows of a file's text, so a write's diff can be against the file as it was: the event of a write carries only the new text. The page remembers what it saw written; anything that could have
// changed a file behind its back (any other tool that is not a pure read) makes it forget; a write that failed left nothing worth remembering. Portable, no DOM.

type ToolEvent = { type?: string; toolName?: string; toolCallId?: string; isError?: boolean; args?: { path?: unknown; content?: unknown } };
const READS = new Set(["read", "grep", "find", "ls"]);

export class WriteMemory {
  readonly #known = new Map<string, string>();
  readonly #pathOf = new Map<string, string>();

  /**
   * One tool event. For the start of a write, what the file's text was before it (undefined when the page does not know: the caller may read the file). Every other tool that is not a read forgets everything
   * (a bash can change any file); the end of a write that failed forgets that file.
   */
  observe(e: ToolEvent): { before: string | undefined } | undefined {
    if (e.type === "tool_execution_start" && e.toolName === "write" && typeof e.args?.path === "string" && typeof e.args.content === "string" && e.toolCallId) {
      const before = this.#known.get(e.args.path);
      this.#known.set(e.args.path, e.args.content);
      this.#pathOf.set(e.toolCallId, e.args.path);
      return { before };
    }
    if (e.type === "tool_execution_end" && e.toolCallId && this.#pathOf.has(e.toolCallId)) {
      const path = this.#pathOf.get(e.toolCallId)!;
      this.#pathOf.delete(e.toolCallId);
      if (e.isError === true) this.#known.delete(path);
      return undefined;
    }
    if (e.type === "tool_execution_start" && e.toolName !== undefined && e.toolName !== "write" && !READS.has(e.toolName)) this.#known.clear();
    return undefined;
  }
}
