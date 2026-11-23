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

/** One bar of a chart: its label, its value (any unit; bars of a chart are drawn against its largest), and the words
 *  shown for it (absent: none). */
export type CardBar = { readonly label: string; readonly value: number; readonly text?: string };

/** A chart on a card: bars as columns (a run of many: hours, days, months) or as rows (a few named shares, each label
 *  beside its bar). Absent `kind`: columns for more than six bars, rows otherwise. */
export type CardChart = { readonly label?: string; readonly kind?: "columns" | "rows"; readonly bars: readonly CardBar[] };

/** What a card says. Every word on the image is one of these; nothing else is read. */
export type CardBody = {
  /** The small caps line over the title (the card's kind: "Receipt", "Your year"). */
  readonly eyebrow?: string;
  readonly title: string;
  /** The card's one big number, as words ("$0.00", "1.2M") and its unit ("tokens"). */
  readonly figure?: { readonly value: string; readonly unit?: string };
  /** Label and value pairs, two columns of up to three. */
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
  /** Up to two charts, side by side, each as wide as its share of their bars. */
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
const MAX_ROWS = 6;
const MAX_CHARTS = 2;

const TOKENS = readTokens(tokensCss);

/** Token `name`'s colour in `theme`, as the attribute's value: tokens.css's triplet, never a value of this file's. */
function colour(theme: "dark" | "light", name: string): string {
  const triplet = TOKENS[theme][name];
  if (triplet === undefined) throw new Error(`tokens.css has no --${name}`);
  return `#${hslToRgb(triplet).map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The most characters of `face` at `size` that fit `width`. */
const fits = (width: number, size: number, face: keyof typeof ADVANCE): number => Math.max(1, Math.floor(width / (size * ADVANCE[face])));

/** `text` on one line of `width`, cut with an ellipsis when it is longer. */
function line(text: string, width: number, size: number, face: keyof typeof ADVANCE): string {
  const most = fits(width, size, face);
  const chars = [...text];
  return chars.length <= most ? text : `${chars.slice(0, most - 1).join("").trimEnd()}…`;
}

/** `text` in lines of `width`, broken at spaces, at most `max` lines, the last cut with an ellipsis when more is left. */
function wrap(text: string, width: number, size: number, face: keyof typeof ADVANCE, max: number): string[] {
  const most = fits(width, size, face);
  const lines: string[] = [];
  let rest = text.trim().split(/\s+/).filter(Boolean);
  while (rest.length && lines.length < max) {
    let current = "";
    let used = 0;
    for (const word of rest) {
      const next = current ? `${current} ${word}` : word;
      if ([...next].length > most && current) break;
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
  const spacing = caps ? ` letter-spacing="${(size * 0.08).toFixed(2)}"` : "";
  return `<text x="${x}" y="${y}" font-family="${face === "mono" ? MONO : SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing}>${escape(caps ? text.toUpperCase() : text)}</text>`;
}

const rect = (x: number, y: number, width: number, height: number, fill: string): string =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, width).toFixed(1)}" height="${Math.max(0, height).toFixed(1)}" fill="${fill}"/>`;

/** A finite value of zero or more, for a bar's length. */
const measure = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

function chartEl(chart: CardChart, x: number, y: number, width: number, height: number, paint: (name: string) => string): string[] {
  const out: string[] = [];
  let top = y;
  if (chart.label) {
    out.push(textEl({ x, y: top + 16, size: 16, face: "mono", fill: paint("muted-foreground"), text: line(chart.label, width, 16, "mono"), caps: true }));
    top += 32;
  }
  const bars = chart.bars;
  if (!bars.length || height - (top - y) < 24) return out;
  const most = Math.max(...bars.map((bar) => measure(bar.value)), 0);
  const rows = (chart.kind ?? (bars.length > 6 ? "columns" : "rows")) === "rows";
  const room = height - (top - y);
  if (rows) {
    const shown = bars.slice(0, Math.max(1, Math.floor(room / 36)));
    const pitch = Math.min(44, room / shown.length);
    const labelWidth = Math.min(260, width * 0.32);
    const textWidth = shown.some((bar) => bar.text) ? Math.min(180, width * 0.22) : 0;
    const barWidth = width - labelWidth - textWidth - (textWidth ? 16 : 0) - 16;
    shown.forEach((bar, i) => {
      const middle = top + i * pitch + pitch / 2;
      out.push(textEl({ x, y: middle + 7, size: 20, face: "mono", fill: paint("card-foreground"), text: line(bar.label, labelWidth - 12, 20, "mono") }));
      const length = most > 0 ? (measure(bar.value) / most) * barWidth : 0;
      out.push(rect(x + labelWidth, middle - 9, barWidth, 18, paint("muted")));
      out.push(rect(x + labelWidth, middle - 9, length, 18, paint("primary")));
      if (bar.text) out.push(textEl({ x: x + width, y: middle + 7, size: 20, face: "mono", fill: paint("muted-foreground"), text: line(bar.text, textWidth, 20, "mono"), anchor: "end" }));
    });
    return out;
  }
  // Columns: each bar a column from the baseline, its label under it where the labels fit (else the first and last).
  const gap = bars.length > 16 ? 4 : 8;
  const column = (width - gap * (bars.length - 1)) / bars.length;
  const labelled = bars.some((bar) => bar.label);
  const baseline = top + room - (labelled ? 28 : 0);
  const tallest = baseline - top - (bars.some((bar) => bar.text) ? 24 : 0);
  const everyLabel = bars.every((bar) => [...bar.label].length * 14 * ADVANCE.mono <= column + gap);
  bars.forEach((bar, i) => {
    const left = x + i * (column + gap);
    const length = most > 0 ? (measure(bar.value) / most) * tallest : 0;
    out.push(rect(left, baseline - 2, column, 2, paint("border")));
    out.push(rect(left, baseline - length, column, length, paint("primary")));
    if (bar.text && column >= 40) out.push(textEl({ x: left + column / 2, y: baseline - length - 8, size: 14, face: "mono", fill: paint("muted-foreground"), text: line(bar.text, column + gap, 14, "mono"), anchor: "middle" }));
    if (labelled && (everyLabel || i === 0 || i === bars.length - 1)) {
      out.push(textEl({ x: left + column / 2, y: baseline + 22, size: 14, face: "mono", fill: paint("muted-foreground"), text: everyLabel ? bar.label : line(bar.label, 80, 14, "mono"), anchor: "middle" }));
    }
  });
  return out;
}

/** The words of `body` in reading order, one sentence each, for an <img>'s alt. */
export function cardAlt(body: CardBody): string {
  const parts: string[] = [];
  if (body.eyebrow) parts.push(body.eyebrow);
  parts.push(body.title);
  if (body.figure) parts.push(body.figure.unit ? `${body.figure.value} ${body.figure.unit}` : body.figure.value);
  for (const row of (body.rows ?? []).slice(0, MAX_ROWS)) parts.push(`${row.label}: ${row.value}`);
  for (const chart of (body.charts ?? []).slice(0, MAX_CHARTS)) {
    const bars = chart.bars.map((bar) => `${bar.label} ${bar.text ?? String(bar.value)}`).join(", ");
    parts.push(chart.label ? `${chart.label}: ${bars}` : bars);
  }
  if (body.footnote) parts.push(body.footnote);
  return parts.map((part) => part.trim()).filter(Boolean).join(". ");
}

/** `body` as a 1200 by 675 card image. */
export function renderCard(body: CardBody): CardImage {
  const theme = body.theme ?? "dark";
  const paint = (name: string) => colour(theme, name);
  const out: string[] = [];
  out.push(rect(0, 0, CARD_WIDTH, CARD_HEIGHT, paint("card")));
  out.push(rect(0, 0, CARD_WIDTH, 8, paint("primary")));
  const bottom = CARD_HEIGHT - PAD - (body.footnote ? 40 : 0);

  // The eyebrow and the brand on one line.
  const brand = "AgentRun";
  const brandWidth = [...brand].length * 18 * ADVANCE.mono * 1.08 + 8;
  if (body.eyebrow) out.push(textEl({ x: PAD, y: PAD + 26, size: 18, face: "mono", fill: paint("muted-foreground"), text: line(body.eyebrow, INNER - brandWidth - 24, 18, "mono"), caps: true }));
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
    const unit = body.figure.unit ? line(body.figure.unit, INNER / 3, 32, "mono") : "";
    const unitWidth = unit ? [...unit].length * 32 * ADVANCE.mono + 20 : 0;
    const value = line(body.figure.value, INNER - unitWidth, 112, "mono");
    y += 24 + 104;
    out.push(textEl({ x: PAD, y, size: 112, face: "mono", fill: paint("primary-text"), text: value, weight: 600 }));
    if (unit) out.push(textEl({ x: PAD + [...value].length * 112 * ADVANCE.mono + 20, y, size: 32, face: "mono", fill: paint("muted-foreground"), text: unit }));
    // Room for the figure's descenders ("pm", "g") above what follows.
    y += 16;
  }

  // The rows: two columns, each pair a caps label over its value, as many as fit above the charts and the foot.
  const rows = (body.rows ?? []).slice(0, MAX_ROWS);
  const charts = (body.charts ?? []).filter((chart) => chart.bars.length > 0).slice(0, MAX_CHARTS);
  if (rows.length) {
    const columns = rows.length > 3 ? 2 : Math.min(rows.length, 3);
    const perColumn = Math.ceil(rows.length / columns);
    const columnWidth = (INNER - 32 * (columns - 1)) / columns;
    const pitch = 64;
    const room = bottom - (charts.length ? 160 : 0) - (y + 28);
    const shownPerColumn = Math.max(0, Math.min(perColumn, Math.floor(room / pitch)));
    rows.forEach((row, i) => {
      const column = Math.floor(i / perColumn);
      const index = i % perColumn;
      if (index >= shownPerColumn) return;
      const x = PAD + column * (columnWidth + 32);
      const top = y + 28 + index * pitch;
      out.push(textEl({ x, y: top + 16, size: 16, face: "mono", fill: paint("muted-foreground"), text: line(row.label, columnWidth, 16, "mono"), caps: true }));
      out.push(textEl({ x, y: top + 46, size: 28, face: "mono", fill: paint("card-foreground"), text: line(row.value, columnWidth, 28, "mono") }));
    });
    y += 28 + shownPerColumn * pitch;
  }

  // The charts, side by side below, each as wide as its share of the bars.
  if (charts.length) {
    const top = y + 32;
    const height = bottom - top;
    if (height >= 64) {
      const gap = 48;
      const weights = charts.map((chart) => Math.max(chart.bars.length, 4));
      const total = weights.reduce((a, b) => a + b, 0);
      let x = PAD;
      charts.forEach((chart, i) => {
        const width = ((INNER - gap * (charts.length - 1)) * weights[i]!) / total;
        out.push(...chartEl(chart, x, top, width, height, paint));
        x += width + gap;
      });
    }
  }

  if (body.footnote) out.push(textEl({ x: PAD, y: CARD_HEIGHT - PAD + 8, size: 20, face: "sans", fill: paint("muted-foreground"), text: line(body.footnote, INNER, 20, "sans") }));

  const alt = cardAlt(body);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img"><title>${escape(alt)}</title>${out.join("")}</svg>`;
  return { svg, dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: CARD_WIDTH, height: CARD_HEIGHT, alt };
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
