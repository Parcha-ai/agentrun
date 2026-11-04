// A generated page shaped like a big downloads listing (go.dev/dl answers 3.15 MB of it): a head with a script and a
// style, then a table for each release, a row for each file. Every name is made from its release and file numbers, so
// the page is the same on every run.

const OS = [["linux", "Linux"], ["darwin", "macOS"], ["windows", "Windows"], ["freebsd", "FreeBSD"]];
const ARCH = [["amd64", "x86-64"], ["arm64", "ARMv8"], ["386", "x86"]];
/** 64 hex digits, from `seed`. */
const sha = (seed) => Array.from({ length: 8 }, (_, i) => ((Math.imul(seed + 1, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0).toString(16).padStart(8, "0")).join("");
const fileName = (release, file) => `tool1.${release}.${file}.${OS[file % OS.length][0]}-${ARCH[file % ARCH.length][0]}.tar.gz`;

/** A page of at least `chars` characters: `{ html, first, last }`, `first` and `last` the file names of its first and
 *  last rows. Each release's link to its notes carries `&amp;` in its query. `oneTable`: every release's rows in one
 *  table, under one header (a listing of a single table, the shape whose parse is slowest), not a table each. */
export function downloadsPage(chars, { oneTable = false } = {}) {
  const parts = [
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>All releases &amp; downloads</title>\n',
    "<script>window.dataLayer = window.dataLayer || []; function track(e) { dataLayer.push({ event: e, at: Date.now() }); }</script>\n",
    "<style>.downloadtable td { padding: 0 1em; } .highlight { font-weight: bold; }</style>\n</head>\n<body>\n<main>\n",
    "<h1>All releases</h1>\n<p>Every release, newest first: pick the file for your system.</p>\n",
  ];
  let size = parts.reduce((n, part) => n + part.length, 0);
  let first = null;
  let last = null;
  const header = '<table class="downloadtable">\n<thead>\n<tr><th>File name</th><th>Kind</th><th>OS</th><th>Arch</th><th>Size</th><th>SHA256 Checksum</th></tr>\n</thead>\n';
  if (oneTable) { parts.push(header, "<tbody>\n"); size += header.length + 8; }
  for (let release = 0; size < chars; release += 1) {
    const rows = oneTable ? [] : [`<div class="toggle" id="tool1.${release}">\n<h2>tool1.${release}</h2>\n<p><a href="/notes?release=${release}&amp;lang=en">Release notes</a></p>\n${header}`];
    for (let file = 0; file < 24; file += 1) {
      const name = fileName(release, file);
      first ??= name;
      last = name;
      rows.push(`<tr${file === 0 ? ' class="highlight"' : ""}>\n  <td class="filename"><a class="download" href="/dl/${name}">${name}</a></td>\n  <td>Archive</td>\n  <td>${OS[file % OS.length][1]}</td>\n  <td>${ARCH[file % ARCH.length][1]}</td>\n  <td>${60 + (file % 40)}MB</td>\n  <td><tt>${sha(release * 24 + file)}</tt></td>\n</tr>\n`);
    }
    if (!oneTable) rows.push("</table>\n</div>\n");
    const block = rows.join("");
    parts.push(block);
    size += block.length;
  }
  if (oneTable) parts.push("</tbody>\n</table>\n");
  parts.push("</main>\n<footer><p>Footer</p></footer>\n</body>\n</html>\n");
  return { html: parts.join(""), first, last };
}

/** A page of at least `chars` characters shaped to defeat a scan that is not linear: `unclosed`, an svg start tag that
 *  is never closed before each paragraph, then a style and a script never closed either; `unquoted`, a paragraph whose
 *  title attribute opens a quote that no quote ever closes, each time; `templates`, before each paragraph a template
 *  holding a template, hidden words and a script whose string is "</template>"; `bigtemplate`, one template holding
 *  the whole page in short tags, closed at its end, then one paragraph. `{ html, first, last }` as downloadsPage's,
 *  `first` and `last` its first and last paragraph's text. */
export function shapedPage(shape, chars) {
  const parts = ["<!DOCTYPE html>\n<html><head><title>Shaped</title></head><body>\n<h1>Start</h1>\n"];
  if (shape === "bigtemplate") parts.push("<template>\n");
  let size = parts.join("").length;
  let last = null;
  for (let i = 0; size < chars; i += 1) {
    last = `para ${i}`;
    const part = shape === "unclosed" ? `<svg class="icon" viewBox="0 0 10 10"><p>${last} of the page, kept</p>\n`
      : shape === "templates" ? `<template><template><b>inner</b></template><b>hidden ${i}</b><script>var s = "</template>";</script></template><p>${last} of the page, kept</p>\n`
      : shape === "bigtemplate" ? `<i>hidden</i><b>${i}</b><br>\n`
      : `<p title="open>${last} of the page, kept</p>\n`;
    parts.push(part);
    size += part.length;
  }
  if (shape === "unclosed") parts.push("<p>tail</p><style>.a { color: red }\n<script>track();\n");
  if (shape === "bigtemplate") { parts.push("</template>\n<p>after the template, kept</p>\n"); last = "after the template"; }
  return { html: parts.join(""), first: "para 0", last };
}
