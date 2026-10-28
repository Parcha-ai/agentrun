// run code is the body of an async function. Code written as one function expression is called, so its value comes
// back; statement code runs as it always did. Each case runs the transformed code the way the Stagehand facade does:
// as the body of an AsyncFunction with page in scope.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnableCode } from "../dist/index.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = async (code, page = { visited: [], async goto(url) { this.visited.push(url); }, async title() { return "Page A"; } }) => ({ value: await new AsyncFunction("page", runnableCode(code))(page), page });

test("a zero-parameter function expression is called and its value returned: the exact code a model sent", async () => {
  assert.equal((await run('async () => {\n  return "hello world";\n}')).value, "hello world");
  const { value, page } = await run('async () => {\n  await page.goto("http://c-l-dui.com", { waitUntil: "networkidle" });\n  const title = await page.title();\n  return { title };\n}');
  assert.deepEqual([value, page.visited], [{ title: "Page A" }, ["http://c-l-dui.com"]], "its steps run against the page in scope");
  assert.equal((await run("async function () { return 7; };\n")).value, 7, "a function expression with a trailing semicolon too");
  assert.equal((await run("() => 'plain arrow'")).value, "plain arrow");
});

test("any code that is not one function expression reaches the driver unchanged and runs as before", async () => {
  const body = 'await page.goto("https://a.test/");\nreturn await page.title();';
  assert.equal(runnableCode(body), body);
  assert.equal((await run(body)).value, "Page A");
  for (const same of ['await page.goto("https://b.test/")', "await page.click('#other')", "(await page.title())", "   "]) assert.equal(runnableCode(same), same, `${same} reaches the driver unchanged`);
  const { value, page } = await run('await page.goto("https://b.test/")');
  assert.deepEqual([value, page.visited], [undefined, ["https://b.test/"]]);
  assert.equal(runnableCode("async () => {} ; foo()"), "async () => {} ; foo()", "a function followed by more statements is statement code");
});

test("a function that declares parameters fails with the body form spelled out, never silently", async () => {
  await assert.rejects(run("async ({ page }) => { await page.goto('https://a.test/'); }"), /function that takes parameters.*page, context and browser are already in scope/s);
});
