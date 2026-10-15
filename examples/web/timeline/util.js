export const obj = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
export const str = (value) => (typeof value === "string" ? value : undefined);
export const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
export const firstLine = (text) => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
export const firstSentence = (text) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
};
export function utf8Bytes(text) {
    let bytes = 0;
    for (const char of text) {
        const code = char.codePointAt(0);
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}
export function json(text) {
    try {
        return obj(JSON.parse(text));
    }
    catch {
        return undefined;
    }
}
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)([^?#]*)/i;
/** `host/path` of a URL: no scheme, no credentials, no query, no fragment. */
export function where(url) {
    const parts = URL_SHAPE.exec(url.trim());
    return cut(parts ? `${parts[1]}${parts[2] === "/" ? "" : parts[2]}` : (url.split(/[?#]/)[0] ?? ""), 80);
}
const ELIDED = "\u2026";
const TEXT_URL = /https?:\/\/[^\s"'`<>\\]+/gi;
const URL_PARTS = /^(https?:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;
/**
 * Every http(s) URL in `text` keeps its origin, its path and its query keys. Query values, the fragment and the
 * userinfo are dropped, the rule pi-browser applies to the URLs a model sees.
 */
export function scrubUrls(text) {
    return text.replace(TEXT_URL, (raw) => {
        const tail = /[.,;:!?)\]}]+$/.exec(raw)?.[0] ?? "";
        const parts = URL_PARTS.exec(raw.slice(0, raw.length - tail.length));
        if (!parts)
            return raw;
        const keys = [...new Set((parts[4] ?? "").split("&").map((pair) => pair.split("=")[0]).filter(Boolean))];
        return `${parts[1]}${parts[2]}${parts[3]}${keys.length ? `?${keys.map((key) => `${key}=${ELIDED}`).join("&")}` : ""}${tail}`;
    });
}
/** `a, b, +2 more`. */
export const list = (items) => items.length > 2 ? `${items.slice(0, 2).join(", ")}, +${items.length - 2} more` : items.join(", ");
