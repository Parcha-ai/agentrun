// Sign in after setup: a second browser (no cookies) sees the sign-in page, a wrong password is refused in words, and the
// owner's password signs it in to the console.
import { check, newContext, newPage, PASSWORD, setUp, signedIn } from "../harness.mjs";

export default {
  name: "sign-in",
  async run({ page, browser, origin }) {
    await setUp(page, origin);
    // Another browser, with none of the first one's cookies.
    const { context: other, blocked } = await newContext(browser, origin);
    try {
      const { page: second, errors } = await newPage(other);
      await second.goto(`${origin}/`);
      await second.getByRole("heading", { name: "Sign in" }).waitFor();
      await second.getByLabel("Password", { exact: true }).fill("not-the-password-at-all");
      const refused = second.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/auth/sign-in");
      await second.getByRole("button", { name: "Continue" }).click();
      check(!(await refused).ok(), "a wrong password was taken");
      await second.getByRole("alert").waitFor();
      await second.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await second.getByRole("button", { name: "Continue" }).click();
      await signedIn(second);
      // A wrong password's refusal is the one error this page reports (its 401 response); nothing else.
      check(errors.every((e) => /401|Unauthorized/i.test(e)), `the sign-in page reported errors: ${errors.join(" | ")}`);
      check(blocked.length === 0, `requests left loopback: ${blocked.join(", ")}`);
    } finally {
      await other.close();
    }
  },
};
