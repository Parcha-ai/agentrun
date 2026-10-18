---
name: report
description: End a run with your own report, one self-contained, script-free HTML page, report/index.html, that answers in the shape the question asks, states only what the run read (every text is judged against what its cited looks read before the page is written), and shows the evidence for every finding and a thumbnail for every row (the document page with its mark boxed and a close crop, the film moment's frame and a short clip, the photo with what it shows boxed and captioned). Cite every claim as a link to the file's own address (file#page=N, file#t=a,b, file#xywh=percent:x,y,w,h). Use at the end of a run that looked at documents, images or video, so the person sees what you saw and not only your words.
---

# End the run with a report

The last thing a run makes is `report/index.html`: a page a person opens, understands in ten seconds and can check in two
minutes. You write it with code from what the run already holds: the looks' answers, the frames and the keys of the looks.
It is not a form to fill: the same page serves a film, a document or a photo, and you choose what it shows.

## Choose what the page says

- **The answer is in the shape the question asks.** When the question names a shape (minute by minute, page by page, mark by
  mark, a table), the answer section is that shape: one row for each unit, every row cited. Group or fold only the detail
  under a row, never the rows. A question that names no shape gets the sentence and the key points.
- **Never state what the run did not read.** Every name, place, time and number on the page comes from a look's answer or from
  the file's own text, and carries its cite. A caption says what the look saw, not what you remember about the subject.
  What the run did not read is left out; a place it did not look at goes under what you did not check.
- **Ground the page before you write it.** Before the page is written, every text it shows (a finding's words, a caption, a box
  label, a row's text, the answer and its key points) is put to Jev as a text judgment: `vision.judge`, the text as `claims`
  and the answers of the looks it cites as `evidence`, one noul question for each text: does the evidence state every name,
  time and number in it? A text it does not is not kept as it is: rewrite it from what the looks read, cite the look that
  states it, or drop it. What was heard is cited to the transcribe look (`hear()`): a name, a time or a number that was said
  is evidence only in that look's text, not in a picture of the speaker. A presence or an absence ("the seal is on page 1", "the test copy has no stamp") is stated by a typed answer: ask Jev with `decide()` (a noul, "Is there a seal on this page?") and cite that look; Jev's answers reach the evidence as words (`Jev, asked "Is there a seal on contract.pdf#page=3?": no (0.02)`), so an absence is grounded by a cited no. The check refuses a text that was not judged as written.
- **The text is yours, in plain sentences.** Every sentence on the page (a caption, an evidence paragraph, a row) is one plain
  sentence in your own words, drawn from the look's answer: never the answer pasted. The page is HTML, so markdown shows as raw
  symbols (`**`, `##`, a `* ` list mark, backticks); the check refuses them in any text outside `<code>` and `<pre>` and names
  the element.
- **The answer first**, in a sentence or two, then three or four key points, each a link to the finding or the mark it
  stands on. Someone who reads only that much has the answer.
- **Every finding shows its evidence; every row has a thumbnail.** A page that only says is a page nobody checks. Show:
  - **a document:** the page with the cited mark boxed (the embedded page, below) and, in the finding, a close crop of the
    mark with its box in the crop. `crop()` computes the crop and the box in it; you do no arithmetic;
  - **a film:** the cited moment's frame, boxed when the look gave a box, and a short clip of the cited window (a window is
    a clip once; any later use of it is a frame);
  - **a photo:** the photo, boxed when a look gave a box, with a caption that says what it shows;
  - **a row** of a row-shaped answer: a thumbnail of its evidence (`thumb()`), small enough for many rows.
  Each picture has a caption in a sentence, from the look's answer: what it shows and why it matters ("the tallest bar is the
  second quarter's"), not what it is ("a chart"). Drop only a duplicate (the same picture twice) and a picture that shows
  nothing its claim says.
- **Fold the routine.** What was checked and found as expected goes in a folded section (`<details>`), one line each, its
  evidence inside the fold. What surprised, failed or decided the answer is a finding of its own, open, and first.
- **A document is embedded.** When the run read a document, the page shows it as a viewer would: each page the findings
  stand on as an image, in order, with every found mark outlined and labelled on its page (`documents`, one entry for each
  document, one page entry for each page). Each mark links to its finding and back, and the page links to the PDF itself at
  `#page=N`. Every cite of a page of a document has that page embedded: a crop of a mark with no embedded page is not enough,
  and the check refuses a page cite with no page entry.
- **A film is shown by its moments.** A window of the film is one short clip, with a poster that is the window's opening
  frame. The same window is never a clip twice: later it is a frame, from `frame()`, with a box if it has one.
- **What you did not check** is last, and lists only what no look of the run covered: a page, a window of a film, a file the run
  did not look at. It never states a finding, a presence or an absence ("page 2 has no seal"): those are findings, and need
  their look and their cite. If the run looked at a page, that page is not in the list. Each item names its file, its pages
  or seconds and one reason from a short list, and the check refuses an item that a look of the run covers.

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
- **A size budget**, one place to change (`BUDGET`): a picture at most 1600 px wide and 700 KB (960 px for a film frame, about
  900 px for a crop, 240 px for a thumbnail), a clip a few seconds at 480 px, silent unless the sound is the point, at most
  1.5 MB, the folder at most 8 MB. The folder counts toward the recording's own 10 MB, so 8 MB leaves the run its events.
  With many clips, lower `BUDGET.clip` first (about 800 KB for ten): `clip()` re-encodes down a ladder until a clip fits. When
  the folder is still over, the check names the largest files: shorten a clip, drop a duplicate, or drop a picture that shows
  nothing its claim says.
- **No metadata, no machine.** Frames, photos and clips are re-encoded with their metadata stripped (`-map_metadata -1`; a
  clip keeps only its codec's own name). No file names the machine's paths, the home directory or a key; a path in the page
  is the run's own relative one.
- **Cites in the file's own address**, labelled with that number: `contract.pdf#page=3` (the page's index from 1, never the
  number printed on it), `talk.mp4#t=21.5` or `#t=18,26`, a box on a page `contract.pdf#page=3&xywh=percent:7,6,70,4`, a
  box on a film `talk.mp4#t=21.5&xywh=percent:61,40,12,9`, a box on a photo `photo.jpg#xywh=percent:10,20,30,15`
  (`pixel:` for pixel boxes). Every cite carries `data-look`, the key of the look it rests on, so the viewer can open that
  look at that fragment. A claim with no look behind it is not a finding: look first, or leave it out.
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

A film frame, a page of a PDF and a photo each become a JPEG under `report/frames/`; a mark on a picture becomes a close crop
and a row's evidence a thumbnail, in the same folder; a window of a film becomes a silent MP4 under `report/clips/` with its
poster, re-encoded down a ladder until it fits; a document or photo the page cites is copied beside it.
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
const around = (at) => {   // the crop that frames a mark (x,y,w,h in percent of its picture) with room around it, and the mark's box in the crop
  const [x, y, w, h] = at.split(",").map(Number), r2 = (n) => Math.round(n * 100) / 100;
  const padX = Math.max(w * 0.6, 4), padY = Math.max(h * 0.6, 4);
  const cx = Math.max(0, x - padX), cy = Math.max(0, y - padY), cw = Math.min(100, x + w + padX) - cx, ch = Math.min(100, y + h + padY) - cy;
  const bx = r2(((x - cx) / cw) * 100), by = r2(((y - cy) / ch) * 100);
  return { from: [cx, cy, cw, ch], box: [bx, by, Math.min(r2((w / cw) * 100), r2(100 - bx)), Math.min(r2((h / ch) * 100), r2(100 - by))].join(",") };
};
const crop = async (picture, at, name) => {   // a close crop of a mark on a picture of report/: { src, box } with the box inside the crop
  const { from: [cx, cy, cw, ch], box } = around(at);
  await sh(`ffmpeg -v error -y -i ${q(`report/${picture}`)} -vf "crop=iw*${cw}/100:ih*${ch}/100:iw*${cx}/100:ih*${cy}/100,scale='min(900,max(iw,480))':-2:flags=lanczos" ${jpeg} report/frames/${slug(name)}.jpg`);
  return { src: `frames/${name}.jpg`, box };
};
const thumb = async (source, name, { t = 0 } = {}) => {   // a small picture of a row's evidence: a picture of report/, or a moment of a film
  await sh(`mkdir -p report/frames && ffmpeg -v error -y ${/\.(mp4|mov|webm|mkv)$/i.test(source) ? `-ss ${t} -i ${q(source)}` : `-i ${q(`report/${source}`)}`} -frames:v 1 -vf "scale=240:-2" -map_metadata -1 -fflags +bitexact -q:v 8 report/frames/${slug(name)}.jpg`);
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
receipt's path, and say what it covered with `cover("file#page=2")` (`look()`, `decide()` and `hear()` do that for their own looks), since the list of what you did not check is what no look covered. `said` holds what each look read, by key, for the grounding step: a look you read yourself is put there by `look()` and `hear()`, and one you read from a receipt by `keyOf`.

```js
const looks = new Set(), said = new Map(), covered = [];   // said: look key -> what the look read; covered: what the run looked at, as { file, pages?: [from, to], t?: [from, to] }
const jevWords = (args, body) => {   // Jev's typed answers as words: a yes, a no, a choice, a score or a place is evidence of presence or absence
  let asked, answers;
  try { asked = JSON.parse(args.ask); answers = JSON.parse(body); } catch { return body; }
  const sources = String(args.path ?? "").split(", ");
  const about = (text) => String(text ?? "").replace(/`?images\[(\d+)\]\.image`?/g, (_, i) => sources[Number(i)] ?? "the picture");
  return Object.entries(answers).map(([name, a]) => {
    const said = a.type === "noul" ? `${a.noul >= 0.5 ? "yes" : "no"} (${a.noul})`
      : a.type === "choice" ? `${a.choice}${a.confidence != null ? ` (${a.confidence})` : ""}`
      : a.type === "score" ? `score ${a.score}${a.legend?.[a.score] ? ` (${a.legend[a.score]})` : ""}`
      : a.type === "box" ? `located at ${a.fragment ?? "a region of the picture"}${a.confidence != null ? ` (confidence ${a.confidence})` : ""}` : JSON.stringify(a);
    return `Jev, asked "${about(asked[name]?.instructions ?? name)}": ${said}`;
  }).join("\n");
};
const keyOf = async (receipt) => {
  if (!receipt) throw new Error("no receipt: this host files none, so there is no look to cite");
  const text = await sh(`cat ${q(receipt)}`).catch(() => sh(`cat ${q(`../${receipt}`)}`));   // a host may file receipts in the folder above the workspace
  let key, status, args, body = "";
  try { ({ status, args, body = "", facts: { key } } = JSON.parse(text)); } catch {
    const header = text.split("\n---")[0].split("\n"), field = (name) => header.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
    key = field("key"); status = field("status"); body = text.split("\n---\n").slice(1).join("\n---\n");
    try { args = JSON.parse(field("args")); } catch { args = undefined; }
  }
  if (!key) throw new Error(`${receipt} holds no look key`);
  if (status === "failed") throw new Error(`${receipt} is a look that failed: it is no evidence for a finding`);
  looks.add(key);
  if (typeof body === "string" && body.trim() && !said.has(key)) said.set(key, args?.via === "jev" ? jevWords(args, body.trim()) : body.trim());
  return key;
};
const cover = (fragment) => {   // "file#page=3", "file#page=1-4", "file#t=18,26", "file#t=21.5&xywh=...", or a bare file: put a look made earlier here too
  const [, file, frag = ""] = /^(.*)#((?:page|t|xywh)=[^#]*)$/.exec(fragment) ?? [, fragment];   // a `#` inside a file name is not a fragment
  const page = /(?:^|&)page=(\d+)(?:-(\d+))?/.exec(frag), time = /(?:^|&)t=([\d.]+)(?:,([\d.]+))?/.exec(frag);
  covered.push({ file, ...(page ? { pages: [Number(page[1]), Number(page[2] ?? page[1])] } : {}), ...(time ? { t: [Number(time[1]), Number(time[2] ?? time[1])] } : {}) });
};
const look = async (path, fragment, ask) => {
  const seen = await vision.see({ ask, paths: [path], fragments: [fragment] });
  cover(fragment);
  const key = await keyOf(seen.receipts[0]);
  said.set(key, seen.text.trim());
  return { key, text: seen.text.trim() };
};
const decide = async (path, fragment, questions) => {   // Jev's typed answers about a picture: cite this look for any presence or absence you state
  const decided = await vision.judge({ paths: [path], fragments: [fragment], questions });
  cover(fragment);
  return { key: await keyOf(decided.receipts[0]), answers: decided.answers };
};
const hear = async (path, fragment) => {   // what was said in a recording: cite this look for any name, time or number that was heard
  // The whole file at `path` is transcribed. For audio cut from a longer recording, `fragment` is the source address of the cut ("talk.mp4#t=30,36"), which is what was heard.
  if (fragment !== undefined && !/^.+#(?:page|t|xywh)=/.test(fragment)) throw new Error(`${fragment} is not the source address of ${path}: cut the audio first, then pass its source as file#t=from,to`);
  const heard = await vision.transcribe({ path, ...(fragment ? { fragment } : {}) });
  cover(fragment ?? path);
  const key = await keyOf(heard.receipts[0]);
  said.set(key, heard.text.trim());
  return { key, text: heard.text.trim() };
};
```

### 4. The findings, as data

Everything the page says is data here first. The file names are the run's own; the times, pages and percentages come from the
looks you made (a `vision.judge` box answer carries its `fragment`; `find` and `look` say where a thing is). A finding is a
key one (open) or `routine` (folded). A box belongs to a finding and links back to it; `points` are the three or four key
points of the answer. When the question names a shape, add `rows` to the report, one for each unit it names:
`rows: [{ id: "m1", label: "0:00 to 1:00", text: "what the look read there", thumb: await thumb("talk.mp4", "m1-thumb", { t: 30 }), cites: [{ file: "talk.mp4", t: [0, 60], look: lookTalk.key }] }]`.
A claim about what was said cites the look of `hear()`, made in piece 3's way: `const said1 = await hear("talk.mp4")`, then `look: said1.key`.
A mark on a document page gets `crop()` for its finding and its box on the embedded page; a film moment gets `frame()` and the window's `clip()`; a photo gets `photo()`.
An embedded page takes its look from a cite of that page of that document, in a finding or a row, or from a `look` of its own.

```js
const talk = await frame("talk.mp4", 21.5, "talk-chart");
const later = await frame("talk.mp4", 24, "talk-later");   // the same window again: a frame, never a second clip
const page3 = await pdfPage("contract.pdf", 3, "contract-p3");
const site = await photo("photo.jpg", "site-photo");
const lookTalk = await look(`report/${talk}`, "talk.mp4#t=21.5", "What does the chart on the screen show?");
const lookPage = await look(`report/${page3}`, "contract.pdf#page=3", "What rule does this page set?");
const lookSite = await look(`report/${site}`, "photo.jpg", "What is in the photo?");
const rule = await crop(page3, "7,6,70,4", "contract-rule");   // the mark, close, and its box in the crop

const report = {
  title: "The talk, the contract and the site",
  question: "Does the chart agree with the contract, and what does the site look like?",
  answer: "Yes. The chart shows the second quarter highest, and page 3 of the contract sets the record-keeping rule the talk gave.",
  points: [{ label: "Chart peak", value: "second quarter", to: "f-chart" }, { label: "Contract rule", value: "page 3", to: "f-contract" }],
  findings: [
    { id: "chart", title: "The chart shows the second quarter highest", why: "On screen, the chart's second bar is the tallest, so the second quarter is the peak.",   // your sentence, drawn from lookTalk.text, never that text pasted
      pics: [
        { src: talk, alt: "A bar chart with the second bar tallest", caption: "The tallest bar is the second quarter's, the figure the answer rests on.",
          boxes: [{ id: "mark-peak", finding: "chart", at: "61.2,40,12,9", label: "second quarter", look: lookTalk.key }] },
        { src: later, alt: "The same chart a moment later", caption: "A moment later the chart has not changed, so the reading holds." },
      ],
      clip: { ...(await clip("talk.mp4", 18, 26, "talk-chart")), caption: "The eight seconds around the chart." },
      cites: [{ file: "talk.mp4", t: [21.5], xywh: "percent:61.2,40,12,9", look: lookTalk.key }, { file: "talk.mp4", t: [18, 26], look: lookTalk.key }] },
    { id: "contract", title: "The contract sets the rule on page 3", why: "Page 3 sets the record-keeping rule in its first clause.",
      pics: [{ src: rule.src, alt: "The rule, cropped from page 3", caption: "The rule as the page prints it, the clause the answer rests on.", mark: "mark-rule",
               boxes: [{ id: "crop-rule", finding: "contract", at: rule.box, label: "the rule", look: lookPage.key }] }],
      cites: [{ file: "contract.pdf", page: 3, xywh: "percent:7,6,70,4", look: lookPage.key }] },
    { id: "site", routine: true, title: "The site", why: "The photo shows the site as it was visited; nothing in it bears on the answer.",
      pics: [{ src: site, alt: "A photo of the site", caption: "The site as photographed; nothing in it bears on the answer, so it is kept as the record of the visit." }],
      cites: [{ file: await keep("photo.jpg"), look: lookSite.key }] },
  ],
  documents: [{ id: "contract", file: await keep("contract.pdf"), pages: [{ n: 3, src: page3, boxes: [{ id: "mark-rule", finding: "contract", at: "7,6,70,4", label: "the rule", look: lookPage.key }] }] }],
  outside: ["talk.mp4"],   // a film is cited by its own name and not copied; every other cited file was kept above
  notChecked: [{ file: "talk.mp4", t: [30, 40], why: "not looked at" }, { file: "contract.pdf", pages: [1, 2, 4], why: "not looked at" }],   // only what no look covered; never a finding or an absence
};
```

### 5. Ground the claims

Run after the data and before the page, and again whenever a text changes. Each finding, each row and the answer is one
request to Jev with no image: `state` holds `claims` (each text it shows) and `evidence` (what the looks it cites read), and
each text is one noul question, which Jev answers as the probability that the evidence states every name, time and number in
it. A text whose answer is under `GROUNDED` stops the script, naming it. Fix the data (rewrite, re-cite or drop it) and run
the pieces again; a judgment you already paid for in the call is read back, not paid twice. The usual failure is a finding that states what a look read but cites only another look: cite every look the text rests on. A text with no cited look that
read anything has no evidence and fails the same way.

```js
const GROUNDED = 0.5;   // noul is the probability of yes: 0.66 to 0.98 when the evidence gave the fact, 0.01 to 0.03 when it did not
const verdicts = new Map();
const claimsOf = (r) => {   // every text the page states, in units that each cite their own looks
  const cited = (x) => (x.cites ?? []).map((c) => c.look);
  const labelsOf = (id) => (r.documents ?? []).flatMap((d) => d.pages.flatMap((p) => { const mine = (p.boxes ?? []).filter((b) => b.finding === id); return mine.length ? [p.alt, ...mine.map((b) => b.label)] : []; }));   // a page's own alt text goes with the finding its marks belong to
  const picTexts = (p) => [p.caption, p.alt, ...(p.boxes ?? []).map((b) => b.label)];
  const all = [...r.findings, ...(r.rows ?? [])];
  return [
    ...r.findings.map((f) => ({ id: `finding ${f.id}`, keys: cited(f), cites: f.cites ?? [], texts: [f.title, f.why, ...(f.pics ?? []).flatMap(picTexts), f.clip?.caption, ...labelsOf(f.id)].filter(Boolean) })),
    ...(r.rows ?? []).map((x) => ({ id: `row ${x.id}`, keys: cited(x), cites: x.cites ?? [], texts: [x.label, x.text].filter(Boolean) })),
    { id: "the answer", keys: all.flatMap(cited), cites: all.flatMap((x) => x.cites ?? []), texts: [r.title, r.question, r.answer, ...r.points.map((p) => `${p.label}: ${p.value}`)].filter(Boolean) },
  ];
};
const addressOf = (c) => [c.file, c.page && `page ${c.page}`, c.t && `seconds ${c.t.join(" to ")}`, c.xywh && `region ${c.xywh}`].filter(Boolean).join(", ");   // where the cite points: a fact of the run, not a claim
const verdictKey = (unit, text) => `${[...new Set(unit.keys)].sort().join(",")}\n${[...new Set(unit.cites.map(addressOf))].sort().join("|")}\n${text}`;   // the looks and the addresses are the evidence: change either and the text is judged again
const ground = async () => {   // evidence: what each cited look read, and the address each cite names ("Cited: contract.pdf, page 3")
  const failed = [];
  for (const unit of claimsOf(report)) {
    if (!unit.keys.length) continue;   // no look cited: the check refuses it as uncited
    const read = [...new Set(unit.keys)].map((key) => said.get(key)).filter(Boolean);
    const evidence = [...read, ...[...new Set(unit.cites.map(addressOf))].map((address) => `Cited: ${address}`)];
    const ask = (i) => ({ type: "noul", instructions: `Does \`evidence\` state every name, time and number in \`claims.t${i}\`? Say yes only when each name, place, date, time, quantity and title in it is given by \`evidence\`, or is a plain restatement of something it gives; a name, date, number or title that \`evidence\` does not give is a no, even when it is true or well known.` });
    const { answers } = read.length ? await vision.judge({ state: { claims: Object.fromEntries(unit.texts.map((text, i) => [`t${i}`, text])), evidence }, questions: Object.fromEntries(unit.texts.map((_, i) => [`t${i}`, ask(i)])) }) : { answers: {} };
    unit.texts.forEach((text, i) => {
      const yes = answers[`t${i}`]?.noul ?? 0;
      verdicts.set(verdictKey(unit, text), yes);
      if (yes < GROUNDED) failed.push(`${unit.id}: "${text.slice(0, 80)}" is not stated by what its cited looks read (${yes.toFixed(2)})`);
    });
  }
  if (failed.length) throw new Error(`${failed.join("\n")}\nRewrite each from what the looks read, cite the look that states it, or drop it; then run the pieces again.`);
};
await ground();
```

### 6. The page

One function for each part, so a finding with a clip and boxes, or with neither, is the same code. The page is written once, at
the end.

```js
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const say = (text) => esc(String(text).replace(/\b(?:https?|ftp|file):(?:\/\/)?/gi, "").replace(/\bmailto:/gi, "").replace(/(^|[\s(])\/\/(?=[a-z0-9-]+\.)/gi, "$1"));
const num = (n) => String(Number(Number(n).toFixed(2)));
const part = (c) => [c.page && `page=${c.page}`, c.t && `t=${c.t.map(num).join(",")}`, c.xywh && `xywh=${c.xywh}`].filter(Boolean).join("&");
const label = (c) => c.page ? `p. ${c.page}` : c.t ? `${c.t.map(num).join(" to ")} s` : c.xywh ? `box ${c.xywh.replace(/^percent:/, "").replace(/^pixel:/, "px ")}` : "file";
const cite = (c) => `<a class="cite" href="${encodeURIComponent(c.file)}${part(c) ? `#${esc(part(c))}` : ""}" data-look="${esc(c.look)}">${esc(label(c))}</a>`;
const box = (b) => { const [x, y, w, h] = b.at.split(",");
  return `<div class="mark${Number(x) + Number(w) / 2 > 50 ? " right" : ""}" id="${esc(b.id)}" data-xywh="percent:${esc(b.at)}" data-look="${esc(b.look)}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><a class="tag" href="#f-${esc(b.finding)}">${say(b.label)}</a></div>`; };
const sheet = (p) => `<div class="sheet"><img src="${esc(p.src)}" alt="${say(p.alt)}" loading="lazy">${(p.boxes ?? []).map(box).join("")}</div>`;
const pic = (p) => `<figure class="pic"${p.mark ? ` data-mark="${esc(p.mark)}"` : ""}>${sheet(p)}<figcaption>${say(p.caption)}</figcaption></figure>`;
const movie = (c) => `<figure class="pic"><video controls muted playsinline preload="metadata" poster="${esc(c.poster)}"><source src="${esc(c.src)}" type="video/mp4"></video><figcaption>${say(c.caption)}</figcaption></figure>`;
const documents = report.documents ?? [];
const spots = [...documents.flatMap((d) => d.pages.flatMap((p) => (p.boxes ?? []).map((b) => [b, `p. ${p.n}`]))), ...report.findings.flatMap((f) => (f.pics ?? []).flatMap((p) => (p.boxes ?? []).map((b) => [b, "the picture"])))];
const where = (id) => spots.filter(([b]) => b.finding === id).map(([b, at]) => `<a class="jump" href="#${esc(b.id)}">show on ${at}</a>`).join(" ");
const body = (f) => `<h3>${say(f.title)}</h3><p>${say(f.why)}</p>
<div class="media">${(f.pics ?? []).map(pic).join("")}${f.clip ? movie(f.clip) : ""}</div>
<p class="cites">${f.cites.map(cite).join(" ")} ${where(f.id)}</p>`;
const finding = (f) => f.routine
  ? `<details class="finding routine" id="f-${f.id}"><summary>${say(f.title)}</summary>${body(f)}</details>`
  : `<article class="finding" id="f-${f.id}">${body(f)}</article>`;
const rows = (list) => list.length ? `<ol class="rows">${list.map((r) => `<li class="row" id="r-${esc(r.id)}"><img class="thumb" src="${esc(r.thumb)}" alt="${say(r.text)}" loading="lazy"><span class="when">${say(r.label)}</span><span class="what">${say(r.text)}</span><span class="cites">${r.cites.map(cite).join(" ")}</span></li>`).join("")}</ol>` : "";
const span = (n) => n.pages ? `page${n.pages.length > 1 ? "s" : ""} ${n.pages.join(", ")}` : n.t ? `${n.t.map(num).join(" to ")} s` : "the whole file";
const limit = (n) => `<li>${say(n.file)}, ${span(n)}: ${say(n.why)}</li>`;
const docPage = (d, p) => `<figure class="docpage" id="${esc(d.id)}-p${p.n}"><header><span class="n">${say(documents.length > 1 ? `${d.file}, ` : "")}p. ${p.n}</span><a class="cite" href="${encodeURIComponent(d.file)}#page=${p.n}" data-look="${esc(p.look ?? [...(report.rows ?? []), ...report.findings].flatMap((x) => x.cites).find((c) => c.file === d.file && c.page === p.n)?.look ?? "")}">open at p. ${p.n}</a></header>${sheet({ ...p, alt: p.alt ?? `Page ${p.n} of ${d.file}` })}</figure>`;

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
.rows{list-style:none;margin:1rem 0 0;padding:0}.row{display:flex;flex-wrap:wrap;gap:.3rem .8rem;align-items:baseline;border-top:1px solid var(--line);padding:.5rem 0}.thumb{width:6rem;height:auto;border:1px solid var(--line);border-radius:.3rem;flex:none}.when{font:700 .85rem ui-monospace,monospace;min-width:6rem}.what{flex:1 1 14rem}.row .cites{margin:0 0 0 auto}
.docpage{margin:0 0 1.2rem;scroll-margin-top:1rem}.docpage>header{display:flex;justify-content:space-between;align-items:center}.n{font:700 .85rem ui-monospace,monospace}ul.limits{color:var(--mute);padding-left:1.2rem}`;

const renderPage = () => {   // the page is a pure function of `report`: the check renders it again and compares
const keyFindings = report.findings.filter((f) => !f.routine), routine = report.findings.filter((f) => f.routine);
return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${say(report.title)}</title><style>${css}</style></head>
<body><main>
<header><h1>${say(report.title)}</h1><p class="question">${say(report.question)}</p></header>
<section id="answer" aria-label="Answer"><p>${say(report.answer)}</p><ul class="points">${report.points.map((p) => `<li><small>${say(p.label)}</small><a href="#${esc(p.to)}">${say(p.value)}</a></li>`).join("")}</ul>${rows(report.rows ?? [])}</section>
${keyFindings.length ? `<section id="evidence"><h2>Evidence</h2>${keyFindings.map(finding).join("\n")}</section>` : ""}
${documents.length ? `<section id="document"><h2>${documents.length > 1 ? "The documents" : "The document"}, with their marks</h2>${documents.flatMap((d) => d.pages.map((p) => docPage(d, p))).join("\n")}</section>` : ""}
${routine.length ? `<section id="routine"><h2>Checked, as expected</h2>${routine.map(finding).join("\n")}</section>` : ""}
${report.notChecked.length ? `<section id="not-checked"><h2>Not checked</h2><ul class="limits">${report.notChecked.map(limit).join("")}</ul></section>` : ""}
</main></body></html>
`;
};
const page = renderPage();
await write("report/index.html", page);
```

### 7. The check before you stop

Run it after the page is written. It returns what is wrong, and the script stops if anything is: fix the data and write the page
again.

```js
const problems = [];
const fresh = (await sh("mktemp -d")).trim();   // a directory of its own, removed after: the page is what the data renders, nothing more
await write(`${fresh}/index.html`, renderPage());
if ((await sh(`cmp -s report/index.html ${q(`${fresh}/index.html`)} && echo same || echo changed; rm -rf ${q(fresh)}`)).trim() !== "same") problems.push("report/index.html is not what the data renders: change the data (the texts are judged) and write the page again, never the page");
const attr = (name) => [...page.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const has = async (file) => (await bytes(`report/${file}`).catch(() => 0)) > 0;
const tags = page.match(/<[a-z!][^>]*>/gi) ?? [];   // text is escaped, so a `<` in the page starts a tag
const style = (page.match(/<style>[\s\S]*?<\/style>/) ?? [""])[0];
const banned = tags.some((tag) => /^<(?:script|link|iframe|object|embed|form|base)\b/i.test(tag) || /^<meta\b[^>]*http-equiv/i.test(tag) || /\son[a-z]+\s*=/i.test(tag));
if (banned || /url\(|@import/i.test(style) || /https?:|\/\/[a-z0-9-]+\./i.test(page)) problems.push("the page runs code or loads from outside report/");
if ([...attr("src"), ...attr("href"), ...attr("poster")].some((v) => /^\s*data:/i.test(v))) problems.push("the page uses a data: URL: a picture is a file");
if ([...attr("src"), ...attr("href"), ...attr("poster")].some((v) => /(^|[\/\\])\.\.([\/\\]|$)/.test(v))) problems.push("a path with ../ leaves report/: copy the file in with keep(), or name a film in outside; never write ../");
if (report.outside.some((name) => /[\/\\:]|^\./.test(name))) problems.push("outside names bare file names, never a path");
if ([...(report.rows ?? []), ...report.findings].some((x) => !x.cites?.length)) problems.push("a row or a finding has no cite: leave out what no look read");
const REASONS = ["not looked at", "out of budget", "could not be read"];
const seen = [...covered, ...[...(report.rows ?? []), ...report.findings].flatMap((x) => x.cites).map((c) => ({ file: c.file, ...(c.page ? { pages: [c.page, c.page] } : {}), ...(c.t ? { t: [c.t[0], c.t.at(-1)] } : {}) }))];
const meets = (a, b) => a[0] <= b[1] && b[0] <= a[1];   // two closed spans share a page or a second
const covers = (s, n) => s.file === n.file && (n.pages ? !s.pages && !s.t || (s.pages && n.pages.some((p) => meets(s.pages, [p, p])))
  : n.t ? !s.pages && !s.t || (s.t && (s.t[0] === s.t[1] ? s.t[0] >= n.t[0] && s.t[0] <= n.t[1] : Math.max(s.t[0], n.t[0]) < Math.min(s.t[1], n.t[1]))) : true);
const whole = (v) => typeof v === "number" && Number.isFinite(v);
for (const n of report.notChecked) {
  const bad = typeof n !== "object" || !n || typeof n.file !== "string" || !n.file.trim() || !REASONS.includes(n.why) || (n.pages && n.t)
    || (n.pages && !(Array.isArray(n.pages) && n.pages.length && n.pages.every((p) => Number.isInteger(p) && p >= 1)))
    || (n.t && !(Array.isArray(n.t) && n.t.length === 2 && n.t.every((s) => whole(s) && s >= 0) && n.t[0] < n.t[1]));
  if (bad) problems.push(`${JSON.stringify(n).slice(0, 80)} is not an item of notChecked: { file, pages or t: [from, to], why }, with why one of ${REASONS.join(", ")}; a finding or an absence is not listed here`);
  else if (seen.some((s) => covers(s, n))) problems.push(`${n.file}, ${span(n)}: listed as not checked, but a look of this run covers it: take it out of the list`);
}
for (const ref of [...attr("src"), ...attr("poster")]) {
  if (/^([a-z][a-z0-9+.-]*:|\/|\.\.)/i.test(ref)) problems.push(`${ref} is not a file in report/`);
  else if (!(await has(ref))) problems.push(`${ref} is missing or empty`);
  else if (ref.startsWith("frames/") && (await bytes(`report/${ref}`)) > BUDGET.frame) problems.push(`${ref} is over ${BUDGET.frame} bytes`);
  else if (ref.startsWith("clips/") && (await bytes(`report/${ref}`)) > BUDGET.clip) problems.push(`${ref} is over ${BUDGET.clip} bytes`);
}
const clips = attr("src").filter((ref) => ref.startsWith("clips/"));
if (new Set(clips).size !== clips.length) problems.push("a clip is shown twice: show a frame of its window instead");
if ((page.match(/<video[^>]*>/g) ?? []).some((tag) => !/ poster="/.test(tag))) problems.push("a clip has no poster");
if (Number((await sh("find report -type f -exec cat {} + | wc -c")).trim()) > BUDGET.folder) problems.push(`report/ is over ${BUDGET.folder} bytes; the largest files:\n${(await sh("find report -type f -printf '%s %p\\n' | sort -rn | head -4")).trim()}`);
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
if ((page.match(/<figure class="pic"[^>]*>/g) ?? []).length !== (page.match(/<figcaption>\s*[^<\s][^<]*<\/figcaption>/g) ?? []).length) problems.push("a picture has no caption that says what it shows and why it matters");
for (const f of report.findings) if (!(f.pics?.length || f.clip)) problems.push(`finding ${f.id} shows no picture or clip: show its evidence`);
for (const r of report.rows ?? []) if (!r.thumb) problems.push(`row ${r.id} has no thumbnail`);
for (const b of documents.flatMap((d) => d.pages.flatMap((p) => p.boxes ?? []))) if (!page.includes(`data-mark="${b.id}"`)) problems.push(`the mark ${b.id} has no close crop in its finding`);
const embedded = documents.flatMap((d) => d.pages.map((p) => `${d.file}#${p.n}`));
for (const c of [...(report.rows ?? []), ...report.findings].flatMap((x) => x.cites)) if (c.page && !embedded.includes(`${c.file}#${c.page}`)) problems.push(`${c.file} page ${c.page} is cited but no embedded page shows it: add it to documents with its marks, and a crop of each mark in its finding`);
const shown = attr("src").filter((ref) => ref.startsWith("frames/"));
if (new Set(shown).size !== shown.length) problems.push("a picture is shown twice: drop the duplicate");
if (report.points.length < 1 || report.points.length > 4) problems.push("the answer has one to four key points");
const first = page.indexOf('id="answer"'), firstFinding = page.search(/class="finding[ "]/);   // a finding is open or `finding routine`
if (first < 0 || (firstFinding >= 0 && first > firstFinding)) problems.push("the answer is not first");
let owner = "";
const named = (tag) => `<${/^<([a-z0-9]+)/i.exec(tag)?.[1] ?? "page"}${/ id="([^"]*)"/.exec(tag)?.[0] ?? ""}>`;
for (const part of page.replace(/<(style|code|pre)\b[\s\S]*?<\/\1>/gi, "").split(/(<[^>]*>)/)) {   // the visible text, outside code and pre, and the element it sits in
  if (part.startsWith("<")) { if (!part.startsWith("</")) owner = part; continue; }
  const marker = /\*\*|##|`|(?:^|\n)\s*\* |(?:^|\n)\s*#{1,6}\s/.exec(part);
  if (marker) problems.push(`${named(owner)} carries markdown (${JSON.stringify(marker[0].trim() || marker[0])}): write your own plain sentence from the look's answer, never the answer pasted`);
}
for (const unit of claimsOf(report)) for (const text of unit.texts) if (!(verdicts.get(verdictKey(unit, text)) >= GROUNDED)) problems.push(`${unit.id}: "${text.slice(0, 60)}" was not judged as written against what its looks read: run the grounding step again`);
if (problems.length) throw new Error(problems.join("\n"));
return { report: "report/index.html", findings: report.findings.length, looks: looks.size, bytes: await bytes("report/index.html") };
```

Also read the page once the way a person does: the first screen says the answer; each finding's words match its picture and its
cites; nothing in the answer is missing from the evidence; a page you did not need is not in it.

## The last message

Short: the answer in a sentence or two, then where the report is and that it holds the evidence. Do not repeat the page.

> The second quarter is the highest bar, and page 3 of the contract sets the rule the talk gave. The report is
> `report/index.html`, and it holds the evidence: the chart with its box and a clip of the moment, and the contract page
> with its mark and a close crop of it.
