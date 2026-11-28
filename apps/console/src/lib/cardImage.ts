// A share card as an image: one renderer for every card the console draws as a picture (a free run's receipt, each
// Wrapped card). A caller maps its own facts onto a CardBody (what the card says, in words and numbers it chose) and
// renderCard draws it: an SVG string, pure (no DOM, no fetch, nothing read but the body), and the same string as a data
// URL an <img> shows under the console's CSP (img-src data:). toPng rasterizes one in the browser, for a download or a
// share.
//
// Every colour is a token of tokens.css, read by name for the card's theme and written as the presentation attribute's
// value (the console's style-src allows no inline style, and an image has no page CSS to read a variable from). Fonts are
// the console's families with the system's monospace and sans-serif after them: an image loads no font.
import tokensCss from "@/tokens.css?raw";
import { hslToRgb, readTokens } from "@/design/contrast";

/** One bar of a chart: its label, its value (any unit; bars of a chart are drawn against its largest measured one), and
 *  the words shown for it (absent: none). `measured: false`: a bar not measured yet, drawn as a dashed outline (at its
 *  value where it has one, an estimate, else the whole track) and left out of the chart's scale. */
export type CardBar = { readonly label: string; readonly value: number; readonly text?: string; readonly measured?: false };

/** A chart on a card: bars as columns (a run of many: hours, days, months; every bar drawn) or as rows (named shares,
 *  each label beside its bar; as many as fit, chartCapacity). The caller says which: a kind guessed from the bars given
 *  would change how many fit with how many a mapper folds them to. */
export type CardChart = { readonly label?: string; readonly kind: "columns" | "rows"; readonly bars: readonly CardBar[] };

/** What a card says. Every word on the image is one of these; nothing else is read. */
export type CardBody = {
  /** The small caps line over the title (the card's kind: "Receipt", "Your year"). */
  readonly eyebrow?: string;
  readonly title: string;
  /** The card's one big number, as words ("$0.00", "1.2M") and its unit ("tokens"). */
  readonly figure?: { readonly value: string; readonly unit?: string };
  /** Label and value pairs, at most six: up to three side by side, more in two columns of up to three. */
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
  /** Up to two charts, side by side: two columns charts each as wide as its share of their bars, a rows chart a fixed share. */
  readonly charts?: readonly CardChart[];
  /** One line at the foot. */
  readonly footnote?: string;
  /** Absent: dark. */
  readonly theme?: "dark" | "light";
};

export type CardImage = {
  readonly svg: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** The card's words in reading order, for the <img>'s alt. */
  readonly alt: string;
};

/** 16:9, the shape a social feed shows an image in whole. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 675;

const PAD = 64;
const INNER = CARD_WIDTH - 2 * PAD;
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** A character's advance as a share of the font size, to fit a line: exact for a monospace font, a wide average for sans. */
const ADVANCE = { mono: 0.6, sans: 0.56 } as const;
/** The most rows a card draws: a body with more loses the rest. */
export const MAX_ROWS = 6;
const MAX_CHARTS = 2;
/** The most bars of one chart the alt reads (a year by day): a screen reader reads the rest as a count. */
const ALT_BARS = 365;

const TOKENS = readTokens(tokensCss);

/** Token `name`'s colour in `theme`, as the attribute's value: tokens.css's triplet, never a value of this file's. */
function colour(theme: "dark" | "light", name: string): string {
  const triplet = TOKENS[theme][name];
  if (triplet === undefined) throw new Error(`tokens.css has no --${name}`);
  return `#${hslToRgb(triplet).map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A caps line's letter spacing, as a share of its size: added after every character. */
const CAPS_SPACING = 0.08;
/** A character a font draws two cells wide (East Asian wide and fullwidth forms, Hangul, emoji): about an em. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
/** A mark drawn on the character before it, taking no room of its own. */
const MARK = /\p{M}/u;

/** One character's advance in ems: none for a combining mark, an em for a wide one, else the face's. */
const advanceOf = (char: string, face: keyof typeof ADVANCE): number => (MARK.test(char) ? 0 : WIDE.test(char) ? 1 : ADVANCE[face]);

/** How wide `text` draws in `face` at `size`, its caps spacing (`caps`) counted: what every line is cut to fit. An
 *  estimate from each character's advance, generous for a wide character, so a line cut to it stays in its box. */
export function textWidth(text: string, size: number, face: keyof typeof ADVANCE, caps = false): number {
  let width = 0;
  for (const char of caps ? text.toUpperCase() : text) width += size * (advanceOf(char, face) + (caps && !MARK.test(char) ? CAPS_SPACING : 0));
  return width;
}

/** `text` on one line of `width` (as `caps` draws it, when set), cut with an ellipsis when it is wider. */
function line(text: string, width: number, size: number, face: keyof typeof ADVANCE, caps = false): string {
  const shown = caps ? text.toUpperCase() : text;
  if (textWidth(shown, size, face, caps) <= width) return shown;
  const room = width - textWidth("…", size, face, caps);
  let cut = "";
  for (const char of shown) {
    if (textWidth(cut + char, size, face, caps) > room) break;
    cut += char;
  }
  return `${cut.trimEnd()}…`;
}

/** `text` in lines of `width`, broken at spaces, at most `max` lines, the last cut with an ellipsis when more is left. A
 *  word wider than a line is cut on its own line. */
function wrap(text: string, width: number, size: number, face: keyof typeof ADVANCE, max: number): string[] {
  const lines: string[] = [];
  let rest = text.trim().split(/\s+/).filter(Boolean);
  while (rest.length && lines.length < max) {
    let current = "";
    let used = 0;
    for (const word of rest) {
      const next = current ? `${current} ${word}` : word;
      if (textWidth(next, size, face) > width && current) break;
      current = next;
      used += 1;
    }
    rest = rest.slice(used);
    lines.push(lines.length === max - 1 && rest.length ? line(`${current} ${rest.join(" ")}`, width, size, face) : line(current, width, size, face));
  }
  return lines;
}

type Text = { x: number; y: number; size: number; face: keyof typeof ADVANCE; fill: string; text: string; weight?: 400 | 600; anchor?: "start" | "end" | "middle"; caps?: boolean };

function textEl({ x, y, size, face, fill, text, weight = 400, anchor = "start", caps = false }: Text): string {
  const spacing = caps ? ` letter-spacing="${(size * CAPS_SPACING).toFixed(2)}"` : "";
  return `<text x="${x}" y="${y}" font-family="${face === "mono" ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing}>${escape(caps ? text.toUpperCase() : text)}</text>`;
}

const rect = (x: number, y: number, width: number, height: number, fill: string): string =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, width).toFixed(1)}" height="${Math.max(0, height).toFixed(1)}" fill="${fill}"/>`;

/** A finite value of zero or more, for a bar's length. */
const measure = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** A bar not measured yet: its outline, dashed, inset by half the stroke so it stays inside its box. */
const outline = (x: number, y: number, width: number, height: number, stroke: string): string =>
  width < 4 || height < 4 ? "" : `<rect x="${(x + 1).toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${(width - 2).toFixed(1)}" height="${(height - 2).toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="2" stroke-dasharray="6 4"/>`;

/** A chart's marks and how many of its bars they show (a rows chart shows as many as fit its height; columns show all). */
function chartEl(chart: CardChart, x: number, y: number, width: number, height: number, paint: (name: string) => string): { marks: string[]; shown: number } {
  const out: string[] = [];
  let top = y;
  if (chart.label) {
    out.push(textEl({ x, y: top + 16, size: 16, face: "mono", fill: paint("muted-foreground"), text: line(chart.label, width, 16, "mono", true), caps: true }));
    top += 32;
  }
  const bars = chart.bars;
  if (!bars.length || height - (top - y) < 24) return { marks: out, shown: 0 };
  // The scale is the largest measured bar; with no measured bar above zero, the largest estimate, so a pending bar still
  // shows as its outline beside measured zeros (which stay empty).
  const largest = (of: readonly CardBar[]) => Math.max(0, ...of.map((bar) => measure(bar.value)));
  const most = largest(bars.filter((bar) => bar.measured !== false)) || largest(bars);
  /** A bar's length on a track of `track`: its share of the scale, capped at the track; an unmeasured bar with no value
   *  fills its track, as an outline. */
  const lengthOf = (bar: CardBar, track: number) =>
    bar.measured === false && measure(bar.value) === 0 ? track : most > 0 ? Math.min(track, (measure(bar.value) / most) * track) : 0;
  const rows = chart.kind === "rows";
  const room = height - (top - y);
  if (rows) {
    const shown = bars.slice(0, rowsThatFit(room));
    const pitch = Math.min(44, room / shown.length);
    const labelWidth = Math.min(260, width * 0.32);
    const textRoom = shown.some((bar) => bar.text) ? Math.min(180, width * 0.22) : 0;
    const barWidth = width - labelWidth - textRoom - (textRoom ? 16 : 0) - 16;
    shown.forEach((bar, i) => {
      const middle = top + i * pitch + pitch / 2;
      out.push(textEl({ x, y: middle + 7, size: 20, face: "mono", fill: paint("card-foreground"), text: line(bar.label, labelWidth - 12, 20, "mono") }));
      const length = lengthOf(bar, barWidth);
      out.push(rect(x + labelWidth, middle - 9, barWidth, 18, paint("muted")));
      out.push(bar.measured === false ? outline(x + labelWidth, middle - 9, length, 18, paint("primary")) : rect(x + labelWidth, middle - 9, length, 18, paint("primary")));
      if (bar.text) out.push(textEl({ x: x + width, y: middle + 7, size: 20, face: "mono", fill: paint("muted-foreground"), text: line(bar.text, textRoom, 20, "mono"), anchor: "end" }));
    });
    return { marks: out, shown: shown.length };
  }
  // Columns: each bar a column from the baseline, its label under it where the labels fit (else the first and last). The
  // gap is at most a quarter of a bar's share of the width, so a year by day still draws every column.
  const gap = Math.min(bars.length > 16 ? 4 : 8, width / bars.length / 4);
  const column = (width - gap * (bars.length - 1)) / bars.length;
  const labelled = bars.some((bar) => bar.label);
  const baseline = top + room - (labelled ? 28 : 0);
  const tallest = baseline - top - (bars.some((bar) => bar.text) ? 24 : 0);
  const everyLabel = bars.every((bar) => textWidth(bar.label, 14, "mono") <= column);
  bars.forEach((bar, i) => {
    const left = x + i * (column + gap);
    const length = lengthOf(bar, tallest);
    out.push(rect(left, baseline - 2, column, 2, paint("border")));
    out.push(bar.measured === false ? outline(left, baseline - length, column, length, paint("primary")) : rect(left, baseline - length, column, length, paint("primary")));
    if (bar.text && column >= 40) out.push(textEl({ x: left + column / 2, y: baseline - length - 8, size: 14, face: "mono", fill: paint("muted-foreground"), text: line(bar.text, column, 14, "mono"), anchor: "middle" }));
    if (labelled && everyLabel) {
      out.push(textEl({ x: left + column / 2, y: baseline + 22, size: 14, face: "mono", fill: paint("muted-foreground"), text: bar.label, anchor: "middle" }));
    } else if (labelled && (i === 0 || i === bars.length - 1)) {
      // Only the ends are labelled: the first from its column's left edge, the last to its right edge, so neither leaves the chart.
      const first = i === 0;
      out.push(textEl({ x: first ? left : left + column, y: baseline + 22, size: 14, face: "mono", fill: paint("muted-foreground"), text: line(bar.label, Math.min(80, width / 2 - 8), 14, "mono"), anchor: first ? "start" : "end" }));
    }
  });
  return { marks: out, shown: bars.length };
}

/** A chart's share of the width beside another: a columns chart's grows with its bars (each column as wide as the
 *  other's), a rows chart's is fixed (its bars stack, and its labels need the room). */
const weightOf = (chart: CardChart): number => (chart.kind === "rows" ? 10 : Math.max(chart.bars.length, 4));

/** How many rows of bars fit a rows chart's `room` (its height under its label): one at the least. */
const rowsThatFit = (room: number): number => Math.max(1, Math.floor(room / 36));

/** The words `body`'s card draws, in reading order, one sentence each, for an <img>'s alt: only what is drawn (a row or a
 *  bar with no room is not read), each value as its bar draws it. */
export function cardAlt(body: CardBody): string {
  return draw(body).alt;
}

/** `body` as a 1200 by 675 card image. A rows chart shows as many bars as fit, and the rows as many as fit under the title
 *  (cardCapacity says how many): fold the rest into one "other" bar, or leave the last rows out, before rendering, or they
 *  are not drawn. */
export function renderCard(body: CardBody): CardImage {
  const { marks, alt } = draw(body);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img"><title>${escape(alt)}</title>${marks.join("")}</svg>`;
  return { svg, dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: CARD_WIDTH, height: CARD_HEIGHT, alt };
}

/** How many bars of each of `body.charts` (by its index) renderCard draws, laid out as `body` is (its title, figure, rows
 *  and footnote take their room first): every bar of a columns chart, as many as fit of a rows chart, none of a chart past
 *  the second, one with no bars, or one with no room left. A mapper with more bars than fit shows the first count − 1
 *  and one "other" bar for the rest; the count does not change with how many bars a chart is given. */
export function chartCapacity(body: CardBody): number[] {
  return cardCapacity(body).charts;
}

/** What of `body` renderCard draws: how many of its rows (the first that many, in reading order: a long title or a
 *  figure takes their room) and chartCapacity's count for each chart. */
export function cardCapacity(body: CardBody): { rows: number; charts: number[] } {
  const { shown, rows } = draw(body);
  return { rows, charts: (body.charts ?? []).map((_, i) => shown[i] ?? 0) };
}

/** The card's marks; how many bars of each chart of `body.charts` (by its index) and how many of `body.rows` they show;
 *  and the words of what they show, in reading order, for the alt. */
function draw(body: CardBody): { marks: string[]; shown: number[]; rows: number; alt: string } {
  const shownBars: number[] = [];
  const theme = body.theme ?? "dark";
  const paint = (name: string) => colour(theme, name);
  const out: string[] = [];
  const alt: string[] = [];
  if (body.eyebrow) alt.push(body.eyebrow);
  alt.push(body.title);
  if (body.figure) alt.push(body.figure.unit ? `${body.figure.value} ${body.figure.unit}` : body.figure.value);
  out.push(rect(0, 0, CARD_WIDTH, CARD_HEIGHT, paint("card")));
  out.push(rect(0, 0, CARD_WIDTH, 8, paint("primary")));
  const bottom = CARD_HEIGHT - PAD - (body.footnote ? 40 : 0);

  // The eyebrow and the brand on one line.
  const brand = "AgentRun";
  const brandWidth = textWidth(brand, 18, "mono", true);
  if (body.eyebrow) out.push(textEl({ x: PAD, y: PAD + 26, size: 18, face: "mono", fill: paint("muted-foreground"), text: line(body.eyebrow, INNER - brandWidth - 32, 18, "mono", true), caps: true }));
  out.push(textEl({ x: CARD_WIDTH - PAD, y: PAD + 26, size: 18, face: "mono", fill: paint("primary-text"), text: brand, weight: 600, anchor: "end", caps: true }));
  let y = PAD + 26 + 28;

  // The title, up to two lines.
  const titleLines = wrap(body.title, INNER, 48, "sans", 2);
  for (const text of titleLines) {
    y += 56;
    out.push(textEl({ x: PAD, y, size: 48, face: "sans", fill: paint("card-foreground"), text, weight: 600 }));
  }

  // The figure, its unit after it.
  if (body.figure) {
    // The figure keeps the room it always had (the card less its unit, the unit held to a third), and the unit then takes
    // all the room the figure leaves: a short figure ("2") lets a long unit ("keys and tokens cut") draw whole.
    const held = body.figure.unit ? Math.min(textWidth(body.figure.unit, 32, "mono"), INNER / 3) + 20 : 0;
    const value = line(body.figure.value, INNER - held, 112, "mono");
    const unit = body.figure.unit ? line(body.figure.unit, INNER - textWidth(value, 112, "mono") - 20, 32, "mono") : "";
    y += 24 + 104;
    out.push(textEl({ x: PAD, y, size: 112, face: "mono", fill: paint("primary-text"), text: value, weight: 600 }));
    if (unit) out.push(textEl({ x: PAD + textWidth(value, 112, "mono") + 20, y, size: 32, face: "mono", fill: paint("muted-foreground"), text: unit }));
    // Room for the figure's descenders ("pm", "g") above what follows.
    y += 16;
  }

  // The rows: up to three side by side, more in two columns, each pair a caps label over its value, as many as fit above
  // the charts and the foot.
  const rows = (body.rows ?? []).slice(0, MAX_ROWS);
  // Each drawn chart with its index in body.charts, which chartCapacity answers by.
  const charts = (body.charts ?? []).map((chart, index) => ({ chart, index })).filter(({ chart }) => chart.bars.length > 0).slice(0, MAX_CHARTS);
  let rowsShown = 0;
  if (rows.length) {
    const columns = rows.length > 3 ? 2 : rows.length;
    const perColumn = Math.ceil(rows.length / columns);
    const columnWidth = (INNER - 32 * (columns - 1)) / columns;
    const pitch = 64;
    const room = bottom - (charts.length ? 160 : 0) - (y + 28);
    const shownPerColumn = Math.max(0, Math.min(perColumn, Math.floor(room / pitch)));
    // In reading order, down each column in turn: the rows that do not fit are the last ones, never ones from the middle.
    const shown = rows.slice(0, columns * shownPerColumn);
    shown.forEach((row, i) => {
      const x = PAD + Math.floor(i / shownPerColumn) * (columnWidth + 32);
      const top = y + 28 + (i % shownPerColumn) * pitch;
      out.push(textEl({ x, y: top + 16, size: 16, face: "mono", fill: paint("muted-foreground"), text: line(row.label, columnWidth, 16, "mono", true), caps: true }));
      out.push(textEl({ x, y: top + 46, size: 28, face: "mono", fill: paint("card-foreground"), text: line(row.value, columnWidth, 28, "mono") }));
      alt.push(`${row.label}: ${row.value}`);
    });
    rowsShown = shown.length;
    if (shown.length) y += 28 + shownPerColumn * pitch;
  }

  // The charts, side by side below, each as wide as its share (weightOf).
  if (charts.length) {
    const top = y + 32;
    const height = bottom - top;
    if (height >= 64) {
      const gap = 48;
      const weights = charts.map(({ chart }) => weightOf(chart));
      const total = weights.reduce((a, b) => a + b, 0);
      let x = PAD;
      charts.forEach(({ chart, index }, i) => {
        const width = ((INNER - gap * (charts.length - 1)) * weights[i]!) / total;
        const { marks, shown } = chartEl(chart, x, top, width, height, paint);
        out.push(...marks);
        shownBars[index] = shown;
        if (shown) {
          // A year's bars read at most: past that, how many more are drawn.
          const read = Math.min(shown, ALT_BARS);
          const bars = chart.bars.slice(0, read).map((bar) => `${bar.label} ${bar.text ?? (bar.measured === false ? "not measured yet" : String(measure(bar.value)))}`).join(", ");
          const more = shown > read ? `, and ${shown - read} more` : "";
          alt.push(chart.label ? `${chart.label}: ${bars}${more}` : `${bars}${more}`);
        }
        x += width + gap;
      });
    }
  }

  if (body.footnote) {
    out.push(textEl({ x: PAD, y: CARD_HEIGHT - PAD + 8, size: 20, face: "sans", fill: paint("muted-foreground"), text: line(body.footnote, INNER, 20, "sans") }));
    alt.push(body.footnote);
  }
  return { marks: out, shown: shownBars, rows: rowsShown, alt: alt.map((part) => part.trim()).filter(Boolean).join(". ") };
}

/** `image` as a PNG at `scale` times its size, in the browser (a canvas draws it). For a download or a share. */
export async function toPng(image: CardImage, scale = 2): Promise<Blob> {
  const picture = new Image(image.width, image.height);
  picture.decoding = "async";
  picture.src = image.dataUrl;
  await picture.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this browser draws no canvas");
  context.scale(scale, scale);
  context.drawImage(picture, 0, 0, image.width, image.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the card could not be drawn as a PNG"))), "image/png"));
}
