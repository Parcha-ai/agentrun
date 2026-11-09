// A trigger's message on the run's Timeline is labelled with the trigger in its own words, as the server names it now: a
// webhook fired by name, the same row after a rename, and after a delete the trigger's id. The console parses only the
// served row; it looks nothing up.
import { randomBytes } from "node:crypto";
import { check, tokenOf } from "../harness.mjs";

/** The Timeline row of the trigger's message, its label as text (the label's CSS may upper-case what innerText says). */
async function rowLabel(page, base, runId) {
  // A fresh load each stage: the same address again would not read the run anew.
  await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
  await page.reload();
  await page.getByRole("tab", { name: "Timeline", exact: false }).click();
  const row = page.locator("li").filter({ hasText: "Say hello." }).first();
  await row.waitFor();
  return (await row.locator("button > span > span").first().evaluate((el) => el.childNodes[0]?.textContent ?? "")).trim();
}

export default {
  name: "trigger-row-label",
  signedIn: true,
  // A webhook trigger's secret is sealed: a seal key made for this run alone, never printed.
  server: () => ({ env: { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } }),
  async run({ page, base, api, server }) {
    const name = `e2e-hook-${randomBytes(3).toString("hex")}`;
    const agent = await api("POST", "/agents", { definition: { id: "hello", name: "hello", instructions: "Say hello." } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const made = await api("POST", "/triggers", { name, source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hello", input: { content: "Say hello." }, max_cost_usd: 0.5 } });
    check(made.status === 201, `making the trigger answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.id;

    // Fire it now (one firing per Idempotency-Key; the harness's api() sends no headers of its own).
    const fired = await fetch(`${server.baseUrl}/triggers/${encodeURIComponent(id)}/fire`, { method: "POST", headers: { authorization: `Bearer ${await tokenOf(server)}`, "idempotency-key": `e2e-${randomBytes(4).toString("hex")}` } });
    check(fired.status === 202, `firing answered ${fired.status}: ${await fired.clone().text()}`);
    let runId = (await fired.json()).run_id;
    // The firing's run, once it has started one: the trigger's last_run_id.
    for (let i = 0; !runId && i < 50; i++) {
      runId = (await api("GET", `/triggers/${encodeURIComponent(id)}`)).body?.last_run_id;
      if (!runId) await new Promise((r) => setTimeout(r, 200));
    }
    check(!!runId, "the firing started no run");

    check(await rowLabel(page, base, runId) === `Webhook ${name}`, `the fired row's label is not "Webhook ${name}"`);

    // Renamed: the row follows the trigger's name as it is now.
    const renamed = await api("PATCH", `/triggers/${encodeURIComponent(id)}`, { name: `${name}-renamed` });
    check(renamed.status === 200, `renaming answered ${renamed.status}`);
    const afterRename = await rowLabel(page, base, runId);
    check(afterRename === `Webhook ${name}-renamed`, `the renamed row's label reads ${JSON.stringify(afterRename)}`);

    // Deleted: the row falls back to the trigger's id, as the server says it.
    const deleted = await api("DELETE", `/triggers/${encodeURIComponent(id)}`);
    check(deleted.status === 204, `deleting answered ${deleted.status}`);
    const afterDelete = await rowLabel(page, base, runId);
    check(afterDelete === `Webhook ${id}`, `the deleted trigger's row label reads ${JSON.stringify(afterDelete)}`);
  },
};
