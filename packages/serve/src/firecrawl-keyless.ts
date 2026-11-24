// Keyless Firecrawl's faux switch. The provider itself (Firecrawl's public MCP endpoint, its search and its scrape) is
// @parcha/agentrun-web's providers/firecrawl-keyless.ts; serve names where a test's fake answers in its place.

/** Under `--faux` only: the URL of a fake MCP server (a test's, on loopback) asked in place of Firecrawl's endpoint.
 *  Under --faux with none named, Firecrawl is never asked. */
export const FAUX_FIRECRAWL_ENV = "AGENTRUN_SERVE_FAUX_FIRECRAWL";
