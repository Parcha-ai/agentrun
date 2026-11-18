import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseModel, MODEL_PROVIDER } from "../dist/model.js";
import { providerFor } from "../dist/provider.js";

test("Particle's Chat API cannot be configured as an HTTP Responses gateway", async () => {
  for (const origin of ["https://api.particle.ai/v1", "https://us.api.particle.ai/v1/"]) {
    const env = { AGENT_MODEL_BASE_URL: origin, AGENT_MODEL: "particle-1" };
    const chosen = await chooseModel(env, undefined);
    assert.match(chosen.why, /Particle.*Chat Completions.*PARTICLE_API_KEY.*particle\/particle-1.*Pi/);
    assert.throws(() => providerFor("openai-responses", env, { provider: MODEL_PROVIDER, modelId: "particle-1" }, "codex"), /Particle.*Chat Completions/);
  }
});
