// The demo's stand-in for use_website: one tool that runs a child agent per site, each in its own browser, and answers
// what each found. When use_website (localSites) lands, it replaces this file and nothing else.

/** `runChild(index, count, { site, task }, signal)` resolves to the child's answer. */
export function openBrowsersTool({ max, runChild }) {
  return {
    name: "open_browsers",
    label: "Open browsers",
    description: `Run one task on up to ${max} websites at once. Each site gets its own browser and its own agent, which does the task there and reports back. Answers each site's report.`,
    promptSnippet: `open_browsers: do a task on up to ${max} sites in parallel browsers`,
    executionMode: "sequential",
    promptGuidelines: [`For a task over several websites, call open_browsers once with one entry per site (at most ${max}); give each a full URL and a task that says what to report.`],
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array", minItems: 1, maxItems: max,
          items: {
            type: "object",
            properties: { site: { type: "string", description: "The site's full URL" }, task: { type: "string", description: "What to do on the site and what to report" } },
            required: ["site", "task"], additionalProperties: false,
          },
        },
      },
      required: ["tasks"], additionalProperties: false,
    },
    async execute(_callId, { tasks }, signal) {
      const chosen = tasks.slice(0, max);
      const answers = await Promise.all(chosen.map((task, index) => runChild(index, chosen.length, task, signal).catch((error) => `failed: ${String(error?.message ?? error).slice(0, 200)}`)));
      return { content: [{ type: "text", text: chosen.map((task, index) => `${index + 1}. ${task.site}\n${answers[index]}`).join("\n\n") }] };
    },
  };
}
