// The live path: the user's own model key through pi-ai, and a typed judge that asks that model the workflow's question. Nothing
// here has a default key or a fallback: with no key in the environment the run says so and stops.
import type { Context } from '@earendil-works/pi-ai';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { ModelRef } from '@earendil-works/pi-durable';
import type { SystemOneAnswer, SystemOneQuestion } from '@parcha/agentrun-dsl';
import type { Fakes } from '../reference/index.ts';
type RunJudge = Fakes['judge'];

/** Which key picks which provider and its small model. A model of another provider is named with `--model provider/id`. */
const PROVIDERS = [
  { env: 'ANTHROPIC_API_KEY', make: anthropicProvider, id: 'anthropic', model: 'claude-haiku-5-5' },
  { env: 'OPENAI_API_KEY', make: openaiProvider, id: 'openai', model: 'gpt-6-luna' },
  { env: 'GEMINI_API_KEY', make: googleProvider, id: 'google', model: 'gemini-3.7-flash' },
] as const;

export function liveModels(env: NodeJS.ProcessEnv, choice?: string): { catalog: Models; lead: ModelRef } {
  const catalog = createModels();
  const [wanted, wantedModel] = choice ? choice.split('/') : [];
  const entry = PROVIDERS.find((candidate) => (wanted ? candidate.id === wanted : Boolean(env[candidate.env])));
  if (!entry) throw new Error(wanted ? `--model ${choice}: no provider ${wanted} here (${PROVIDERS.map((p) => p.id).join(', ')})` : `--live needs a model key in the environment: ${PROVIDERS.map((p) => p.env).join(', ')}.`);
  if (!env[entry.env]) throw new Error(`--live with ${entry.id} needs ${entry.env} in the environment.`);
  catalog.setProvider(entry.make());
  const modelId = wantedModel ?? entry.model;
  if (!catalog.getModels(entry.id).some((model) => model.id === modelId)) throw new Error(`${entry.id} has no model ${modelId} in this build of pi-ai.`);
  return { catalog, lead: { provider: entry.id, modelId } };
}

const textOf = (message: { content: unknown }) => (Array.isArray(message.content) ? message.content.map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text : '')).join('') : '');

/** One request per judge node: the state, each question with its options and their criteria, and a JSON answer. A choice's
 *  confidence is the model's own stated number, kept and labelled as such in the answer; no probability is invented for
 *  the options it did not pick beyond sharing the remainder. */
export function modelJudge(catalog: Models, lead: ModelRef): RunJudge {
  return async ({ questions, state, label }) => {
    const model = catalog.getModel(lead.provider, lead.modelId);
    if (!model) throw new Error(`no model ${lead.provider}/${lead.modelId}`);
    const asked = Object.entries(questions as Record<string, SystemOneQuestion>);
    const lines = asked.map(([id, question]) => {
      if (question.type === 'choice') return `- ${id}: ${question.instructions}\n  options:\n${Object.entries(question.criteria).map(([option, criterion]) => `    ${option}${criterion ? `: ${criterion}` : ''}`).join('\n')}`;
      if (question.type === 'noul') return `- ${id}: ${question.instructions} (answer a probability of yes between 0 and 1)`;
      return `- ${id}: ${question.instructions} (a whole level from 0 to ${question.criteria.length - 1}: ${question.criteria.map((level, at) => `${at}=${level}`).join('; ')})`;
    }).join('\n');
    const context: Context = {
      systemPrompt: 'You answer typed questions about facts you are given. You use only the facts. You write JSON and nothing else.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `Facts (${label}):\n${JSON.stringify(state)}\n\nQuestions:\n${lines}\n\nAnswer with one JSON object mapping each question id to {"choice": <option>, "confidence": <0..1>} for a choice, {"yes": <0..1>} for a yes/no, or {"level": <int>, "confidence": <0..1>} for a score.` }], timestamp: Date.now() }],
    };
    const reply = await catalog.completeSimple(model, context, {});
    if (reply.stopReason === 'error') throw new Error(`the judge's model failed: ${reply.errorMessage ?? 'no message'}`);
    const text = textOf(reply);
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, { choice?: string; yes?: number; level?: number; confidence?: number }>;
    const answers: Record<string, SystemOneAnswer> = {};
    for (const [id, question] of asked) {
      const given = json[id];
      if (!given) throw new Error(`the judge's model gave no answer for ${id}`);
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        if (!given.choice || !options.includes(given.choice)) throw new Error(`the judge's model chose "${given.choice}", which is not an option of ${id}`);
        const confidence = Math.min(1, Math.max(1 / options.length, Number(given.confidence ?? 0.5)));
        answers[id] = { type: 'choice', choice: given.choice, confidence, probabilities: Object.fromEntries(options.map((option) => [option, option === given.choice ? confidence : (1 - confidence) / Math.max(1, options.length - 1)])) };
      } else if (question.type === 'noul') answers[id] = { type: 'noul', noul: Math.min(1, Math.max(0, Number(given.yes ?? 0.5))) };
      else {
        const level = Math.min(question.criteria.length - 1, Math.max(0, Math.round(Number(given.level ?? 0))));
        const confidence = Math.min(1, Math.max(0, Number(given.confidence ?? 0.5)));
        answers[id] = { type: 'score', score: level, legend: Object.fromEntries(question.criteria.map((text, at) => [String(at), text])), confidence, probabilities: Object.fromEntries(question.criteria.map((_, at) => [String(at), at === level ? confidence : (1 - confidence) / Math.max(1, question.criteria.length - 1)])) };
      }
    }
    return { answers, model: `${lead.provider}/${lead.modelId}`, usage: reply.usage ? { input_tokens: reply.usage.input, output_tokens: reply.usage.output } : null, cost_usd: reply.usage?.cost?.total ?? null, latency_ms: 0, request_sha256: '' };
  };
}
