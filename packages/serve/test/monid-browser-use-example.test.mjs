import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { monidClient } from "../dist/monid.js";

const tutorial = new URL("../../../docs/tutorials/monid-browser-use.md", import.meta.url);
const grant = "monid:browseruse/agent/run";
const key = "fake-monid-key";
const task = "Open https://example.com and return the page heading as text. Read the page only.";

for (const providerStatus of [200, 404]) {
  test(`the Browser Use tutorial sends its bounded input and handles provider status ${providerStatus}`, async () => {
    const markdown = await readFile(tutorial, "utf8");
    assert.ok(markdown.includes(grant));
    const [, provider, endpoint] = /^monid:([^/]+)(\/.*)$/.exec(grant);
    const input = JSON.parse(markdown.match(/```json\n([\s\S]+?)\n```/)[1]);
    const requests = [];
    const runId = "browser-use-test";
    const output = { result: "Example Domain" };
    const answer = await monidClient({
      key,
      sleep: async () => {},
      async fetch(url, init) {
        requests.push({
          path: new URL(url).pathname,
          method: init.method,
          authorization: init.headers.authorization,
          body: init.body && JSON.parse(init.body),
        });
        if (requests.length === 1) return Response.json({ runId }, { status: 202 });
        return Response.json({
          runId,
          status: "COMPLETED",
          ...(providerStatus === 200 ? { output } : { providerResponse: { httpStatus: 404, error: { message: "Page not found" } } }),
        });
      },
    }).run({ provider, endpoint, input });
    assert.deepEqual(requests, [
      {
        path: "/v1/run",
        method: "POST",
        authorization: `Bearer ${key}`,
        body: { provider: "browseruse", endpoint: "/agent/run", input: { body: { task, maxCostUsd: 2 } } },
      },
      { path: `/v1/runs/${runId}`, method: "GET", authorization: `Bearer ${key}`, body: undefined },
    ]);
    if (providerStatus === 200) assert.deepEqual(answer.output, output);
    else {
      assert.equal(answer.status, 404);
      assert.match(answer.error, /the provider answered 404: Page not found/);
      assert.equal(answer.output, undefined);
    }
  });
}
