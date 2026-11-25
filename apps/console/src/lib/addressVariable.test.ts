import { describe, expect, it } from "vitest";

// A server's address has one name in an environment, AGENTRUN_BASE_URL: the one AgentRun's client and CLI read. Every
// file the server writes into someone's repository reads that name, and every page and guide that tells a person what
// to set says it. Two readers of the older AGENTRUN_URL stay, and neither tells anyone to set it: the native CLI reads
// it after AGENTRUN_BASE_URL, and `npm run dev` here takes it as its proxy's target (lib/devProxy.ts), a setting of the
// dev server's own that travels with AGENTRUN_TOKEN.
const SOURCES: Record<string, string> = {
  ...import.meta.glob("../../../../packages/serve/src/**/*.{ts,mts,mjs,txt}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../../packages/serve/{README.md,skills/**/*.md}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../../docs/**/*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../**/*.{ts,tsx,mjs}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../e2e/**/*.mjs", { query: "?raw", import: "default", eager: true }),
};
const CLIENT: Record<string, string> = import.meta.glob("../../../../packages/client/src/client.ts", { query: "?raw", import: "default", eager: true });
// The two readers, the dev proxy's tests, and this file's own words.
const OLDER_NAME_READ = ["/packages/serve/src/native/cli.ts", "/devProxy.ts", "/devProxy.test.ts", "/devProxy.http.test.ts", "/addressVariable.test.ts"];

describe("the name of a server's address", () => {
  it("is the one AgentRun's client reads", () => {
    expect(Object.values(CLIENT).join("\n")).toContain('env("AGENTRUN_BASE_URL")');
  });

  it("is never AGENTRUN_URL, wherever the server, the console or a guide says or reads it", () => {
    const files = Object.keys(SOURCES);
    for (const part of ["/packages/serve/src/suggestions.ts", "/packages/serve/README.md", "/docs/", "/components/ApiKeysPage.tsx", "/e2e/flows/"]) expect(files.some((file) => file.includes(part)), part).toBe(true);
    const said: string[] = [];
    for (const [file, text] of Object.entries(SOURCES).filter(([file]) => !OLDER_NAME_READ.some((end) => file.endsWith(end)))) {
      text.split("\n").forEach((line, i) => { if (/(?<![A-Z0-9_])AGENTRUN_URL(?![A-Z0-9_])/.test(line)) said.push(`${file.replace(/^(\.\.?\/)+/, "")}:${i + 1}`); });
    }
    expect(said).toEqual([]);
  });
});
