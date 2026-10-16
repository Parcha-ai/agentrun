import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE_SH, workspaceNotEmptiable } from "../src/home/move.ts";

/**
 * Runs the box's part of emptying a workspace, with `store` as the store's file and `home` as the box's home
 * directory; returns its exit code.
 */
function empty(workspace: string, home: string | undefined, store = "/nowhere/session/run.sqlite"): number | null {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	if (home !== undefined) env.HOME = home;
	return spawnSync("sh", ["-c", EMPTY_WORKSPACE_SH, "sh", workspace, store], { env }).status;
}

/** A box-like tree: a home with a workspace in it, the store beside the workspace, a file beside, one outside. */
function tree(root: string) {
	const home = join(root, "home", "user");
	const workspace = join(home, "work");
	const store = join(home, "session", "run.sqlite");
	const beside = join(home, "beside.txt");
	const outside = join(root, "outside.txt");
	mkdirSync(join(workspace, "dir", "deep"), { recursive: true });
	mkdirSync(dirname(store), { recursive: true });
	writeFileSync(join(workspace, "file.txt"), "x");
	writeFileSync(join(workspace, ".hidden"), "x");
	writeFileSync(join(workspace, "dir", "deep", "f"), "x");
	writeFileSync(store, "store");
	writeFileSync(beside, "beside");
	writeFileSync(outside, "outside");
	symlinkSync(outside, join(workspace, "link-out"));
	symlinkSync(join(root, "home"), join(workspace, "link-up"));
	return { home, workspace, store, beside, outside };
}

describe("emptying the workspace of a place a session comes back to", () => {
	it("refuses a path that is empty, relative, not in normal form, the system's own, or one that holds the store", () => {
		const store = "/srv/box-a/session/run.sqlite";
		for (const workspace of [
			"",
			"work",
			"./work",
			"/srv/box-a/../box-a/work",
			"/srv/box-a/./work",
			"/srv//work",
			"/srv/w/",
		]) {
			expect(workspaceNotEmptiable({ workspace, store }), JSON.stringify(workspace)).toBeDefined();
		}
		for (const workspace of ["/", "/home", "/root", "/tmp", "/usr", "/var", "/etc"]) {
			expect(workspaceNotEmptiable({ workspace, store }), workspace).toContain("directory of the system");
		}
		expect(workspaceNotEmptiable({ workspace: "/srv/box-a", store })).toContain("holds the store");
		expect(workspaceNotEmptiable({ workspace: "/srv/box-a/session/run.sqlite", store })).toContain("holds the store");
		expect(workspaceNotEmptiable({ workspace: "/srv/box-a/work", store })).toBeUndefined();
		expect(workspaceNotEmptiable({ workspace: "/workspace", store: "/session/run.sqlite" })).toBeUndefined();
	});

	it("empties the workspace's entries only: links as links, never its parent, the store or what a link points at", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-empty-"));
		try {
			const at = tree(root);
			expect(empty(at.workspace, at.home, at.store)).toBe(0);
			expect(existsSync(at.workspace)).toBe(true);
			expect(readdirSync(at.workspace)).toEqual([]);
			for (const kept of [at.store, at.beside, at.outside, join(root, "home")])
				expect(existsSync(kept), kept).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses, removing nothing, the box's home, a directory above it, a link, and a box with no home", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-empty-refused-"));
		try {
			const at = tree(root);
			const linked = join(root, "linked-work");
			symlinkSync(at.workspace, linked);
			expect(empty(at.home, at.home, at.store), "the home").toBe(9);
			expect(empty(join(root, "home"), at.home, at.store), "above the home").toBe(9);
			expect(empty(linked, join(root, "elsewhere"), at.store), "a link").toBe(9);
			expect(empty(at.workspace, undefined, at.store), "no home").toBe(9);
			expect(readdirSync(at.workspace).sort()).toEqual([".hidden", "dir", "file.txt", "link-out", "link-up"]);
			for (const kept of [at.store, at.beside, at.outside]) expect(existsSync(kept), kept).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses, removing nothing, a workspace whose path goes through a link to a system directory, the home or the store", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-empty-linked-"));
		try {
			const at = tree(root);
			const listed = (dir: string) => readdirSync(dir).sort();
			// A directory that stands for `/`: a test must never point a deletion at this machine's own root.
			const slash = join(root, "slash");
			mkdirSync(join(slash, "etc"), { recursive: true });
			writeFileSync(join(slash, "etc", "passwd"), "kept");
			symlinkSync(slash, join(root, "to-slash"));
			const home = listed(at.home);
			const store = listed(dirname(at.store));
			// Each workspace below is written with no link in its last part: only an ancestor is a link.
			symlinkSync(join(root, "home"), join(root, "to-homes"));
			for (const [name, workspace] of [
				["an ancestor linked to the root", join(root, "to-slash", "etc")],
				["an ancestor linked to the home's parent", join(root, "to-homes", "user")],
				["an ancestor linked to the store's directory's parent", join(root, "to-homes", "user", "session")],
			] as const) {
				expect(empty(workspace, at.home, at.store), name).toBe(9);
			}
			expect(listed(join(slash, "etc"))).toEqual(["passwd"]);
			expect(listed(at.home)).toEqual(home);
			expect(listed(dirname(at.store))).toEqual(store);
			// The store's directory reached through a link that points into the workspace, and a home that is a link to it.
			mkdirSync(join(at.workspace, "session"));
			writeFileSync(join(at.workspace, "session", "run.sqlite"), "store");
			symlinkSync(join(at.workspace, "session"), join(root, "store-link"));
			expect(empty(at.workspace, at.home, join(root, "store-link", "run.sqlite")), "the store through a link").toBe(
				9,
			);
			symlinkSync(at.workspace, join(root, "home-link"));
			expect(empty(at.workspace, join(root, "home-link"), at.store), "a home linked to it").toBe(9);
			symlinkSync(join(root, "gone"), join(root, "dangling"));
			expect(empty(join(root, "dangling"), at.home, at.store), "a dangling link").toBe(9);
			expect(listed(at.workspace)).toEqual([".hidden", "dir", "file.txt", "link-out", "link-up", "session"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves a workspace that is not there to the move, and makes nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-empty-missing-"));
		try {
			const at = tree(root);
			const missing = join(at.home, "not-yet");
			expect(empty(missing, at.home, at.store)).toBe(0);
			expect(existsSync(missing)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
