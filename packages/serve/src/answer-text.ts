// An answer's body read with a cap: what a call to another service reads of its answer, so no answer is held whole in
// memory however long it is.

/** `answer`'s body as text, read up to `max` bytes; undefined once it is longer (the rest is cancelled, never read). A
 *  body that breaks off while it is read throws, as `answer.text()` would. */
export async function textUpTo(answer: Response, max: number): Promise<string | undefined> {
  const reader = answer.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
}
