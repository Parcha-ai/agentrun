// A project directory for a test that runs a workflow through the extension: a run keeps its journal under
// <cwd>/.pi/agentrun/runs, so that directory must not be the package's. It is removed when the test process exits.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tempCwd = mkdtempSync(join(tmpdir(), 'agentrun-test-cwd-'));
process.on('exit', () => rmSync(tempCwd, { recursive: true, force: true }));
