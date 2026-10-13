// An assistant's words are markdown, and the chat showed the raw asterisks. A safe subset is read into a small tree (bold, italics, inline code, lists, paragraphs, fenced code); the page builds elements from
// it with textContent, so nothing the model wrote is ever parsed as HTML. Links, images and raw HTML are not part of the subset: they stay the characters they were.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, plainText, type Block, type Inline } from "../tab/markdown.ts";

const t = (v: string): Inline => ({ t: "text", v });
const p = (...c: Inline[]): Block => ({ t: "p", c });

test("bold, italics and inline code", () => {
  assert.deepEqual(parseMarkdown("Try **lemon-garlic pasta** with *spinach* and `rice`."), [p(t("Try "), { t: "b", c: [t("lemon-garlic pasta")] }, t(" with "), { t: "i", c: [t("spinach")] }, t(" and "), { t: "code", v: "rice" }, t("."))]);
  assert.deepEqual(parseMarkdown("a **WebAssembly sandbox inside your browser tab**"), [p(t("a "), { t: "b", c: [t("WebAssembly sandbox inside your browser tab")] })]);
  assert.deepEqual(parseMarkdown("**bold with `code` inside**"), [p({ t: "b", c: [t("bold with "), { t: "code", v: "code" }, t(" inside")] })]);
  assert.deepEqual(parseMarkdown("`**not bold**`"), [p({ t: "code", v: "**not bold**" })], "code is literal");
});

test("what is not closed, or not emphasis, stays as typed (a streaming answer is half a sentence)", () => {
  assert.deepEqual(parseMarkdown("so **this is not clos"), [p(t("so **this is not clos"))]);
  assert.deepEqual(parseMarkdown("2 * 3 * 4"), [p(t("2 * 3 * 4"))], "spaces after the star: multiplication");
  assert.deepEqual(parseMarkdown("snake_case_name and a_b"), [p(t("snake_case_name and a_b"))]);
  assert.deepEqual(parseMarkdown("a `tick"), [p(t("a `tick"))]);
});

test("paragraphs, line breaks, lists and a fenced block", () => {
  assert.deepEqual(parseMarkdown("one\ntwo\n\nthree"), [p(t("one"), { t: "br" }, t("two")), p(t("three"))]);
  assert.deepEqual(parseMarkdown("Steps:\n- boil **water**\n- add pasta\n\nDone."), [p(t("Steps:")), { t: "ul", items: [[t("boil "), { t: "b", c: [t("water")] }], [t("add pasta")]] }, p(t("Done."))]);
  assert.deepEqual(parseMarkdown("1. a\n2. b"), [{ t: "ol", items: [[t("a")], [t("b")]] }]);
  assert.deepEqual(parseMarkdown("* x\n+ y"), [{ t: "ul", items: [[t("x")], [t("y")]] }]);
  assert.deepEqual(parseMarkdown("```js\nconst a = **1**;\n```\nafter"), [{ t: "pre", v: "const a = **1**;" }, p(t("after"))]);
  assert.deepEqual(parseMarkdown("```\nnever closed"), [{ t: "pre", v: "never closed" }], "a streaming fence shows what it has");
  assert.deepEqual(parseMarkdown("## A heading"), [p({ t: "b", c: [t("A heading")] })]);
  assert.deepEqual(parseMarkdown(""), []);
});

test("HTML, links and images are never interpreted: they are the characters the model wrote", () => {
  for (const evil of ['<img src=x onerror="alert(1)">', "<script>alert(1)</script>", "[click](javascript:alert(1))", "![pic](http://x/y.png)", "**<b>x</b>**"]) {
    const blocks = parseMarkdown(evil);
    assert.equal(plainText(blocks).replace(/\*\*/g, ""), evil.replace(/\*\*/g, ""), `${evil} reads back as the text it was`);
    assert.ok(!JSON.stringify(blocks).match(/"t":"(a|img|html)"/), "no link, image or html node exists in the tree");
  }
});
