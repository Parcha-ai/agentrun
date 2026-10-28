// The Claude column of the schema-parity table: over the shared corpus (@parcha/agentrun-adapters/testing,
// SCHEMA_CORPUS), whether each schema reaches the model whole (carried) or is refused, and why, as reviewed in
// fixtures/schema-parity.claude.json. A change in either the corpus or the bridge shows here as a row. What is carried
// round-trips: its example is accepted, and without each required field it is not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { schemaHash } from '@parcha/agentrun-adapters';
import { zodFromJsonSchema } from '@parcha/agentrun-adapters/process';
import { SCHEMA_CORPUS } from '@parcha/agentrun-adapters/testing';
import { toolSchemaProblems } from '@parcha/agentrun-claude-agent';

const reviewed = JSON.parse(readFileSync(new URL('./fixtures/schema-parity.claude.json', import.meta.url), 'utf8'));

test('every schema of the shared corpus has its reviewed Claude result, by hash: carried, or refused saying where', () => {
  assert.deepEqual(SCHEMA_CORPUS.map((e) => e.hash), SCHEMA_CORPUS.map((e) => schemaHash(e.schema)), 'each hash is its schema\'s');
  const now = SCHEMA_CORPUS.map((e) => { const p = toolSchemaProblems(e.schema); return { hash: e.hash, source: e.source, claude: p.length ? { refused: p } : 'carried' }; });
  assert.deepEqual(now, reviewed);
});

test("pydantic's own shapes are carried: local $refs into $defs, Optional as anyOf with null, enums by $ref, defaults and titles", () => {
  const pydantic = SCHEMA_CORPUS.filter((e) => e.source.startsWith('pydantic'));
  assert.ok(pydantic.length >= 2 && pydantic.some((e) => JSON.stringify(e.schema).includes('"$ref":"#/$defs/')), 'the corpus has a pydantic schema with local refs');
  for (const e of pydantic) assert.deepEqual(toolSchemaProblems(e.schema), [], e.source);
});

test('what is carried round-trips: its example is accepted, and without each required field it is not', () => {
  for (const e of SCHEMA_CORPUS.filter((x) => x.example !== undefined && toolSchemaProblems(x.schema).length === 0)) {
    const zod = zodFromJsonSchema(e.schema, z);
    const fits = zod.safeParse(e.example);
    assert.equal(fits.success, true, `${e.source}: ${JSON.stringify(fits.error?.issues ?? []).slice(0, 300)}`);
    for (const field of e.schema.required ?? []) {
      const { [field]: _, ...missing } = e.example;
      assert.equal(zod.safeParse(missing).success, false, `${e.source}: without ${field}`);
    }
  }
});
