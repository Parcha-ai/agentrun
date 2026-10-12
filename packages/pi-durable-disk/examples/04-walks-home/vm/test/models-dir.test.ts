// live's --models-dir: resolved once to an absolute path, and only a folder that holds the model's parts manifest is accepted.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveModelsDir } from "../models-dir.ts";

test("a relative folder is resolved against the working directory it was given from, to an absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "models-dir-"));
  try {
    mkdirSync(join(root, "models", "v5"), { recursive: true });
    writeFileSync(join(root, "models", "v5", "m.parts.json"), "{}");
    assert.equal(resolveModelsDir("models/v5", root), join(root, "models", "v5"));
    assert.equal(resolveModelsDir(join(root, "models", "v5"), "/somewhere/else"), join(root, "models", "v5"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing path, a regular file and a folder without a parts manifest are each an error that says which", () => {
  const root = mkdtempSync(join(tmpdir(), "models-dir-"));
  try {
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "file.parts.json"), "{}");
    assert.throws(() => resolveModelsDir("nope", root), /no such folder/);
    assert.throws(() => resolveModelsDir("file.parts.json", root), /is a file, not a folder/);
    assert.throws(() => resolveModelsDir("empty", root), /holds no model \(no \*\.parts\.json manifest\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
