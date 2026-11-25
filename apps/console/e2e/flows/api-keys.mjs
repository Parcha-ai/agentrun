// Settings → AgentRun API keys, in a real browser on the built server. The owner's password session makes a key: the page
// shows it once, and an app that sends it reads /v2. After Done the key is nowhere in the page, a reload included, where
// its row says it was used. A token, and the key itself, is refused making another, in the server's words. Revoked from
// the page, asked first, the key opens nothing.
// E2E_SHOTS=<dir> also saves the page in both themes: a new key shown, the revoke question, and the page at 390px.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check } from "../harness.mjs";

const NAMES = { light: "billing app", dark: "support bot" };

export default {
  name: "api-keys",
  signedIn: true,
  async run({ page, origin, api, errors }) {
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const shoot = async (name) => { if (shots) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(shots, name), fullPage: true }); } };
    const withKey = (key, path = "/v2/agents", init = {}) => fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
    const made = page.locator('[aria-label="New API key"]');
    const rows = page.locator('[aria-label="Keys"] li');
    const keys = {};

    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${origin}/#/settings/api-keys`);
      await page.reload();
      await page.getByRole("heading", { name: "AgentRun API keys", level: 1 }).waitFor();
      check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `the page is not in the ${theme} theme`);
      check((await page.getByRole("link", { name: "AgentRun API keys" }).getAttribute("aria-current")) === "page", "the Settings tab is not marked as the open page");

      // Made by its name: the answer's key is on the page, with the two lines an app's environment takes.
      await page.getByLabel("Name", { exact: true }).fill(NAMES[theme]);
      const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/settings/api-keys");
      await page.getByRole("button", { name: "Create key", exact: true }).click();
      const answer = await posted;
      check(answer.status() === 201, `the create answered ${answer.status()}: ${await answer.text()}`);
      await made.waitFor();
      const key = (await made.locator("code").textContent()) ?? "";
      check(/^ar_key_[A-Za-z0-9_-]{43}$/.test(key), "the page shows no key where the new one should be");
      check(((await made.getByLabel("Environment variables").textContent()) ?? "") === `AGENTRUN_BASE_URL=${origin}/v2\nAGENTRUN_API_KEY=${key}`, "the environment lines are not this server's API address and the new key");
      keys[theme] = key;
      await shoot(`api-keys-${theme}-1440-made.png`);

      // The key opens the API, as an app would send it.
      const opened = await withKey(key);
      check(opened.status === 200, `the new key read /v2/agents as ${opened.status}`);

      // Done: the key is nowhere in the page, and a reload does not bring it back; its row says it was used.
      await made.getByRole("button", { name: "Done", exact: true }).click();
      await made.waitFor({ state: "detached" });
      check(!(await page.content()).includes(key), "the key is still in the page after Done");
      await page.reload();
      const row = rows.filter({ hasText: NAMES[theme] });
      await row.getByText(/^Last used /).waitFor();
      check(!(await page.content()).includes("ar_key_"), "a reload shows a key");

      // From `lg` each date has a column of its own: the widest date a row can say fits it on one line. Measured in the
      // page's own fonts, so once they have loaded: a fallback font's widths are not the page's.
      await page.evaluate(() => document.fonts.ready);
      const cut = await row.evaluate((li) => {
        const short = (start, text) => {
          const column = [...li.querySelectorAll("span")].find((s) => s.children.length === 0 && s.textContent.startsWith(start));
          const probe = column.cloneNode(false);
          probe.textContent = text;
          probe.style.cssText = "position:absolute;visibility:hidden;width:auto;white-space:nowrap";
          column.parentElement.append(probe);
          const [needs, has] = [probe.getBoundingClientRect().width, column.getBoundingClientRect().width];
          probe.remove();
          return needs <= has ? [] : [`"${text}" needs ${Math.ceil(needs)}px of ${Math.round(has)}px`];
        };
        return [...short("Created ", "Created May 30, 10:00 AM"), ...short("Last used ", "Last used May 30, 10:00 AM")];
      });
      check(cut.length === 0, `${theme} 1440px: a date wraps in its column: ${cut.join("; ")}`);

      // Revoke is asked first; Cancel keeps the key.
      await row.getByRole("button", { name: `Revoke ${NAMES[theme]}`, exact: true }).click();
      const ask = page.getByRole("alertdialog", { name: `Revoke ${NAMES[theme]}?` });
      await ask.waitFor();
      await shoot(`api-keys-${theme}-1440-revoke.png`);
      await ask.getByRole("button", { name: "Cancel", exact: true }).click();
      await ask.waitFor({ state: "detached" });
      check((await withKey(key)).status === 200, "the key stopped opening after a cancelled revoke");

      await page.setViewportSize({ width: 390, height: 1000 });
      await page.getByRole("heading", { name: "AgentRun API keys", level: 1 }).waitFor();
      check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${theme} 390px: the page scrolls sideways`);
      await shoot(`api-keys-${theme}-390.png`);
    }

    // A token never makes a key, and neither does a key: 403, in the server's one refusal, with where the owner does it.
    const byToken = await api("POST", "/settings/api-keys", { name: "by the token" });
    check(byToken.status === 403, `the token's create answered ${byToken.status}`);
    check(JSON.stringify(byToken.body).includes("the API token can't write secrets"), `the token's refusal said ${JSON.stringify(byToken.body)}`);
    const byKey = await withKey(keys.light, "/v2/settings/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "by a key" }) });
    check(byKey.status === 403, `a key's create answered ${byKey.status}`);
    check(String((await byKey.json()).error?.details?.console_url).endsWith("/#/settings/api-keys"), "a key's refusal does not name the console's page");
    check((await rows.count()) === 2, `the page lists ${await rows.count()} keys after two refused creates`);

    // Revoked from the page: the next request with it is 401; the other key still opens.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const row = rows.filter({ hasText: NAMES.light });
    await row.getByRole("button", { name: `Revoke ${NAMES.light}`, exact: true }).click();
    const deleted = page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.startsWith("/v2/settings/api-keys/"));
    await page.getByRole("alertdialog", { name: `Revoke ${NAMES.light}?` }).getByRole("button", { name: "Revoke the key", exact: true }).click();
    check((await deleted).status() === 204, "the revoke did not answer 204");
    await row.waitFor({ state: "detached" });
    check((await withKey(keys.light)).status === 401, "the revoked key still opens the API");
    check((await withKey(keys.dark)).status === 200, "the other key stopped opening");
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};
