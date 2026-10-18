---
name: verify
description: Check that a PDF has the marks a checklist names (a seal, a signature, a stamp, a number, two numbers that must agree), each answered yes or no with where it is on its page, cited as file.pdf#page=N&xywh=percent:x,y,w,h. Jev tells the kind of each page, whether each mark is there and its box. Use when a question asks whether a document (a certificate, a licence, a filed form) has what a document of its kind should have; another kind of document is another checklist file, not other code.
---

# Verify a document against a checklist of marks

The checklist is a file: the kinds of page the document has and the marks to look for on them. The two steps below
check any PDF against any checklist; nothing in them names a kind of document. They answer whether each mark is
there and where, not whether the document is genuine: a copy, a specimen or a forgery can carry every mark.

## The checklist

```json
{
  "document": "A certified copy of a filed certificate",
  "pages": {
    "certification": "The certification page: the issuing office's name at the top and 'DO HEREBY CERTIFY' in the body.",
    "filed": "The first page of the filed certificate, with the filing office's stamp at the top."
  },
  "marks": [
    { "id": "seal", "page": "certification", "mark": "The office's seal", "present": "A round seal at the foot of the page.",
      "question": "Is there a round official seal in `images[0].image`?", "box": "the round seal in `images[0].image`" },
    { "id": "file_number", "page": "certification", "mark": "The file number", "present": "A file number at the bottom left.",
      "question": "Is there a file number in `images[0].image`?", "box": "the file number in `images[0].image`" },
    { "id": "stamp", "page": "filed", "mark": "The FILED stamp", "present": "A block reading FILED with a date, time and file number.",
      "question": "Is there a FILED stamp with a date and a file number in `images[0].image`?", "box": "the FILED stamp in `images[0].image`" },
    { "id": "numbers_match", "same": ["file_number", "stamp"], "mark": "The file numbers agree",
      "present": "The certification page's file number is the one in the stamp.",
      "question": "Is the file number in `images[0].image` the same number as the file number in `images[1].image`?" }
  ]
}
```

- `pages`: each kind of page a mark sits on, said the way it looks. A page that is none of them is `other`.
- `marks`: `id` is the mark's short name. Jev's yes-or-no question about it is asked under that name and its box under
  `<id>_at`, so keep it short, in letters, digits and `_`. `page` is the kind of page it sits on, `question` asks whether
  it is there, `box` names it for the box, and `present` says what it looks like when it is there (the row's note).
- A mark with `same: [a, b]` instead of `page` asks whether two marks show the same thing, such as one number on two
  pages: both are cut out of their pages, larger, and asked about side by side. It is a no when either is not there.
- Write each question about `images[0].image`, and a `same` mark's about `images[0].image` and `images[1].image`.

## 1. Every page: its kind, and each mark's yes or no and box

Render the pages through their crop box (`-cropbox`): that is the page a PDF viewer shows, so a box in percent of the
rendered image is the same box in percent of the page in PDF.js or any other viewer. Without it, `pdftoppm` draws the
media box, which can be larger, and every box would be off on such a file. Then one Jev request a page: which kind of
page it is, and every mark's question and box, at a small fraction of a cent a page. Name each image by its page
(`file.pdf#page=N`), so each box comes back as `file.pdf#page=N&xywh=percent:x,y,w,h`.

```js
const task = { document: "certificate.pdf", checklist: "checklist.json" };
const sh = async (command) => {
  const ran = await tools.bash({ command });
  if (typeof ran === "string") return ran;
  if (ran.exitCode) throw new Error(ran.output);
  return ran.output;
};
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const dir = `.verify/${task.document.replace(/[^\w.-]+/g, "_")}`;
const list = JSON.parse(await sh(`cat ${q(task.checklist)}`));
await sh(`rm -rf ${q(dir)} && mkdir -p ${q(dir)}/pages && pdftoppm -cropbox -r 100 -png ${q(task.document)} ${q(dir)}/pages/p`);
const files = (await sh(`ls ${q(dir)}/pages`)).split("\n").filter((name) => name.endsWith(".png")).sort();
const onPage = list.marks.filter((mark) => mark.page);
const pages = [];
for (const name of files) {
  const page = parseInt(name.match(/(\d+)\.png$/)[1], 10);
  const questions = { kind: { type: "choice", instructions: "Which kind of page is `images[0].image`?", criteria: { ...list.pages, other: "None of the kinds above." } } };
  for (const mark of onPage) {
    questions[mark.id] = { type: "noul", instructions: mark.question };
    questions[`${mark.id}_at`] = { type: "box", instructions: mark.box };
  }
  const { answers, receipts } = await vision.judge({ paths: [`${dir}/pages/${name}`], fragments: [`${task.document}#page=${page}`], questions });
  const marks = Object.fromEntries(onPage.map((mark) => [mark.id, { p: answers[mark.id].noul, at: answers[`${mark.id}_at`].fragment }]));
  pages.push({ page, kind: answers.kind.choice, marks, receipts });
}
await sh(`printf %s ${q(JSON.stringify({ document: task.document, pages }))} > ${q(dir)}/pages.json`);
return pages.map(({ page, kind }) => ({ page, kind }));
```

A long document is one request a page all the same. To look at fewer, render a span (`pdftoppm -f 1 -l 5`); a page
not rendered is a page not looked at.

## 2. Each mark: yes or no, where, and the table

A mark is looked for on the pages of its kind and kept from the one where Jev is surest. It is there when the noul is
0.5 or more. Jev gives a box even for a thing that is not there, so a box is kept only for a mark that is there; a mark
that is not there cites the page it was looked for on, with no box. A `same` mark cuts both boxes out of a 300 dpi
render, with a little room around each, and asks one question of the two.

```js
const task = { document: "certificate.pdf", checklist: "checklist.json" };
const sh = async (command) => {
  const ran = await tools.bash({ command });
  if (typeof ran === "string") return ran;
  if (ran.exitCode) throw new Error(ran.output);
  return ran.output;
};
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const dir = `.verify/${task.document.replace(/[^\w.-]+/g, "_")}`;
const list = JSON.parse(await sh(`cat ${q(task.checklist)}`));
const { pages } = JSON.parse(await sh(`cat ${q(dir)}/pages.json`));
const r = (v) => Math.round(v * 1000) / 1000;
const found = {};
for (const mark of list.marks.filter((m) => m.page)) {
  const best = pages.filter((p) => p.kind === mark.page).sort((a, b) => b.marks[mark.id].p - a.marks[mark.id].p)[0];
  if (!best) { found[mark.id] = { p: 0, pages: [], at: [], receipts: [], why: `no ${mark.page} page was found` }; continue; }
  const { p, at } = best.marks[mark.id];
  found[mark.id] = { p, pages: [best.page], at: p >= 0.5 ? [at] : [], receipts: best.receipts };
}
for (const mark of list.marks.filter((m) => m.same)) {
  const parts = mark.same.map((id) => found[id]);
  const missing = mark.same.filter((id, i) => !parts[i].at.length);
  if (missing.length) { found[mark.id] = { p: 0, pages: parts.flatMap((part) => part.pages), at: [], receipts: [], why: `${missing.join(" and ")} not there` }; continue; }
  const crops = [];
  for (const [i, part] of parts.entries()) {
    const [x, y, w, h] = part.at[0].split("percent:")[1].split(",").map(Number);
    const [x0, y0] = [r(Math.max(0, x - 2)), r(Math.max(0, y - 2))];
    const [cw, ch] = [r(Math.min(100, x + w + 2) - x0), r(Math.min(100, y + h + 2) - y0)];
    const out = `${dir}/${mark.id}-${i + 1}`;
    await sh(`pdftoppm -cropbox -r 300 -f ${part.pages[0]} -l ${part.pages[0]} -singlefile -png ${q(task.document)} ${q(out)}-page`);
    const [W, H] = (await sh(`ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 ${q(out)}-page.png`)).trim().split(",").map(Number);
    const [px, py, pw, ph] = [Math.round((x0 / 100) * W), Math.round((y0 / 100) * H), Math.round((cw / 100) * W), Math.round((ch / 100) * H)];
    // Jev takes images 280 to 1,568 px a side: a cut-out line of print is scaled up to that, never down.
    const up = Math.max(1, Math.min(320 / Math.min(pw, ph), 1568 / Math.max(pw, ph)));
    await sh(`ffmpeg -v error -y -i ${q(out)}-page.png -vf crop=${pw}:${ph}:${px}:${py},scale=${Math.round(pw * up)}:${Math.round(ph * up)} ${q(out)}.png`);
    crops.push({ path: `${out}.png`, fragment: `${task.document}#page=${part.pages[0]}&xywh=percent:${x0},${y0},${cw},${ch}` });
  }
  const { answers, receipts } = await vision.judge({ paths: crops.map((c) => c.path), fragments: crops.map((c) => c.fragment), questions: { [mark.id]: { type: "noul", instructions: mark.question } } });
  const p = answers[mark.id].noul;
  found[mark.id] = { p, pages: parts.map((part) => part.pages[0]), at: p >= 0.5 ? parts.map((part) => part.at[0]) : [], receipts };
}
const rows = list.marks.map((mark) => {
  const f = found[mark.id];
  const there = f.at.length > 0;
  const cites = there ? f.at.map((at) => ({ fragment: at, receipts: f.receipts })) : f.pages.map((page) => ({ fragment: `${task.document}#page=${page}`, receipts: f.receipts }));
  return { id: mark.id, mark: mark.mark, value: there ? "yes" : "no", p: r(f.p), note: there ? mark.present : f.why ?? `not there: ${mark.present}`, cites };
});
const table = ["| Mark | There | Where |", "|---|---|---|", ...rows.map((row) => `| ${row.mark} | ${row.value} | ${row.cites.map((c) => c.fragment).join(", ") || "-"} |`)].join("\n");
await sh(`printf %s ${q(JSON.stringify({ document: task.document, rows }))} > ${q(dir)}/marks.json`);
return { document: task.document, every: rows.every((row) => row.value === "yes"), rows, table };
```

Cite each row by its fragments and receipts: the fragment is where on which page, and the receipt is the look that
saw it. A row that says no cites the page it was looked for on, so a reader can see the empty place for themselves.

## When pdftoppm or ffmpeg is missing

The look skill's last section installs them: `poppler-utils` has `pdftoppm`, and `ffmpeg` has `ffprobe` too.
