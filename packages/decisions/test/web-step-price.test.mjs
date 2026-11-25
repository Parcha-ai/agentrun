// Each arm's price for web's classifier step (deciderFrom's `price`): what the run's cap holds a request at before it
// is sent, the most it may cost.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JEV_PUBLISHED_PRICING } from '../../jev/dist/index.js';
import { ANTHROPIC_PUBLISHED_PRICING, ANTHROPIC_SYSTEM, anthropicDecisionPrice, PARALLEL_DECISION_PRICE, PARALLEL_LIST_PRICE_USD } from '../dist/index.js';

test("each arm's price: Parallel's list price per request, Jev's per input token, Claude's per token with its system prompt, its schema and its most output", () => {
  assert.deepEqual(PARALLEL_DECISION_PRICE, { requestUsd: PARALLEL_LIST_PRICE_USD });
  assert.deepEqual(JEV_PUBLISHED_PRICING, { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 });
  assert.deepEqual(anthropicDecisionPrice(), { ...ANTHROPIC_PUBLISHED_PRICING['claude-haiku-5-5'], maxOutputTokens: 8192, inputTokensPerByte: 2, extraInputTokens: Buffer.byteLength(ANTHROPIC_SYSTEM) + 1024 });
  assert.deepEqual(anthropicDecisionPrice('claude-sonnet-9', { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 }), { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10, maxOutputTokens: 8192, inputTokensPerByte: 2, extraInputTokens: Buffer.byteLength(ANTHROPIC_SYSTEM) + 1024 });
  assert.equal(anthropicDecisionPrice('claude-unpriced-9'), undefined);
});
