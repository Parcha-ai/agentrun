// Copy to support.config.mjs in your AgentRun checkout. This is trusted server code.
// Replace these two stubs with the existing host's real adapters before live execution.
// No fake responses or replacement model/provider are supplied.
export default {
  timeoutMs: 60_000,
  jev: {
    // Reuses TYPESAFE_API_KEY and TYPESAFE_BASE_URL from the workflow process.
    // A saved .env file is not loaded automatically: use your project's env loader.
    // Alternatively: apiKey: await yourSecretLoader('jev-api-key'),
    timeoutMs: 30_000,
    maxAttempts: 1,
  },
  async runEffect(params) {
    // params.node.tool must be 'help.search'; params.input is { request }.
    // Return { text: 'candidate answer', sources: ['source-reference'] }.
    // If search finds nothing, return { text: '', sources: [] }; the workflow investigates.
    // Forward signal/deadline/idempotency information to the host tool adapter.
    // Scope any account access to the authenticated user in your host.
    throw new Error('Wire help.search to your existing host tool adapter.');
  },
  async runNode(params) {
    // Forward ALL params to your existing agent adapter: system, user, schema,
    // tools, signal, and review when present. Return { text, sources } directly.
    // Register a read-only support.read tool explicitly; installing the DSL does not add it.
    // Keep model access, permissions, turns, and budgets in your existing harness.
    // A review rejection must continue the same session or fail explicitly.
    // For pi: use createPiRunner(configuredPiOptions) with support.read registered.
    throw new Error('Wire runNode to your existing authenticated agent runtime.');
  },
};
