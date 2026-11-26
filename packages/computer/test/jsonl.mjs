import { existsSync, readFileSync } from "node:fs";

/**
 * The records of a JSON-lines file the fake programs append to, one appendFileSync of a line each: those whose newline
 * is there. A read while another process appends can see part of that append (Linux shows a write to readers page by
 * page), so the text after the last newline is a record still being written, read whole on a later look.
 */
export const records = (path) => {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	return text
		.slice(0, text.lastIndexOf("\n") + 1)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
};
