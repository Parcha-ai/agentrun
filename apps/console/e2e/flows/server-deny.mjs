// A server deny in Settings → Tools: set through the API (PUT /v2/settings/tools), its row says it holds for every agent,
// and a tool left at allow says nothing of the kind.
import { check } from "../harness.mjs";

const LINE = "Refused on this server for every agent, whatever the agent's own setting or Never ask.";

export default {
  name: "server-deny",
  signedIn: true,
  async run({ page, base, api, errors }) {
    const saved = await api("PUT", "/settings/tools", { bash: { permission: "deny" } });
    check(saved.status === 200, `PUT /v2/settings/tools answered ${saved.status}: ${JSON.stringify(saved.body)}`);
    await page.goto(`${base}/#/settings/tools`);
    const bash = page.locator('tr[data-tool="bash"]');
    await bash.getByText(LINE).waitFor();
    check((await bash.locator('select[aria-label="bash permission"]').inputValue()) === "deny", "bash's permission doesn't read deny");
    check((await page.locator('tr[data-tool="read"]').getByText(LINE).count()) === 0, "read, at allow, says the server's deny line");
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};
