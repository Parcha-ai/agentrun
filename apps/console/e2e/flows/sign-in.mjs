// Sign in on a server whose owner is set: a browser with no session sees the sign-in page, a wrong password is refused in
// words, and the owner's password signs it in to the console. Runs against a running server too (its owner set through
// the API first when it has none).
import { check, owner, PASSWORD, signedIn } from "../harness.mjs";

export default {
  name: "sign-in",
  shares: true,
  async run({ server, page, errors, origin }) {
    await owner(server);
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await page.getByLabel("Password", { exact: true }).fill(`${PASSWORD}-wrong`);
    const refused = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/auth/sign-in");
    await page.getByRole("button", { name: "Continue" }).click();
    check(!(await refused).ok(), "a wrong password was taken");
    await page.getByRole("alert").waitFor();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await signedIn(page);
    // A wrong password's refusal is the one error this page reports (its 401 response); nothing else.
    check(errors.every((e) => /401|Unauthorized/i.test(e)), `the sign-in page reported errors: ${errors.join(" | ")}`);
    errors.length = 0;
  },
};
