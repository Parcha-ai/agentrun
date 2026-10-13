// The safe markdown subset an assistant's words are shown in: paragraphs, bold, italics, inline code, lists and fenced code. It is read into a small tree (never into HTML): the page builds elements from
// it with textContent, so nothing the model wrote is parsed as markup. Links, images and raw HTML are not in the subset and stay the characters they were. Portable, no DOM.

export type Inline = { t: "text"; v: string } | { t: "b"; c: Inline[] } | { t: "i"; c: Inline[] } | { t: "code"; v: string } | { t: "br" };
export type Block = { t: "p"; c: Inline[] } | { t: "ul"; items: Inline[][] } | { t: "ol"; items: Inline[][]; start: number } | { t: "pre"; v: string };

/** Inline spans of one run of text. A marker with no closing partner is the characters it was (an answer that is still streaming is half a sentence). */
function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  // a newline inside a paragraph is a line break, wherever the emphasis around it opens and closes
  const flush = () => {
    plain.split("\n").forEach((part, n) => { if (n > 0) out.push({ t: "br" }); if (part) out.push({ t: "text", v: part }); });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: text.slice(i + 1, end) }); i = end + 1; continue; }
    } else if (ch === "*" && text[i + 1] === "*" && text[i + 2] === "*" && !/[\s*]/.test(text[i + 3] ?? " ")) {
      const end = text.indexOf("***", i + 3);
      if (end > i + 3 && !/\s/.test(text[end - 1]!)) { flush(); out.push({ t: "b", c: [{ t: "i", c: inline(text.slice(i + 3, end)) }] }); i = end + 3; continue; }
    } else if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2 && !/\s/.test(text[i + 2]!) && !/\s/.test(text[end - 1]!)) { flush(); out.push({ t: "b", c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    } else if (ch === "*" && text[i + 1] !== "*" && text[i - 1] !== "*" && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
      let end = i + 1;
      while ((end = text.indexOf("*", end)) !== -1 && (/\s/.test(text[end - 1]!) || text[end + 1] === "*" || text[end - 1] === "*")) end++;
      if (end > i + 1) { flush(); out.push({ t: "i", c: inline(text.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: ({ t: "ul"; items: Inline[][] } | { t: "ol"; items: Inline[][]; start: number }) | undefined;
  let afterBlank = false; // a blank line ends a list only when what follows is not another item of it
  const endPara = () => { if (para.length) blocks.push({ t: "p", c: inline(para.join("\n")) }); para = []; };
  const endList = () => { if (list) blocks.push(list); list = undefined; };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (/^\s*```/.test(line)) {
      endPara(); endList(); afterBlank = false;
      const body: string[] = [];
      n++;
      while (n < lines.length && !/^\s*```/.test(lines[n]!)) body.push(lines[n++]!);
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    if (line.trim() === "") { endPara(); afterBlank = true; continue; }
    const item = /^\s*([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const kind = item[2] !== undefined ? "ol" : "ul";
      if (list && list.t !== kind) endList();
      list ??= kind === "ol" ? { t: "ol", items: [], start: Number(item[2]) } : { t: "ul", items: [] };
      list.items.push(inline(item[3]!));
      afterBlank = false;
      continue;
    }
    endList();
    afterBlank = false;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { endPara(); blocks.push({ t: "p", c: [{ t: "b", c: inline(heading[1]!) }] }); continue; }
    para.push(line);
  }
  endPara(); endList();
  return blocks;
}

/** The characters a tree shows, with its markers taken out: what the reader reads. */
export function plainText(blocks: readonly Block[]): string {
  const span = (c: readonly Inline[]): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "br" ? "\n" : span(x.c))).join("");
  return blocks.map((b) => (b.t === "p" ? span(b.c) : b.t === "pre" ? b.v : b.items.map(span).join("\n"))).join("\n");
}
