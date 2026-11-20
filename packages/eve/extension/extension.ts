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
    learning: z.union([z.boolean(), z.strictObject({
      compile_after: z.number().int().min(1).max(200).optional(),
    })]).default(false),
    // Host functions are runtime mount configuration, never serialized into an API request or model prompt.
    workflows: z.custom<EveWorkflowOptions>(value => !!value && typeof value === 'object').optional(),
  }),
});
