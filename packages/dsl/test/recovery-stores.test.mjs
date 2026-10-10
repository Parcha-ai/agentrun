// The two stores the package ships, held to the store contract by the conformance suite a host runs on its own store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileStore, memoryStore } from '@parcha/agentrun-dsl/recovery';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';

const root = mkdtempSync(join(tmpdir(), 'agentrun-recovery-stores-'));
after(() => rmSync(root, { recursive: true, force: true }));

registerStoreConformance('memory store', () => memoryStore());
registerStoreConformance('file store', () => fileStore(mkdtempSync(join(root, 'run-'))));
