---
name: look
description: Look at many PDF pages, a long video, many images or one region of a picture, by writing code that renders them with bash and has a vision model answer about them with vision.see. Use when reading the pages or frames one by one would be slow or too much for your context, and cite each answer as file#page=N or file#t=seconds.
---

# Look at many pages, a long video or many images

Write the code that does the looking. In code mode, `tools.bash({ command })` runs a command and returns its output, and
`vision.see({ ask, paths, images, fragments })` has a vision model answer `ask` about images. It fits each image to the
model's limits and sends as few requests as fit, so you never resize or count. It returns
`{ text, model, costUsd, receipt, kept }`.

- `paths` are image files (PNG, JPEG, WebP, GIF), or short video clips when the vision model takes video. `images` are
  image blocks you already hold.
- `fragments` names where each image came from, in order: images, then paths. The vision model sees the name beside the
  image, and the answer says where it saw a thing. Use `file#page=N`, `file#t=seconds` or
  `file#xywh=percent:x,y,w,h`. A path names itself by default.
- When the images take several requests, `text` has one part a request, each headed by its fragments and receipt.
- Cite the receipt and the place, such as `report.pdf#page=7`.
- A look that cannot be made throws an Error whose message starts with its code: `no_vision_route` (no vision model in
  this run), `over_budget`, `unsupported`, `look_failed`. Catch it to go on with the rest.
- Asking about the same images with the same question again in the same call costs nothing: the answer is kept.
- A PDF with a text layer reads cheaper as text (`read`, or `pdftotext`). Look at scans, charts, stamps and layout.
- Render into a folder of its own under `.look/` and empty it first, so a second run never mixes in pages or frames
  of an earlier file.

## Many PDF pages

Render the pages, then ask in batches and join the answers.

```js
await tools.bash({ command: "rm -rf .look/pages && mkdir -p .look/pages && pdftoppm -r 150 -png report.pdf .look/pages/p" });
const pages = (await tools.bash({ command: "ls .look/pages" })).split("\n").filter((name) => name.endsWith(".png")).sort();
const answers = [];
for (let i = 0; i < pages.length; i += 10) {
  const batch = pages.slice(i, i + 10);
  const seen = await vision.see({
    ask: "List every invoice number on these pages with its total.",
    paths: batch.map((name) => `.look/pages/${name}`),
    fragments: batch.map((name) => `report.pdf#page=${parseInt(name.slice(2), 10)}`),
  });
  answers.push(`${seen.text}\n(receipt: ${seen.receipt})`);
}
return answers.join("\n\n");
```

`pdftoppm -f 3 -l 9` renders pages 3 to 9 only. Name the files by page so each fragment is the right page.

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
return `${seen.text}\n(receipt: ${seen.receipt}, $${seen.costUsd})`;
```

Look again more closely where the answer points: frames every second over that minute. When the vision model takes
video, cut windows instead (`ffmpeg -y -ss 60 -t 30 -i talk.mp4 -c copy .look/clips/60.mp4`), pass the clips as paths and name
them `talk.mp4#t=60,90`.

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

For a PDF page, render only the region at a higher resolution: `pdftoppm -f 3 -l 3 -r 300 -x 1275 -y 0 -W 1275 -H 825 -png report.pdf .look/crop`.

## When pdftoppm or ffmpeg is missing

Install them where bash runs:

```sh
command -v pdftoppm || sudo apt-get install -y poppler-utils   # Debian, Ubuntu
command -v ffmpeg || sudo apt-get install -y ffmpeg
brew install poppler ffmpeg                                     # macOS
```

Without the rights to install, tell the user which program is missing.
