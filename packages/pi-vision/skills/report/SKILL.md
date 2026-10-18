---
name: report
description: End a run with your own report, one self-contained, script-free HTML page, report/index.html, that leads with the answer and its few key points and folds the routine detail. Show the document, the film frames, the photos and short clips you looked at only where they help the answer, mark the cited region on the picture, and cite every claim as a link to the file's own address (file#page=N, file#t=a,b, file#xywh=percent:x,y,w,h). Use at the end of a run that looked at documents, images or video, when the person needs to see what you saw and not only read your words.
---

# End the run with a report

The last thing a run makes is `report/index.html`: a page a person opens, understands in ten seconds and can check in two
minutes. You write it with code from what the run already holds: the looks' answers, the frames and the keys of the looks.
It is not a form to fill: the same page serves a film, a document or a photo, and you choose what it shows.

## Choose what the page says

- **The answer first**, in a sentence or two, then three or four key points, each a link to the finding or the mark it
  stands on. Someone who reads only that much has the answer.
- **The answer is in the shape the question asks.** When the question names a shape (minute by minute, page by page, mark by
  mark, a table), the answer section is that shape: one row for each unit, every row cited. Group or fold only the detail
  under a row, never the rows. A question that names no shape gets the sentence and the key points.
- **Never state what the run did not read.** Every name, place, time and number on the page comes from a look's answer or from
  the file's own text, and carries its cite. A caption says what the look saw, not what you remember about the subject.
  What the run did not read is left out, or goes under what you did not check.
- **Fold the routine.** What was checked and found as expected goes in a folded section (`<details>`), one line each. What
  surprised, failed or decided the answer is a finding of its own, open, and first.
- **Media only where it helps.** A picture is kept when it shows what the claim is about; a frame or a page that proves
  nothing is dropped, not shown to look thorough. Each kept picture has a caption that says why it matters, in a sentence
  ("the tallest bar is the second quarter's"), not what it is ("a chart").
- **A document is embedded.** When the run read a document, the page shows it as a viewer would: each page the findings
  stand on as an image, in order, with every found mark outlined and labelled on its page. Each mark links to its finding
  and back, and the page links to the PDF itself at `#page=N`.
- **A film is shown by its moments.** A window of the film is one short clip, with a poster that is the window's opening
  frame. The same window is never a clip twice: later it is a frame, from `frame()`, with a box if it has one.
- **What you did not check** is last: what you assumed, could not reach or did not look at.

## What the page is

- **One folder.** `report/index.html`, and beside it every file it shows, at relative paths: `report/frames/` for pictures,
  `report/clips/` for clips. The host collects the folder as it stands and never reaches outside it, so:
  - every document or photo the page cites, under about 3 MB, is copied into `report/` (`keep()`) and cited by its name there;
  - never write `../` in a `src`, `poster` or `href`: a path that leaves `report/` is dead;
  - a film (or any source too large to copy) stays outside: its cite keeps the file's own name and fragment, `talk.mp4#t=18,26`,
    carries `data-look`, and the file is listed in `outside`; the viewer finds it through the look;
  - everything the page loads (`src`, `poster`) is inside `report/`; only a link may name a file outside it, and only a film
    listed in `outside`. Any other relative link is dead.
- **No script, nothing from the network.** Inline CSS. No `<script>`, no `on...` attributes, no `data:` URLs (a picture is a
  file), no `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<link>` or `<meta http-equiv>`, no `url()`, no `@import`,
  no remote font or image. A link out is allowed but loads nothing; a URL in text is written without its scheme
  (`example.com/terms`) so nothing in it can be mistaken for a load.
- **Light and dark, phone width.** `color-scheme: light dark`, one `prefers-color-scheme` rule, one column that becomes two
  where there is room, system fonts.
- **A size budget**, one place to change (`BUDGET`): a picture at most 1600 px wide and 700 KB (960 px for a film frame), a
  clip a few seconds at 480 px, silent unless the sound is the point, at most 1.5 MB, the folder at most 8 MB. The artifact
  counts toward the recording's own limit.
- **No metadata, no machine.** Frames, photos and clips are re-encoded with their metadata stripped (`-map_metadata -1`; a
  clip keeps only its codec's own name). No file names the machine's paths, the home directory or a key; a path in the page
  is the run's own relative one.
- **Cites in the file's own address**, labelled with that number: `contract.pdf#page=3` (the page's index from 1, never the
  number printed on it), `talk.mp4#t=21.5` or `#t=18,26`, a box on a page `contract.pdf#page=3&xywh=percent:7,6,70,4`, a
  box on a film `talk.mp4#t=21.5&xywh=percent:61,40,12,9`, a box on a photo `photo.jpg#xywh=percent:10,20,30,15`
  (`pixel:` for pixel boxes). Every cite carries `data-look`, the key of the look it rests on, so the viewer can open that
  look at that fragment. A claim with no look behind it is not a finding: look first, or put it under what you did not check.
  A cite names a file of `report/` or a film in `outside`, as `keep()` and the page spell it, never with `../`.
- **Boxes are the look's percentages**, placed on the picture with CSS `left`, `top`, `width` and `height` in `%`. Do no
  arithmetic; show the picture the look saw (or the same whole picture at another size: a crop moves the percentages). A
  look that gave pixels is divided once by the picture's width and height.

## The script

The pieces are a working example, not a form to fill: write your own data, and drop or change any piece your run does not
need (no film, no `clip()`; no document, no document section). The example has a talk (a clip, a moment, a box), a contract
(its page 3 embedded, a mark on it) and a routine photo. The pieces are one script, in order, sharing their names: run them
in one `code` call. If cutting clips needs more time than one call has, make the files in one call and write the page in the
next, with pieces 1 and 3 again at its top.

### 1. The shell, and a way to write a file with it

`tools.bash` is how code mode reaches files and programs. A file is written in chunks with `printf %s`, which adds nothing
and takes no escapes, so the page lands byte for byte; a chunk never ends between the halves of one character.

```js
const BUDGET = { frame: 700_000, clip: 1_500_000, folder: 8_000_000, source: 3_000_000 };
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

A film frame, a page of a PDF and a photo each become a JPEG under `report/frames/`; a window of a film becomes a silent MP4
under `report/clips/` with its poster, re-encoded down a ladder until it fits; a document or photo the page cites is copied beside it.
Each helper returns a path relative to `report/`, which is what the page uses.

```js
const jpeg = "-map_metadata -1 -fflags +bitexact -q:v 4";
const frame = async (video, t, name) => {
  await sh(`mkdir -p report/frames && ffmpeg -v error -y -ss ${t} -i ${q(video)} -frames:v 1 -vf "scale='min(960,iw)':-2" ${jpeg} report/frames/${slug(name)}.jpg`);
  return `frames/${name}.jpg`;
};
const pdfPage = async (pdf, page, name) => {   // the crop box, as a viewer shows it, so a look's percentages fit
  await sh(`mkdir -p report/frames && pdftoppm -cropbox -f ${page} -l ${page} -scale-to-x 1600 -scale-to-y -1 -jpeg -jpegopt quality=78 -singlefile ${q(pdf)} report/frames/${slug(name)}`);
  return `frames/${name}.jpg`;
};
const photo = async (file, name) => {
  await sh(`mkdir -p report/frames && ffmpeg -v error -y -i ${q(file)} -vf "scale='min(960,iw)':-2" ${jpeg} report/frames/${slug(name)}.jpg`);
  return `frames/${name}.jpg`;
};
const windows = new Map();
const clip = async (video, from, to, name, { sound = false } = {}) => {
  const window = `${video}#t=${from},${to}`;
  if (windows.has(window)) throw new Error(`${window} is already the clip ${windows.get(window)}: show a frame of this window, not the clip again`);
  const poster = await frame(video, from, `${slug(name)}-poster`);   // the window's opening frame
  const out = `report/clips/${name}.mp4`;
  await sh("mkdir -p report/clips");
  for (const [width, crf] of [[480, 30], [480, 36], [360, 36], [320, 42]]) {
    await sh(`ffmpeg -v error -y -ss ${from} -i ${q(video)} -t ${to - from} ${sound ? "-c:a aac -b:a 48k" : "-an"} -vf scale=${width}:-2 -c:v libx264 -pix_fmt yuv420p -crf ${crf} -preset veryfast -map_metadata -1 -fflags +bitexact -movflags +faststart ${out}`);
    if (await bytes(out) <= BUDGET.clip) { windows.set(window, name); return { src: `clips/${name}.mp4`, poster }; }
  }
  throw new Error(`${name}: ${to - from} s do not fit ${BUDGET.clip} bytes; cut a shorter window`);
};
const keep = async (file) => {   // a document or photo the run was given, copied beside the page: cite the name it returns, never ../
  const name = file.split("/").pop(), to = `report/${name}`, tmp = `report/.keep-${name}`;
  const toobig = `${file} is over ${BUDGET.source} bytes: name it in outside and cite it by its name`;
  if ((await bytes(file)) > BUDGET.source) throw new Error(toobig);
  await sh(`mkdir -p report && ${/\.(jpe?g|png|webp)$/i.test(name) ? `ffmpeg -v error -y -i ${q(file)} -map_metadata -1 -fflags +bitexact -q:v 2 ${q(tmp)}` : `cp -- ${q(file)} ${q(tmp)}`}`);
  const clash = (await sh(`test -e ${q(to)} && ! cmp -s ${q(tmp)} ${q(to)} && echo clash || true`)).trim();
  if (clash || (await bytes(tmp)) > BUDGET.source) { await sh(`rm -f ${q(tmp)}`); throw new Error(clash ? `${file}: report/ already holds a different file named ${name}; rename one source before keeping both` : toobig); }
  await sh(`mv -f ${q(tmp)} ${q(to)}`);
  return name;   // a photo is re-encoded without its metadata; a document is copied as it is
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
  const text = await sh(`cat ${q(receipt)}`).catch(() => sh(`cat ${q(`../${receipt}`)}`));   // a host may file receipts in the folder above the workspace
  let key, status;
  try { ({ status, facts: { key } } = JSON.parse(text)); } catch { const header = text.split("\n---")[0].split("\n").map((line) => line.split(": ")); key = header.find(([name]) => name === "key")?.[1]; status = header.find(([name]) => name === "status")?.[1]; }
  if (!key) throw new Error(`${receipt} holds no look key`);
  if (status === "failed") throw new Error(`${receipt} is a look that failed: it is no evidence for a finding`);
  looks.add(key);
  return key;
};
const look = async (path, fragment, ask) => {
  const seen = await vision.see({ ask, paths: [path], fragments: [fragment] });
  return { key: await keyOf(seen.receipts[0]), text: seen.text.trim() };
};
```

### 4. The findings, as data

Everything the page says is data here first. The file names are the run's own; the times, pages and percentages come from the
looks you made (a `vision.judge` box answer carries its `fragment`; `find` and `look` say where a thing is). A finding is a
key one (open) or `routine` (folded). A box belongs to a finding and links back to it; `points` are the three or four key
points of the answer. When the question names a shape, add `rows` to the report, one for each unit it names:
`rows: [{ id: "m1", label: "0:00 to 1:00", text: "what the look read there", cites: [{ file: "talk.mp4", t: [0, 60], look: lookTalk.key }] }]`.
An embedded page takes its look from a cite of that page of that document, in a finding or a row, or from a `look` of its own.

```js
const talk = await frame("talk.mp4", 21.5, "talk-chart");
const later = await frame("talk.mp4", 24, "talk-later");   // the same window again: a frame, never a second clip
const page3 = await pdfPage("contract.pdf", 3, "contract-p3");
const site = await photo("photo.jpg", "site-photo");
const lookTalk = await look(`report/${talk}`, "talk.mp4#t=21.5", "What does the chart on the screen show?");
const lookPage = await look(`report/${page3}`, "contract.pdf#page=3", "What rule does this page set?");
const lookSite = await look(`report/${site}`, "photo.jpg", "What is in the photo?");

const report = {
  title: "The talk, the contract and the site",
  question: "Does the chart agree with the contract, and what does the site look like?",
  answer: "Yes. The chart shows the second quarter highest, and page 3 of the contract sets the record-keeping rule the talk gave.",
  points: [{ label: "Chart peak", value: "second quarter", to: "f-chart" }, { label: "Contract rule", value: "page 3", to: "f-contract" }],
  findings: [
    { id: "chart", title: "The chart shows the second quarter highest", why: lookTalk.text,
      pics: [
        { src: talk, alt: "A bar chart with the second bar tallest", caption: "The tallest bar is the second quarter's, the figure the answer rests on.",
          boxes: [{ id: "mark-peak", finding: "chart", at: "61.2,40,12,9", label: "second quarter", look: lookTalk.key }] },
        { src: later, alt: "The same chart a moment later", caption: "A moment later the chart has not changed, so the reading holds." },
      ],
      clip: { ...(await clip("talk.mp4", 18, 26, "talk-chart")), caption: "The eight seconds around the chart." },
      cites: [{ file: "talk.mp4", t: [21.5], xywh: "percent:61.2,40,12,9", look: lookTalk.key }, { file: "talk.mp4", t: [18, 26], look: lookTalk.key }] },
    { id: "contract", title: "The contract sets the rule on page 3", why: lookPage.text,
      cites: [{ file: "contract.pdf", page: 3, xywh: "percent:7,6,70,4", look: lookPage.key }] },
    { id: "site", routine: true, title: "The site", why: lookSite.text,
      pics: [{ src: site, alt: "A photo of the site", caption: "Nothing in the photo bears on the answer; it is kept as the record of the visit." }],
      cites: [{ file: await keep("photo.jpg"), look: lookSite.key }] },
  ],
  document: { file: await keep("contract.pdf"), pages: [{ n: 3, src: page3, boxes: [{ id: "mark-rule", finding: "contract", at: "7,6,70,4", label: "the rule", look: lookPage.key }] }] },
  outside: ["talk.mp4"],   // a film is cited by its own name and not copied; every other cited file was kept above
  notChecked: ["The talk's figures were read from the chart, not from a table."],
};
```

### 5. The page

One function for each part, so a finding with a clip and boxes, or with neither, is the same code. The page is written once, at
the end.

```js
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const say = (text) => esc(String(text).replace(/\b(?:https?|ftp|file):(?:\/\/)?/gi, "").replace(/\bmailto:/gi, "").replace(/(^|[\s(])\/\/(?=[a-z0-9-]+\.)/gi, "$1"));
const num = (n) => String(Number(n.toFixed(2)));
const part = (c) => [c.page && `page=${c.page}`, c.t && `t=${c.t.map(num).join(",")}`, c.xywh && `xywh=${c.xywh}`].filter(Boolean).join("&");
const label = (c) => c.page ? `p. ${c.page}` : c.t ? `${c.t.map(num).join(" to ")} s` : c.xywh ? `box ${c.xywh.replace(/^percent:/, "").replace(/^pixel:/, "px ")}` : "file";
const cite = (c) => `<a class="cite" href="${encodeURIComponent(c.file)}${part(c) ? `#${esc(part(c))}` : ""}" data-look="${esc(c.look)}">${esc(label(c))}</a>`;
const box = (b) => { const [x, y, w, h] = b.at.split(",");
  return `<div class="mark${Number(x) + Number(w) / 2 > 50 ? " right" : ""}" id="${esc(b.id)}" data-xywh="percent:${esc(b.at)}" data-look="${esc(b.look)}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><a class="tag" href="#f-${esc(b.finding)}">${say(b.label)}</a></div>`; };
const sheet = (p) => `<div class="sheet"><img src="${esc(p.src)}" alt="${say(p.alt)}" loading="lazy">${(p.boxes ?? []).map(box).join("")}</div>`;
const pic = (p) => `<figure class="pic">${sheet(p)}<figcaption>${say(p.caption)}</figcaption></figure>`;
const movie = (c) => `<figure class="pic"><video controls muted playsinline preload="metadata" poster="${esc(c.poster)}"><source src="${esc(c.src)}" type="video/mp4"></video><figcaption>${say(c.caption)}</figcaption></figure>`;
const spots = [...(report.document?.pages ?? []).flatMap((p) => (p.boxes ?? []).map((b) => [b, `p. ${p.n}`])), ...report.findings.flatMap((f) => (f.pics ?? []).flatMap((p) => (p.boxes ?? []).map((b) => [b, "the picture"])))];
const where = (id) => spots.filter(([b]) => b.finding === id).map(([b, at]) => `<a class="jump" href="#${esc(b.id)}">show on ${at}</a>`).join(" ");
const body = (f) => `<h3>${say(f.title)}</h3><p>${say(f.why)}</p>
<div class="media">${(f.pics ?? []).map(pic).join("")}${f.clip ? movie(f.clip) : ""}</div>
<p class="cites">${f.cites.map(cite).join(" ")} ${where(f.id)}</p>`;
const finding = (f) => f.routine
  ? `<details class="finding routine" id="f-${f.id}"><summary>${say(f.title)}</summary>${body(f)}</details>`
  : `<article class="finding" id="f-${f.id}">${body(f)}</article>`;
const rows = (list) => list.length ? `<ol class="rows">${list.map((r) => `<li class="row" id="r-${esc(r.id)}"><span class="when">${say(r.label)}</span><span class="what">${say(r.text)}</span><span class="cites">${r.cites.map(cite).join(" ")}</span></li>`).join("")}</ol>` : "";
const docPage = (p) => `<figure class="docpage" id="page-${p.n}"><header><span class="n">p. ${p.n}</span><a class="cite" href="${encodeURIComponent(report.document.file)}#page=${p.n}" data-look="${esc(p.look ?? [...(report.rows ?? []), ...report.findings].flatMap((x) => x.cites).find((c) => c.file === report.document.file && c.page === p.n)?.look ?? "")}">open at p. ${p.n}</a></header>${sheet({ ...p, alt: p.alt ?? `Page ${p.n} of ${report.document.file}` })}</figure>`;

const css = `:root{color-scheme:light dark;--bg:#f7f6f2;--fg:#17181a;--mute:#5c6068;--card:#fff;--line:#e2e1db;--accent:#d96a00;--box:#6b4fd8}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0f;--fg:#ecebe7;--mute:#a1a5ad;--card:#161618;--line:#2a2b30;--accent:#ff8700;--box:#b4a0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:64rem;margin:0 auto;padding:1.25rem 1rem 4rem}a{color:var(--accent)}h1{font-size:clamp(1.6rem,5vw,2.3rem);line-height:1.15;margin:.3em 0 .25em}
h2{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin:2.2rem 0 .8rem}h3{font-size:1.1rem;margin:0 0 .4rem}.question{color:var(--mute);margin:0 0 1.4rem}
#answer{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:.7rem;padding:1.1rem 1.3rem}#answer>p{font-size:1.25rem;line-height:1.4;margin:0 0 .9rem}
.points{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr));gap:.6rem;margin:0;padding:0}.points li{border:1px solid var(--line);border-radius:.5rem;padding:.45rem .8rem;background:var(--bg)}
.points small{display:block;color:var(--mute);font-size:.75rem}.points a{color:var(--fg);font-weight:650;text-decoration:none}
.finding{background:var(--card);border:1px solid var(--line);border-radius:.7rem;padding:1.1rem 1.2rem;margin:0 0 1rem}summary{cursor:pointer;font-weight:650}.routine{padding:.8rem 1.2rem}
.media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:.9rem;margin:.8rem 0}figure{margin:0}figcaption{color:var(--mute);font-size:.88rem;margin-top:.35rem}
.sheet,figure>video{margin-top:1rem}.sheet{position:relative;line-height:0;border:1px solid var(--line);border-radius:.45rem}.sheet img,video{display:block;width:100%;height:auto;border-radius:.45rem;background:#000}.sheet img{background:#fff}
.mark{position:absolute;border:3px solid var(--box);border-radius:.25rem;scroll-margin-top:6rem}.mark:target{outline:3px solid var(--accent)}
.tag{position:absolute;left:-3px;bottom:100%;white-space:nowrap;background:var(--box);color:#fff;font:600 .7rem/1.5 system-ui,sans-serif;padding:0 .4rem;border-radius:.25rem .25rem .25rem 0;text-decoration:none}.right .tag{left:auto;right:-3px;border-radius:.25rem .25rem 0}
.cites{margin:.2rem 0 0;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}.cite{font:.8rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);border:1px solid var(--line);border-radius:999px;padding:.2rem .6rem;text-decoration:none}.jump{font-size:.85rem;color:var(--mute)}
.rows{list-style:none;margin:1rem 0 0;padding:0}.row{display:flex;flex-wrap:wrap;gap:.3rem .8rem;align-items:baseline;border-top:1px solid var(--line);padding:.5rem 0}.when{font:700 .85rem ui-monospace,monospace;min-width:6rem}.what{flex:1 1 14rem}.row .cites{margin:0 0 0 auto}
.docpage{margin:0 0 1.2rem;scroll-margin-top:1rem}.docpage>header{display:flex;justify-content:space-between;align-items:center}.n{font:700 .85rem ui-monospace,monospace}ul.limits{color:var(--mute);padding-left:1.2rem}`;

const keyFindings = report.findings.filter((f) => !f.routine), routine = report.findings.filter((f) => f.routine);
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${say(report.title)}</title><style>${css}</style></head>
<body><main>
<header><h1>${say(report.title)}</h1><p class="question">${say(report.question)}</p></header>
<section id="answer" aria-label="Answer"><p>${say(report.answer)}</p><ul class="points">${report.points.map((p) => `<li><small>${say(p.label)}</small><a href="#${esc(p.to)}">${say(p.value)}</a></li>`).join("")}</ul>${rows(report.rows ?? [])}</section>
${keyFindings.length ? `<section id="evidence"><h2>Evidence</h2>${keyFindings.map(finding).join("\n")}</section>` : ""}
${report.document ? `<section id="document"><h2>The document, with its marks</h2>${report.document.pages.map(docPage).join("\n")}</section>` : ""}
${routine.length ? `<section id="routine"><h2>Checked, as expected</h2>${routine.map(finding).join("\n")}</section>` : ""}
<section id="not-checked"><h2>Not checked</h2><ul class="limits">${report.notChecked.map((line) => `<li>${say(line)}</li>`).join("")}</ul></section>
</main></body></html>
`;
await write("report/index.html", page);
```

### 6. The check before you stop

Run it after the page is written. It returns what is wrong, and the script stops if anything is: fix the data and write the page
again.

```js
const problems = [];
const attr = (name) => [...page.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const has = async (file) => (await bytes(`report/${file}`).catch(() => 0)) > 0;
const tags = page.match(/<[a-z!][^>]*>/gi) ?? [];   // text is escaped, so a `<` in the page starts a tag
const style = (page.match(/<style>[\s\S]*?<\/style>/) ?? [""])[0];
const banned = tags.some((tag) => /^<(?:script|link|iframe|object|embed|form|base)\b/i.test(tag) || /^<meta\b[^>]*http-equiv/i.test(tag) || /\son[a-z]+\s*=/i.test(tag));
if (banned || /url\(|@import/i.test(style) || /https?:|\/\/[a-z0-9-]+\./i.test(page)) problems.push("the page runs code or loads from outside report/");
if ([...attr("src"), ...attr("href"), ...attr("poster")].some((v) => /^\s*data:/i.test(v))) problems.push("the page uses a data: URL: a picture is a file");
if ([...attr("src"), ...attr("href"), ...attr("poster")].some((v) => /(^|[\/\\])\.\.([\/\\]|$)/.test(v))) problems.push("a path with ../ leaves report/: copy the file in with keep(), or name a film in outside; never write ../");
if (report.outside.some((name) => /[\/\\:]|^\./.test(name))) problems.push("outside names bare file names, never a path");
if ([...(report.rows ?? []), ...report.findings].some((x) => !x.cites?.length)) problems.push("a row or a finding has no cite: leave out what no look read, or put it under what you did not check");
for (const ref of [...attr("src"), ...attr("poster")]) {
  if (/^([a-z][a-z0-9+.-]*:|\/|\.\.)/i.test(ref)) problems.push(`${ref} is not a file in report/`);
  else if (!(await has(ref))) problems.push(`${ref} is missing or empty`);
  else if (ref.startsWith("frames/") && (await bytes(`report/${ref}`)) > BUDGET.frame) problems.push(`${ref} is over ${BUDGET.frame} bytes`);
  else if (ref.startsWith("clips/") && (await bytes(`report/${ref}`)) > BUDGET.clip) problems.push(`${ref} is over ${BUDGET.clip} bytes`);
}
const clips = attr("src").filter((ref) => ref.startsWith("clips/"));
if (new Set(clips).size !== clips.length) problems.push("a clip is shown twice: show a frame of its window instead");
if ((page.match(/<video[^>]*>/g) ?? []).some((tag) => !/ poster="/.test(tag))) problems.push("a clip has no poster");
if (Number((await sh("find report -type f -exec cat {} + | wc -c")).trim()) > BUDGET.folder) problems.push(`report/ is over ${BUDGET.folder} bytes`);
for (const path of [(await sh("pwd")).trim(), (await sh("echo $HOME")).trim()].filter((p) => p.length > 1)) {
  if ((await sh(`grep -rlF ${q(path)} report || true`)).trim()) problems.push("a file in report/ names a path of this machine");
}
const SPAN = "(?:page=[1-9]\\d*|t=\\d+(?:\\.\\d+)?(?:,\\d+(?:\\.\\d+)?)?)", XYWH = "xywh=(?:(?:percent|pixel):)?\\d+(?:\\.\\d+)?(?:,\\d+(?:\\.\\d+)?){3}";
const fragment = new RegExp(`^(?:${SPAN}(?:&${XYWH})?|${XYWH})$`);
const ids = attr("id");
if (new Set(ids).size !== ids.length) problems.push("two things on the page share an id");
for (const href of attr("href").map((h) => h.replaceAll("&amp;", "&"))) {
  const [file, frag = ""] = href.split("#");
  if (!file) { if (!ids.includes(frag)) problems.push(`#${frag} names nothing on the page`); continue; }
  if (/[\/\\:]|^\./.test(file)) problems.push(`${href} is not a file of report/ or a bare file name`);
  else if (!(await has(decodeURIComponent(file))) && !report.outside.includes(decodeURIComponent(file))) problems.push(`${href}: ${file} is neither in report/ nor named in outside`);
  if (frag && !fragment.test(frag)) problems.push(`${href} has a fragment that is not page=, t= or xywh=`);
}
for (const key of attr("data-look")) if (!looks.has(key)) problems.push(`data-look ${key} is no look this run made`);
if ((page.match(/class="cite"/g) ?? []).length !== (page.match(/class="cite" href="[^"]*" data-look=/g) ?? []).length) problems.push("a cite has no data-look");
for (const xywh of attr("data-xywh")) {
  const [x, y, w, h] = xywh.replace("percent:", "").split(",").map(Number);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 100 || y + h > 100) problems.push(`${xywh} is not inside 0 to 100`);
}
if ((page.match(/<figure class="pic">/g) ?? []).length !== (page.match(/<figcaption>\s*[^<\s][^<]*<\/figcaption>/g) ?? []).length) problems.push("a picture has no caption that says why it matters");
if (report.points.length < 1 || report.points.length > 4) problems.push("the answer has one to four key points");
const first = page.indexOf('id="answer"'), firstFinding = page.search(/class="finding[ "]/);   // a finding is open or `finding routine`
if (first < 0 || (firstFinding >= 0 && first > firstFinding)) problems.push("the answer is not first");
if (problems.length) throw new Error(problems.join("\n"));
return { report: "report/index.html", findings: report.findings.length, looks: looks.size, bytes: await bytes("report/index.html") };
```

Also read the page once the way a person does: the first screen says the answer; each finding's words match its picture and its
cites; nothing in the answer is missing from the evidence; a page you did not need is not in it.

## The last message

Short: the answer in a sentence or two, then where the report is. Do not repeat the page.

> The second quarter is the highest bar, and page 3 of the contract sets the rule the talk gave. The report is
> `report/index.html`: the chart with its box and a clip of the moment, and the contract page with its mark.
