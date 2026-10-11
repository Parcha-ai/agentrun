// The budgets: the defaults are pi-ai's own registry profile, a model's `inputLimits` are read from the real registry
// entries, and a host's route limits combine with them as documented. Nothing malformed becomes a limit of zero.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { DEFAULT_LIMITS, DEFAULT_REQUEST_BYTES, DEFAULT_VIDEO_INLINE_BYTES, IMAGES_PER_CALL, PAGES_PER_READ, REQUEST_HEADROOM_BYTES, limitsFromModel, resolveLimits } from "@parcha/pi-vision";

const MiB = 1024 * 1024;
const models = (catalog) => Object.values(catalog);
const withImages = (catalog) => models(catalog).filter((m) => m.inputLimits?.images?.resize);

test("the default image limits are the resize profile of every image model pi-ai ships for Anthropic, OpenAI and Google", () => {
  const all = [...withImages(ANTHROPIC_MODELS), ...withImages(OPENAI_MODELS), ...withImages(GOOGLE_MODELS)];
  assert.ok(all.length > 10, "the registry has image models to compare with");
  for (const model of all) {
    const { image } = resolveLimits(model);
    assert.deepEqual({ ...image }, { ...DEFAULT_LIMITS.image }, model.id);
    assert.deepEqual(limitsFromModel(model).image, { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 }, model.id);
  }
});

test("with no model and no host, the limits are the defaults", () => {
  assert.deepEqual(resolveLimits(undefined), { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image }, video: { ...DEFAULT_LIMITS.video } });
  assert.equal(DEFAULT_LIMITS.requestBytes, DEFAULT_REQUEST_BYTES);
  assert.equal(DEFAULT_LIMITS.imagesPerCall, IMAGES_PER_CALL);
  assert.equal(DEFAULT_LIMITS.pagesPerRead, PAGES_PER_READ);
  assert.equal(DEFAULT_LIMITS.video.inlineBytes, DEFAULT_VIDEO_INLINE_BYTES);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS) && Object.isFrozen(DEFAULT_LIMITS.image) && Object.isFrozen(DEFAULT_LIMITS.video));
});

test("the request budget is the smallest known cap less the headroom, and inline video is 60% of it after base64", () => {
  const google = withImages(GOOGLE_MODELS).find((m) => m.inputLimits.maxRequestBytes === 20 * MiB);
  const anthropic = withImages(ANTHROPIC_MODELS).find((m) => m.inputLimits.maxRequestBytes === 32 * MiB);
  assert.ok(google && anthropic);
  assert.equal(resolveLimits(google).requestBytes, 20 * MiB - REQUEST_HEADROOM_BYTES);
  assert.equal(resolveLimits(google).video.inlineBytes, Math.floor((20 * MiB - REQUEST_HEADROOM_BYTES) * 0.6 * 3 / 4));
  // A gateway's cap below the model's wins; one above it does not.
  assert.equal(resolveLimits(anthropic, { requestBytes: 20 * MiB }).requestBytes, 19 * MiB);
  assert.equal(resolveLimits(google, { requestBytes: 64 * MiB }).requestBytes, 19 * MiB);
  // A host cap with no model cap is the only cap.
  assert.equal(resolveLimits(undefined, { requestBytes: 10 * MiB }).requestBytes, 9 * MiB);
});

test("images per call never pass the model's own per-message limit", () => {
  const bedrock = models(AMAZON_BEDROCK_MODELS).find((m) => m.inputLimits?.images?.maxPerMessage === 20);
  assert.ok(bedrock, "the registry has a model with a per-message image limit");
  assert.equal(resolveLimits(bedrock).imagesPerCall, IMAGES_PER_CALL);
  assert.equal(resolveLimits(bedrock, { imagesPerCall: 30 }).imagesPerCall, 20);
  assert.equal(resolveLimits(bedrock, { imagesPerCall: 4 }).imagesPerCall, 4);
});

test("a host's values replace the model's, field by field; video is native only when the host says so", () => {
  const model = withImages(ANTHROPIC_MODELS)[0];
  const limits = resolveLimits(model, { image: { maxWidth: 1568 }, pagesPerRead: 2, video: { native: true } });
  assert.deepEqual({ ...limits.image }, { maxWidth: 1568, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 });
  assert.equal(limits.pagesPerRead, 2);
  assert.equal(limits.video.native, true);
  assert.equal(resolveLimits(model, { video: { native: "yes" } }).video.native, false);
});

test("a missing, zero, negative or malformed limit is absent, never a limit", () => {
  const broken = { inputLimits: { maxRequestBytes: 0, images: { maxPerMessage: -1, resize: { maxWidth: "2000", maxHeight: Number.NaN, maxBytes: Infinity, jpegQuality: null } } } };
  assert.deepEqual(limitsFromModel(broken), {});
  for (const model of [null, undefined, 42, "model", {}, { inputLimits: null }, { inputLimits: { images: 3 } }]) assert.deepEqual(limitsFromModel(model), {}, String(model));
  const limits = resolveLimits(broken, { image: { maxWidth: 0 }, imagesPerCall: Number.NaN, requestBytes: -5 });
  assert.equal(limits.image.maxWidth, 2000);
  assert.equal(limits.imagesPerCall, IMAGES_PER_CALL);
  assert.equal(limits.requestBytes, DEFAULT_REQUEST_BYTES);
});
