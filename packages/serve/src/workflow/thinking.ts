// Kept apart from runner.ts so the durable node runner reads it without a pi coding agent installed.
/** A workflow node's thinking level: the first level given, the node's own before its host's, else medium. Thinking is
 *  never off: a level of `off` is medium too. */
export function nodeThinking<Level extends string>(...given: readonly (Level | null | undefined)[]): Exclude<Level, "off"> | "medium" {
  const level = given.find((named): named is Level => named !== undefined && named !== null);
  return level === undefined || level === "off" ? "medium" : level as Exclude<Level, "off">;
}
