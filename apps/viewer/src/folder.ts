// A dropped folder's entries. `readEntries` answers in batches (Chromium: 100 at most), so a folder is read until a
// batch comes back empty.

type Reader<E> = { readEntries(ok: (entries: E[]) => void, fail: (error: unknown) => void): void };

export async function readAllEntries<E>(reader: Reader<E>): Promise<E[]> {
  const all: E[] = [];
  for (;;) {
    const batch = await new Promise<E[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
