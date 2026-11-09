// Sign out is this browser's; Sign out everywhere is every browser's. Two browsers signed in to one server: Sign out in
// the first leaves the second signed in (it reads its runs). The first signs in again and signs out everywhere, after the
// confirm; the second's next read finds its session gone, and the page says it was signed out.
import { check, newContext, newPage, signIn } from "../harness.mjs";

const sessionOf = (page) => page.evaluate(async () => (await (await fetch("/v2/auth/session")).json()).signed_in === true);

export default {
  name: "sign-out-scope",
  signedIn: true,
  async run({ browser, page, errors, origin }) {
    const second = await newContext(browser, origin);
    try {
      const { page: other } = await newPage(second.context);
      await signIn(other, origin);
      // Sign out: this browser only.
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      check(await sessionOf(other), "Sign out in one browser signed the other out too");
      await other.getByRole("button", { name: "Runs" }).first().click();
      await other.waitForFunction(() => location.hash.startsWith("#/runs"));
      check(!(await other.getByText("You were signed out").count()), "the other browser was told it was signed out");
      // Sign out everywhere: every browser, after its confirm.
      await signIn(page, origin);
      await page.getByRole("button", { name: "Sign out everywhere" }).click();
      const dialog = page.getByRole("alertdialog");
      check((await dialog.textContent())?.includes("Signs out every browser and phone signed in to this server, this one too.") === true, "the confirm line is not the one asked for");
      await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      // The other browser's next read finds its session ended.
      await other.getByRole("button", { name: "Agents" }).first().click();
      await other.getByText("You were signed out. Sign in to go on.").waitFor();
      check(!(await sessionOf(other)), "the other browser's session outlived Sign out everywhere");
    } finally {
      await second.context.close().catch(() => {});
    }
    // A read the page had under way as it signed out answers 401 (Chrome reports it as an error); nothing else.
    check(errors.every((e) => /401|Unauthorized/i.test(e)), `the page reported errors: ${errors.join(" | ")}`);
    errors.length = 0;
  },
};
