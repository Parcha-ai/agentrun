// Portable: no Node API, no DOM API.
/** The URLs of a split GGUF's parts, from its first (`-00001-of-0000N.gguf`); a file that is not split is its own only part. */
export function shardUrls(first: string): string[] {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/.exec(first);
  if (!m) return [first];
  return Array.from({ length: Number(m[2]) }, (_, i) => first.replace(/-\d{5}-of-(\d{5})\.gguf$/, `-${String(i + 1).padStart(5, '0')}-of-$1.gguf`));
}
