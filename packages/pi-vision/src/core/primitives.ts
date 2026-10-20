import { createHash } from "node:crypto";

export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export const base64Chars = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

export const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;

/** The first line of an error's message, as it stands: no redaction and no cut (`firstLine` in misses.ts does both). */
export const messageLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0]!;
