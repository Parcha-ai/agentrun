/** The pixel size a JPEG states in its first start-of-frame segment, or null when it states none. */
export function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // C0..CF are start-of-frame markers, except C4 (tables), C8 (reserved) and CC (arithmetic conditioning).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      const h = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      const w = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      return w > 0 && h > 0 ? { w, h } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** The sampling factors the first start-of-frame segment states for each component, as hex pairs joined by commas ("22,11,11" is 4:2:0, the layout
 *  a browser's JPEG has; "11" is grayscale), or null when it states none. */
export function jpegSampling(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const count = bytes[at + 9];
      if (count === undefined || count < 1 || at + 10 + count * 3 > bytes.length) return null;
      const factors: string[] = [];
      for (let i = 0; i < count; i += 1) factors.push(bytes[at + 10 + i * 3 + 1]!.toString(16).padStart(2, "0"));
      return factors.join(",");
    }
    at += 2 + length;
  }
  return null;
}
