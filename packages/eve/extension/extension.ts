import { defineExtension } from 'eve/extension';
import { z } from 'zod';
import type { EveWorkflowOptions } from './lib/workflows.js';

export default defineExtension({
  config: z.object({
    baseUrl: z.url(),
    apiKey: z.string().min(1),
    agentId: z.string().min(1).max(128),
    name: z.string().optional(),
    // The original standing policy, shared with the agent's own instructions. Never the learned supplement.
    instructions: z.string().min(1).max(64 * 1024),
    // Initial registration only. An existing agent's console setting always wins.
    // agree_on: the answer fields a connected check compares, with the server's own limits (1 to 16 distinct dotted paths
    // into the answer's JSON object, each at most 128 characters and 8 segments). Connected checks use no grader, so
    // without it the whole answer must match exactly. The list's length is a refine, not .min/.max: the union reports
    // only "Invalid input" for an array size issue.
    learning: z.union([z.boolean(), z.strictObject({
      compile_after: z.number().int().min(1).max(200).optional(),
      agree_on: z.array(z.string().max(128).regex(/^[^.]+(\.[^.]+){0,7}$/, "a dotted path into the answer's JSON object (e.g. verdict.decision): no empty segment, at most 8 segments"))
        .refine(paths => paths.length >= 1 && paths.length <= 16 && new Set(paths).size === paths.length,
          "agree_on is a list of 1 to 16 distinct dotted paths into the answer's JSON object (e.g. verdict.decision)").optional(),
    })]).default(false),
    // Host functions are runtime mount configuration, never serialized into an API request or model prompt.
    workflows: z.custom<EveWorkflowOptions>(value => !!value && typeof value === 'object').optional(),
  }),
});
