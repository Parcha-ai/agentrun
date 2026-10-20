---
name: look
description: Look at many PDF pages, a long video, many images or one region of a picture, by writing code that renders them with bash and has a vision model answer about them (vision.see) or Jev judge them with typed answers, classify them and find things in them (vision.judge). Use when reading the pages or frames one by one would be slow or too much for your context, and cite each answer as file#page=N, file#t=seconds or file#xywh=percent:x,y,w,h.
---

# Look at many pages, a long video or many images

Write the code that does the looking. In code mode, `tools.bash({ command })` runs a command and returns its output, and
`vision.see({ ask, paths, images, fragments })` has a vision model answer `ask` about images. It fits each image to the
model's limits and sends as few requests as fit, so you never resize or count. It returns
`{ text, model, costUsd, receipts, kept }`, with one receipt a request, in order.

- `paths` are image files (PNG, JPEG, WebP, GIF), or short video clips when the vision model takes video. `images` are
  image blocks you already hold.
- `fragments` names where each image came from, in order: images, then paths. The vision model sees the name beside the
  image, and the answer says where it saw a thing. Use `file#page=N`, `file#t=seconds` or
  `file#xywh=percent:x,y,w,h`. A path names itself by default.
- When the images take several requests, `text` has one part a request, each headed by its fragments and receipt.
- Cite the receipts and the place, such as `report.pdf#page=7`.
- A look that cannot be made throws an Error whose message starts with its code: `no_vision_route` (no vision model in
  this run), `over_budget`, `unsupported`, `look_failed`. Catch it to go on with the rest.
- Asking about the same images with the same question again in the same call costs nothing: the answer is kept.
- A PDF with a text layer reads cheaper as text (`read`, or `pdftotext`). Look at scans, charts, stamps and layout.
- Render into a folder of its own under `.look/` and empty it first, so a second run never mixes in pages or frames
  of an earlier file.

## Many PDF pages

Render the pages, then ask in batches and join the answers.

```js
await tools.bash({ command: "rm -rf .look/pages && mkdir -p .look/pages && pdftoppm -cropbox -r 150 -png report.pdf .look/pages/p" });
const pages = (await tools.bash({ command: "ls .look/pages" })).split("\n").filter((name) => name.endsWith(".png")).sort();
const answers = [];
for (let i = 0; i < pages.length; i += 10) {
  const batch = pages.slice(i, i + 10);
  const seen = await vision.see({
    ask: "List every invoice number on these pages with its total.",
    paths: batch.map((name) => `.look/pages/${name}`),
    fragments: batch.map((name) => `report.pdf#page=${parseInt(name.slice(2), 10)}`),
  });
  answers.push(`${seen.text}\n(receipts: ${seen.receipts.join(", ")})`);
}
return answers.join("\n\n");
```

`pdftoppm -f 3 -l 9` renders pages 3 to 9 only. Name the files by page so each fragment is the right page.
`-cropbox` renders the page as a reader shows it (its crop box, not the whole sheet), the area a citation's
`#xywh=percent:` is of.

## A long video

Take a frame every 10 seconds by seeking, and name each by its time.

```js
await tools.bash({ command: "rm -rf .look/frames && mkdir -p .look/frames && d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 talk.mp4) && for t in $(seq 0 10 $(( ${d%.*} - 1 ))); do ffmpeg -v error -y -ss $t -i talk.mp4 -frames:v 1 -q:v 3 .look/frames/$t.jpg; done" });
const times = (await tools.bash({ command: "ls .look/frames" })).split("\n").filter((name) => name.endsWith(".jpg")).map((name) => parseInt(name, 10)).sort((a, b) => a - b);
const seen = await vision.see({
  ask: "When does a chart first appear, and what does it show?",
  paths: times.map((t) => `.look/frames/${t}.jpg`),
  fragments: times.map((t) => `talk.mp4#t=${t}`),
});
return `${seen.text}\n(receipts: ${seen.receipts.join(", ")}; $${seen.costUsd})`;
```

Look again more closely where the answer points: frames every second over that minute. When the vision model takes
video, cut windows instead (`mkdir -p .look/clips && ffmpeg -y -ss 60 -i talk.mp4 -t 30 -c:v libx264 -bf 0 -crf 28 -preset veryfast -c:a aac -b:a 64k -fflags +bitexact -flags +bitexact .look/clips/60.mp4`),
pass the clips as paths and name them `talk.mp4#t=60,90`. Encode the window rather than copy it: a copy starts at the
keyframe before 60 and only its edit list says the window begins at 60, so a decoder that ignores the edit list counts
its seconds from the keyframe; encoded without B-frames, second 0 is 60 for every decoder. The bitexact flags make a
window you cut again the same bytes, so an answer already paid for is found again.

## Many images

```js
const photos = (await tools.bash({ command: "ls photos" })).split("\n").filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
const seen = await vision.see({
  ask: "Which photos show water damage? Name each by its file.",
  paths: photos.map((name) => `photos/${name}`),
});
return seen.text;
```

## A region

Crop first, so the vision model sees that part at full size, and name the crop by where it was.

```js
await tools.bash({ command: "mkdir -p .look && ffmpeg -v error -y -i scan.png -vf crop=iw/2:ih/4:iw/2:0 .look/scan-top-right.png" });
const seen = await vision.see({
  ask: "What is the reference number?",
  paths: [".look/scan-top-right.png"],
  fragments: ["scan.png#xywh=percent:50,0,50,25"],
});
return seen.text;
```

For a PDF page, render only the region at a higher resolution: `mkdir -p .look && pdftoppm -cropbox -f 3 -l 3 -r 300 -x 1275 -y 0 -W 1275 -H 825 -png report.pdf .look/crop`.

## Jev: typed answers about every image, cheap enough to ask many times

`vision.judge({ questions, paths, images, fragments, examples, state })` has Jev answer typed questions about images in
one request: `choice` (one of your labels, with a probability each), `noul` (yes or no, as the probability of yes),
`score` (a level of your rubric) and `box` (where a thing is). It costs a small fraction of a cent, so ask about every
page or frame, and keep `vision.see` for what needs words. The images are `images[0].image`, `images[1].image` and so
on in the questions. It returns `{ answers, model, costUsd, receipts, kept }`.

- A box is always given, even when the thing is absent: ask a noul whether it is there. Its `fragment` is the region
  as `file#xywh=percent:x,y,w,h` of the image its `image` index names (default 0), so you can cite it, crop it, or show it.
- `examples` are images by the key you write for them in a question (`"<roof>"`): classification by example.
- Name a crop by the region it was cut from (`fragments: ["scan.png#xywh=percent:50,0,50,50"]`) and a box found in it
  comes back as a region of the whole.

### Classify every page or frame

```js
await tools.bash({ command: "rm -rf .look/pages && mkdir -p .look/pages && pdftoppm -cropbox -r 100 -png report.pdf .look/pages/p" });
const pages = (await tools.bash({ command: "ls .look/pages" })).split("\n").filter((name) => name.endsWith(".png")).sort();
const found = [];
for (const name of pages) {
  const page = parseInt(name.slice(2), 10);
  const { answers } = await vision.judge({
    paths: [`.look/pages/${name}`],
    fragments: [`report.pdf#page=${page}`],
    questions: {
      kind: { type: "choice", instructions: "What is on `images[0].image`?", criteria: { table: "A table of figures.", chart: "A chart or graph.", text: "Running text.", blank: "Blank or nearly blank." } },
      signed: { type: "noul", instructions: "Does `images[0].image` carry a handwritten signature?" },
    },
  });
  found.push({ page, kind: answers.kind.choice, signed: answers.signed.noul > 0.5 });
}
return found;
```

### Jev before and after the eyes

Skip what is not worth a look (blank, unreadable, off topic), then check what the eyes said.

```js
await tools.bash({ command: "rm -rf .look/pages && mkdir -p .look/pages && pdftoppm -cropbox -r 100 -png report.pdf .look/pages/p" });
const pages = (await tools.bash({ command: "ls .look/pages" })).split("\n").filter((name) => name.endsWith(".png")).sort();
const worth = [];
for (const name of pages) {
  const { answers } = await vision.judge({ paths: [`.look/pages/${name}`], questions: { invoice: { type: "noul", instructions: "Is `images[0].image` a readable page of an invoice?" } } });
  if (answers.invoice.noul > 0.5) worth.push(name);
}
if (!worth.length) return { pages: [], number: null, confirmed: false };
const seen = await vision.see({ ask: "What is the invoice number on this page? Answer with the number only.", paths: [`.look/pages/${worth[0]}`] });
const check = await vision.judge({ paths: [`.look/pages/${worth[0]}`], questions: { same: { type: "noul", instructions: `Does \`images[0].image\` show the invoice number ${seen.text.trim()}?` } } });
return { pages: worth, number: seen.text.trim(), confirmed: check.answers.same.noul > 0.5 };
```

### Classify by example

Say each label in words as well as by example: the two together classify better than an example alone.

```js
const photos = (await tools.bash({ command: "ls photos" })).split("\n").filter((name) => /\.(png|jpe?g)$/i.test(name));
const sorted = {};
for (const name of photos) {
  const { answers } = await vision.judge({
    paths: [`photos/${name}`],
    examples: { "<roof>": "examples/roof.png", "<hall>": "examples/hall.png" },
    questions: { room: { type: "choice", instructions: "Which picture is `images[0].image` most like?", criteria: { roof: "A roof seen from outside, like <roof>", hall: "A hallway indoors, like <hall>", neither: "Neither of these." } } },
  });
  sorted[name] = answers.room.choice;
}
return sorted;
```

### Is it there, and where

```js
const { answers } = await vision.judge({
  paths: ["scan.png"],
  questions: {
    present: { type: "noul", instructions: "Is there a signature in `images[0].image`?" },
    where: { type: "box", instructions: "the signature in `images[0].image`" },
  },
});
return answers.present.noul > 0.5 ? `signature at ${answers.where.fragment}` : "no signature";
```

### A small thing in a large image: tiles, then a box

```js
const tiles = { top_left: "0,0,50,50", top_right: "50,0,50,50", bottom_left: "0,50,50,50", bottom_right: "50,50,50,50" };
await tools.bash({ command: "rm -rf .look/tiles && mkdir -p .look/tiles" });
for (const [t, region] of Object.entries(tiles)) {
  const [x, y] = region.split(",").map(Number);
  await tools.bash({ command: `ffmpeg -v error -y -i scan.png -vf crop=iw/2:ih/2:iw*${x / 100}:ih*${y / 100} .look/tiles/${t}.png` });
}
const pick = await vision.judge({
  paths: ["scan.png"],
  examples: Object.fromEntries(Object.keys(tiles).map((t) => [`<tile ${t}>`, `.look/tiles/${t}.png`])),
  questions: { tile: { type: "choice", instructions: "Which tile of `images[0].image` holds the round stamp?", criteria: Object.fromEntries(Object.keys(tiles).map((t) => [t, `<tile ${t}>`])) } },
});
const t = pick.answers.tile.choice;
const found = await vision.judge({ paths: [`.look/tiles/${t}.png`], fragments: [`scan.png#xywh=percent:${tiles[t]}`], questions: { stamp: { type: "box", instructions: "the round stamp in `images[0].image`" } } });
return found.answers.stamp.fragment;
```

### Check a box's edges

Crop to the box and ask whether the thing goes on past each edge; move out the edges that say yes.

```js
const { answers } = await vision.judge({ paths: ["scan.png"], questions: { table: { type: "box", instructions: "the table in `images[0].image`" } } });
const [x, y, w, h] = answers.table.fragment.split("percent:")[1].split(",").map(Number);
await tools.bash({ command: `mkdir -p .look && ffmpeg -v error -y -i scan.png -vf crop=iw*${w / 100}:ih*${h / 100}:iw*${x / 100}:ih*${y / 100} .look/table.png` });
const edge = (side) => ({ type: "noul", instructions: `Does the table in \`images[0].image\` go on past the ${side} edge of the image?` });
const check = await vision.judge({ paths: [".look/table.png"], fragments: [answers.table.fragment], questions: { left: edge("left"), right: edge("right"), top: edge("top"), bottom: edge("bottom") } });
return Object.entries(check.answers).filter(([, a]) => a.noul > 0.5).map(([side]) => side);
```

## A series of images of one scene over time

When the images are one scene at many dates (a shoreline the water left, a building that went up) and the question is when something changed, answer it place by place, from each place's own picture, never from the scene as a whole.

- Each place the question asks about is its own small box: one contiguous area, such as one cove, one wash or one building, never a region that spans several named places.
- Use the place names the run's own files give (a map key, if there is one), not names of your own.
- For each place, bracket and then bisect the dates on that place's own crop: find the last image where the thing is present and the first where it is gone. Look at the crop at each candidate date. Do not infer a date from a whole-scene average such as "half of its lost water is dry".
- A place is "dry" or "gone" in an image when its crop shows none of it, as the eyes say (`vision.see`) and Jev confirms with a typed question for each crop and each date (`noul`, such as "Is there open water in this crop?"). A pixel mask or a brightness threshold only points where to look and never answers: water can be dark, green, turbid or glinting, and a threshold set on one date misses it on another.

## When pdftoppm or ffmpeg is missing

Never install a program yourself. Check which are missing, then stop and tell the user each one and how to install it:

```sh
for p in pdftoppm pdftotext ffmpeg ffprobe; do command -v "$p" >/dev/null || echo "missing: $p"; done
```

`pdftoppm` and `pdftotext` come with poppler, and `ffprobe` with ffmpeg: `brew install ffmpeg poppler` on macOS, or
`sudo apt-get install ffmpeg poppler-utils` on Debian and Ubuntu, run by the user.
