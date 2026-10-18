---
name: report
description: End a run with your own report, one self-contained HTML page that gives the answer first and then the evidence, with the frames and photos you looked at, short clips cut from a film, boxes drawn over a picture, and every cite a link to the file's own page or second. Use at the end of a run that looked at documents, images or video, when the person needs to see what you saw and not only read your words; cite as file#page=N, file#t=seconds or file#xywh=percent:x,y,w,h.
---

# End the run with a report

The last thing a run makes is `report/report.html`: a page a person opens, understands in ten seconds and can check in
two minutes. You write it with code, from what the run already holds: the answers, the frames, the keys of the looks. It
is not a form to fill. Fit the page to what you found: one finding, one picture and a clip is a short page; ten findings
is a longer one.

## What the page is

- **One folder.** `report/report.html`, and beside it the files it shows: `report/frames/` and `report/clips/`. A person
  can zip the folder and send it.
- **Self-contained.** Inline CSS, no script, no network: no CDN, no web font, no remote image, no `<link>`, no
  `<iframe>`. A URL a source mentioned is written without its scheme, as text (`example.com/terms`), never as a link.
- **Light and dark, and phone width.** `color-scheme: light dark` and one `prefers-color-scheme` rule; one column that
  grows to two where there is room; system fonts.
- **The answer first.** The first thing on the page is what you found, in a sentence or two, with the one or two figures
  that matter. Then the evidence, one section for each finding: its words, its picture or clip, its cites. Last, what you
  did not check.
- **A size budget.** A frame is a JPEG at most 960 px wide, about 300 KB or less. A clip is a few seconds, 480 px wide,
  silent unless the sound is the point, at most 2 MB. `report/` is at most 15 MB.
- **Cites that name the source's own address.** A link to the file with its fragment: `talk.mp4#t=21.5`,
  `contract.pdf#page=3`, `photo.jpg#xywh=percent:10,20,30,15`. The label shows that number (`21.5 s`, `page 3`). A PDF
  page is its index counted from 1, never the number printed on the page. Every cite carries `data-look`, the key of the
  look it rests on, so the viewer can open that look at that fragment. A claim with no look behind it is not a finding:
  look first, or put it under what you did not check.
- **Boxes from the look's percentages.** A look's `#xywh=percent:x,y,w,h` is already the box's place on its picture as
  percentages of the picture: put it on the picture with CSS `left`, `top`, `width` and `height` in `%`, and do no
  arithmetic. Show the picture the look saw, or the same whole frame at another size; a crop moves the percentages.
- **Nothing private.** No machine path, key, signed link or price in the page. Paths are the run's own relative ones.

## The script

The pieces below are one script, in order, and share their names: run them in one `code` call. The example finds three
things: a moment in a talk, the page of a contract and a photo. Change the data in piece 4 to yours, and keep the rest.
If cutting clips needs more time than one call has, make the files in one call and write the page in the next, with
pieces 1 and 3 again at the top of it.

### 1. The shell, and a way to write a file with it

`tools.bash` is how code mode reaches files and programs. A file is written in chunks with `printf %s`, which adds
nothing and takes no escapes, so the page lands byte for byte; a chunk never ends between the halves of one character.

```js
const sh = (command) => tools.bash({ command });
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const write = async (path, text) => {
  await sh(`mkdir -p "$(dirname ${q(path)})" && : > ${q(path)}`);
  for (let at = 0, end = 0; at < text.length; at = end) {
    end = Math.min(at + 30000, text.length);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end -= 1;
    await sh(`printf %s ${q(text.slice(at, end))} >> ${q(path)}`);
  }
};
const bytes = async (path) => Number((await sh(`wc -c < ${q(path)}`)).trim());
const slug = (name) => { if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`${name}: a file name here is lowercase letters, digits and dashes`); return name; };
```

### 2. The files the page shows

A frame from a film, a page of a PDF and a photo each become a JPEG under `report/frames/`; a window of a film becomes a
silent MP4 under `report/clips/`, re-encoded until it fits its budget. Each helper returns the path relative to
`report/`, which is what the page uses.

```js
const frame = async (video, t, name) => {
  await sh(`mkdir -p report/frames && ffmpeg -v error -y -ss ${t} -i ${q(video)} -frames:v 1 -vf "scale='min(960,iw)':-2" -q:v 4 report/frames/${slug(name)}.jpg`);
  return `frames/${name}.jpg`;
};
const pdfPage = async (pdf, page, name) => {
  await sh(`mkdir -p report/frames && pdftoppm -f ${page} -l ${page} -r 110 -jpeg -singlefile ${q(pdf)} report/frames/${slug(name)}`);
  return `frames/${name}.jpg`;
};
const photo = async (file, name) => {
  await sh(`mkdir -p report/frames && ffmpeg -v error -y -i ${q(file)} -vf "scale='min(960,iw)':-2" -q:v 4 report/frames/${slug(name)}.jpg`);
  return `frames/${name}.jpg`;
};
const clip = async (video, from, to, name, { sound = false, maxBytes = 2_000_000 } = {}) => {
  const out = `report/clips/${slug(name)}.mp4`;
  await sh("mkdir -p report/clips");
  for (const [width, crf] of [[480, 30], [480, 36], [360, 36], [320, 42]]) {
    await sh(`ffmpeg -v error -y -ss ${from} -i ${q(video)} -t ${to - from} ${sound ? "-c:a aac -b:a 48k" : "-an"} -vf scale=${width}:-2 -c:v libx264 -pix_fmt yuv420p -crf ${crf} -preset veryfast -movflags +faststart ${out}`);
    if (await bytes(out) <= maxBytes) return `clips/${name}.mp4`;
  }
  throw new Error(`${name}: ${to - from} s do not fit ${maxBytes} bytes; cut a shorter window`);
};
```

### 3. The looks, and their keys

Look at the pictures you will show, if the run has not already, and take each look's key from its receipt. `vision.see`
returns the receipts' paths, one for each request. A receipt is a JSON record (its key is `facts.key`) or a text file whose
header has a `key:` line before the first `---`. A look the run made earlier is cited the same way: give `keyOf` its
receipt's path.

```js
const looks = new Set();
const keyOf = async (receipt) => {
  if (!receipt) throw new Error("no receipt: this host files none, so there is no look to cite");
  const text = await sh(`cat ${q(receipt)}`);
  let key;
  try { key = JSON.parse(text).facts.key; } catch { key = text.split("\n---")[0].split("\n").map((line) => line.split(": ")).find(([name]) => name === "key")?.[1]; }
  if (!key) throw new Error(`${receipt} holds no look key`);
  looks.add(key);
  return key;
};
const look = async (path, fragment, ask) => {
  const seen = await vision.see({ ask, paths: [path], fragments: [fragment] });
  return { key: await keyOf(seen.receipts[0]), text: seen.text.trim() };
};
```

### 4. The findings, as data

Everything the page says is data here first: the answer, the findings, their cites, their boxes. The file names are the
run's own; the times, pages and percentages come from the looks you made (a `vision.judge` box answer carries its
`fragment`; `find` and `look` say where a thing is).

```js
const shots = {
  talk: await frame("talk.mp4", 21.5, "talk-chart"),
  contract: await pdfPage("contract.pdf", 3, "contract-p3"),
  site: await photo("photo.jpg", "site-photo"),
};
const lookTalk = await look(`report/${shots.talk}`, "talk.mp4#t=21.5", "What does the chart on the screen show?");
const lookContract = await look(`report/${shots.contract}`, "contract.pdf#page=3", "What does this page say about the end date?");
const lookSite = await look(`report/${shots.site}`, "photo.jpg", "What is in the photo?");

const report = {
  title: "The talk, the contract and the site",
  question: "Does the chart agree with the contract, and what does the site look like?",
  answer: "Yes. The chart shows the second quarter highest, and the contract's page 3 sets the end date the talk gave.",
  facts: [["Chart peak", "second quarter"], ["Contract end", "page 3"]],
  findings: [
    { title: "The chart shows the second quarter highest", words: lookTalk.text,
      frame: shots.talk, alt: "A bar chart with the second bar tallest",
      clip: { src: await clip("talk.mp4", 18, 26, "talk-chart"), poster: shots.talk },
      boxes: [{ xywh: "percent:61.2,40,12,9", label: "second quarter", look: lookTalk.key }],
      cites: [{ file: "talk.mp4", t: [21.5], look: lookTalk.key }, { file: "talk.mp4", t: [18, 26], look: lookTalk.key }] },
    { title: "The contract sets the end date on page 3", words: lookContract.text,
      frame: shots.contract, alt: "Page 3 of the contract",
      cites: [{ file: "contract.pdf", page: 3, look: lookContract.key }] },
    { title: "The site", words: lookSite.text, frame: shots.site, alt: "A photo of the site",
      cites: [{ file: "photo.jpg", look: lookSite.key }] },
  ],
  notChecked: ["The talk's figures were read from the chart, not from a table."],
};
```

### 5. The page

One function for each part, so a finding with a clip and boxes, or with neither, is the same code. The page is written
once, at the end.

```js
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const say = (text) => esc(String(text).replace(/\b(?:https?|ftp|file):(?:\/\/)?/gi, "").replace(/\bmailto:/gi, "").replace(/(^|[\s(])\/\/(?=[a-z0-9-]+\.)/gi, "$1"));
const num = (n) => String(Number(n.toFixed(2)));
const part = (c) => [c.page && `page=${c.page}`, c.t && `t=${c.t.map(num).join(",")}`, c.xywh && `xywh=${c.xywh}`].filter(Boolean).join("&");
const label = (c) => [c.page && `page ${c.page}`, c.t && `${c.t.map(num).join(" to ")} s`, c.xywh && "box"].filter(Boolean).join(", ") || "file";
const cite = (c) => `<a class="cite" href="../${encodeURI(c.file)}${part(c) ? `#${part(c)}` : ""}" data-look="${esc(c.look)}">${esc(label(c))}</a>`;
const box = (b) => { const [x, y, w, h] = b.xywh.replace("percent:", "").split(",");
  return `<span class="box" data-xywh="${esc(b.xywh)}" data-look="${esc(b.look)}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><b>${say(b.label)}</b></span>`; };
const picture = (f) => `<div class="frame"><img src="${esc(f.frame)}" alt="${say(f.alt)}" loading="lazy">${(f.boxes ?? []).map(box).join("")}</div>`;
const movie = (f) => `<video controls muted playsinline preload="metadata" poster="${esc(f.clip.poster)}"><source src="${esc(f.clip.src)}" type="video/mp4"></video>`;
const finding = (f, i) => `<article class="finding" id="f${i + 1}"><h3>${say(f.title)}</h3><p>${say(f.words)}</p>
<div class="media">${f.frame ? picture(f) : ""}${f.clip ? movie(f) : ""}</div>
<p class="cites">${f.cites.map(cite).join(" ")}</p></article>`;

const css = `:root{color-scheme:light dark;--bg:#f7f6f2;--fg:#17181a;--mute:#5c6068;--card:#fff;--line:#e2e1db;--accent:#2f5bff;--box:#e5254f}
@media (prefers-color-scheme:dark){:root{--bg:#0f1013;--fg:#ecebe7;--mute:#a1a5ad;--card:#181a1f;--line:#2a2d35;--accent:#8ba6ff;--box:#ff6b8d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:60rem;margin:0 auto;padding:1.25rem 1rem 4rem}h1{font-size:clamp(1.6rem,5vw,2.4rem);line-height:1.12;margin:.3em 0 .25em}
h2{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:2.2rem 0 .8rem}h3{font-size:1.15rem;margin:0 0 .4rem}
.question{color:var(--mute);margin:0 0 1.4rem}
#answer{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:.7rem;padding:1.1rem 1.3rem}
#answer p{font-size:1.2rem;line-height:1.45;margin:0 0 .8rem}dl{display:flex;flex-wrap:wrap;gap:.6rem;margin:0}
dl div{background:var(--bg);border:1px solid var(--line);border-radius:.5rem;padding:.4rem .8rem}dt{font-size:.75rem;color:var(--mute)}dd{margin:0;font-weight:650}
.finding{background:var(--card);border:1px solid var(--line);border-radius:.7rem;padding:1.1rem 1.2rem;margin:0 0 1rem}
.media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:.8rem;margin:.8rem 0;padding-top:.9rem}
.frame{position:relative;line-height:0}.frame img,video{width:100%;height:auto;border-radius:.45rem;border:1px solid var(--line);background:#000}
.box{position:absolute;border:3px solid var(--box);border-radius:.25rem;box-shadow:0 0 0 1px #fff8}.box b{position:absolute;left:-3px;bottom:100%;background:var(--box);color:#fff;font:600 .7rem/1.4 system-ui,sans-serif;padding:.05rem .4rem;border-radius:.25rem .25rem .25rem 0;white-space:nowrap}
.cites{margin:.2rem 0 0;display:flex;flex-wrap:wrap;gap:.4rem}.cite{font:.8rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);border:1px solid var(--line);border-radius:999px;padding:.2rem .6rem;text-decoration:none}
.cite:hover,.cite:focus-visible{border-color:var(--accent)}ul{color:var(--mute);padding-left:1.2rem}`;

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${say(report.title)}</title><style>${css}</style></head>
<body><main>
<header><h1>${say(report.title)}</h1><p class="question">${say(report.question)}</p></header>
<section id="answer" aria-label="Answer"><p>${say(report.answer)}</p><dl>${report.facts.map(([k, v]) => `<div><dt>${say(k)}</dt><dd>${say(v)}</dd></div>`).join("")}</dl></section>
<section id="evidence"><h2>Evidence</h2>${report.findings.map(finding).join("\n")}</section>
<section id="not-checked"><h2>Not checked</h2><ul>${report.notChecked.map((line) => `<li>${say(line)}</li>`).join("")}</ul></section>
</main></body></html>
`;
await write("report/report.html", page);
```

### 6. The check before you stop

Run it after the page is written. It returns what is wrong, and the script stops if anything is: fix the data and write
the page again.

```js
const problems = [];
const attr = (name) => [...page.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
if (/<script|<link|<iframe|<form|@import|https?:|\/\/[a-z0-9-]+\./i.test(page)) problems.push("the page reaches outside its folder or runs code");
for (const ref of [...attr("src"), ...attr("poster")]) {
  if (/^([a-z][a-z0-9+.-]*:|\/|\.\.)/i.test(ref)) problems.push(`${ref} is not a file in report/`);
  else if (!(await bytes(`report/${ref}`).catch(() => 0))) problems.push(`${ref} is missing or empty`);
}
for (const ref of attr("src").filter((r) => r.startsWith("clips/"))) if ((await bytes(`report/${ref}`)) > 2_000_000) problems.push(`${ref} is over 2 MB`);
if (Number((await sh("find report -type f -exec cat {} + | wc -c")).trim()) > 15_000_000) problems.push("report/ is over 15 MB");
for (const href of attr("href")) {
  const [file, fragment = ""] = href.split("#");
  if (!file.startsWith("../") || file.slice(3).split("/").includes("..") || file.includes(":")) problems.push(`${href} is not a relative cite`);
  if (fragment && !/^(page=[1-9]\d*|t=\d+(\.\d+)?(,\d+(\.\d+)?)?|xywh=percent:[\d.]+(,[\d.]+){3})(&(t=\d+(\.\d+)?(,\d+(\.\d+)?)?|xywh=percent:[\d.]+(,[\d.]+){3}))*$/.test(fragment)) problems.push(`${href} has a fragment that is not page=, t= or xywh=`);
}
for (const key of attr("data-look")) if (!looks.has(key)) problems.push(`data-look ${key} is no look this run made`);
if ((page.match(/class="cite"/g) ?? []).length !== (page.match(/class="cite" href="[^"]*" data-look=/g) ?? []).length) problems.push("a cite has no data-look");
for (const xywh of attr("data-xywh")) {
  const [x, y, w, h] = xywh.replace("percent:", "").split(",").map(Number);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 100 || y + h > 100) problems.push(`${xywh} is not inside 0 to 100`);
}
const first = page.indexOf('id="answer"');
if (first < 0 || first > page.indexOf('class="finding"')) problems.push("the answer is not first");
if (problems.length) throw new Error(problems.join("\n"));
return { report: "report/report.html", findings: report.findings.length, looks: looks.size, bytes: await bytes("report/report.html") };
```

Also read the page once the way a person does: the first screen says the answer; each finding's words match its picture
and its cites; nothing in the answer is missing from the evidence; and what you could not check is under "Not checked".

## The last message

Short: the answer in a sentence or two, then where the report is. Do not repeat the page.

> The second quarter is the highest bar, and the contract's page 3 sets the end date the talk gave. The report is
> `report/report.html`: the chart with its box, a clip of the moment, and the contract page.
