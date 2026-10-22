/** The `code` a thrown value carries as text (a Node system error's `ENOENT`, a harness refusal's own), or undefined for a value that has none. */
export const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined || code === null ? undefined : String(code);
};
