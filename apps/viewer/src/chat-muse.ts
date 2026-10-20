// The Muse layout of a recorded run: the same events as the chat view, drawn as a phone chat. A round avatar at the top with the agent's
// name and state under it; one column of bubbles (the person's words right-aligned, the agent's replies as bubbles, its thinking folded and
// quiet); the browser inline as a card with the agent's last frame; a sign-in card where the run waited for a person; the answer as the agent's
// bubble with the files it names as chips; and "What I remember" as a card. No report page beside it, and no web address in what it shows:
// every address is shortened to its host. Everything comes from the model made of the recording's own lines (extractChat with `muse`).
import type { ChatBrowser, ChatItem, ChatModel } from './chat-model.ts';
import { reportEl, reportParagraphs } from './chat-report.ts';
import type { Recording } from './format.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** A text with every web address shortened to its host: the chat shows where, never the whole address. */
export function museShorten(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, (address) => { try { return new URL(address).host || address; } catch { return address; } });
}

/** An ISO time as a date and a time ("Oct 20, 00:12"), the year only when it is not the year of `reference` (the recording's own end). A replay is watched
 *  days later, so a time is never "today" or "yesterday": it is the date it happened. The clock is the viewer's own unless `timeZone` is given. */
export function museWhen(text: string, reference = new Date(), timeZone?: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, (iso) => {
    const at = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
    if (Number.isNaN(at.getTime())) return iso;
    const clock = at.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    // The month by our own short names, so a runtime's locale data does not change it ("Sept" or "Sep").
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(at.toLocaleDateString('en-CA', { timeZone, month: '2-digit' })) - 1]!;
    const day = Number(at.toLocaleDateString('en-CA', { timeZone, day: '2-digit' }));
    const year = at.toLocaleDateString('en-CA', { timeZone, year: 'numeric' });
    const sameYear = year === reference.toLocaleDateString('en-CA', { timeZone, year: 'numeric' });
    return `${month} ${day}${sameYear ? '' : `, ${year}`}, ${clock}`;
  });
}

/** A memory file's name as a heading a person reads: no extension, capitalised ("preferences.md" is "Preferences"); an index is the host's own table of contents and has none. */
export function museFriendlyFile(name: string): string | undefined {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[-_]+/g, ' ').trim();
  return /^index$/i.test(base) || base === '' ? undefined : base.charAt(0).toUpperCase() + base.slice(1);
}

const EXT = '(?:pdf|csv|xlsx?|docx?|pptx?|txt|json|md|zip|png|jpe?g)';
/** A file name inside a sentence (no spaces), and a whole line that is one (spaces allowed). */
const FILE = new RegExp(`[\\w][\\w.-]*\\.${EXT}\\b`, 'gi');
const FILE_LINE = new RegExp(`^[\\w][\\w .-]*\\.${EXT}$`, 'i');

/** The files a text names: each as a chip. A line that is only a file's name (a list item) is taken out of the text, so the chip is not said twice. */
export function museFiles(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const kept = text.split('\n').filter((line) => {
    const bare = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (bare !== '' && FILE_LINE.test(bare)) { if (!files.includes(bare)) files.push(bare); return false; }
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  for (const found of kept.match(FILE) ?? []) if (!files.includes(found)) files.push(found);
  return { text: kept, files };
}

const icon = (name: 'globe' | 'shield' | 'brain'): HTMLElement => {
  const paths = {
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9m0-18C9.5 5.4 8.2 8.4 8.2 12s1.3 6.6 3.8 9M3.5 9h17M3.5 15h17',
    shield: 'M12 3l7 3v5c0 4.4-2.8 8.1-7 10-4.2-1.9-7-5.6-7-10V6l7-3Zm-2.2 9.2V11a2.2 2.2 0 0 1 4.4 0v1.2m-5 0h5.6v3.6H8.8v-3.6Z',
    brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3.2 3.2 0 0 0 8 17.8 3 3 0 0 0 12 20V5.5A3 3 0 0 0 9 4Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5 3.2 3.2 0 0 1-3.5 5.3A3 3 0 0 1 12 20',
  } as const;
  const span = document.createElement('span');
  span.className = 'mu-icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
  return span;
};

/** A card with an icon tile, a title and a quiet line under it. */
const card = (kind: string, glyph: 'globe' | 'shield' | 'brain', title: string, sub: string, ...rest: (HTMLElement | false | undefined)[]): HTMLElement => reportEl('section', { class: `mu-card ${kind}` },
  reportEl('div', { class: 'mu-card-head' }, icon(glyph), reportEl('div', {}, reportEl('div', { class: 'mu-card-title', text: title }), sub !== '' && reportEl('div', { class: 'mu-card-sub', text: sub }))), ...rest);

/** The browser as one card: the latest frame the steps held and who has it, as a status line (pi-browser's viewer has no Take control button: the person drives whenever the agent is not acting). */
function browserCard(recording: Recording, steps: ToolItem[]): HTMLElement {
  const browsers = steps.flatMap((step) => (step.browser ? [step.browser] : []));
  const last = browsers.flatMap((browser) => browser.frames).sort((a, b) => a.t - b.t).at(-1);
  const src = last ? recording.blobUrl(last.blob) : undefined;
  const site = browsers.map((browser) => browser.site).filter((each): each is string => !!each).at(-1);
  const holds = browsers.flatMap((browser: ChatBrowser) => browser.holds).sort((a, b) => a.t0 - b.t0);
  const labels = holds.length === 0 ? [{ text: 'Your agent is driving the browser', held: false }] : holds.flatMap((hold) => [
    { text: hold.condition ? `Handed the browser over: ${museShorten(hold.condition)}` : 'Handed the browser over', held: true },
    ...(hold.t1 !== undefined ? [{ text: hold.outcome ? `Handed back · ${hold.outcome}` : 'Handed back', held: false }] : []),
  ]);
  return card('mu-browser', 'globe', 'Browser', site ? `Browsing ${site}` : 'Browsing',
    reportEl('div', { class: 'mu-shot' }, src ? reportEl('img', { loading: 'lazy', src, alt: site ? `The browser on ${site}` : 'The browser' }) : reportEl('span', { class: 'mu-shot-none', text: 'No picture was recorded here' })),
    reportEl('div', { class: 'mu-strip' }, reportEl('div', { class: 'mu-labels' }, ...labels.map((label) => reportEl('span', { class: `mu-label${label.held ? ' held' : ''}`, text: label.text })))));
}

/** A small glyph for a status line (a state, not a control): a check for signed in, a lock while it waits. */
const mark = (name: 'check' | 'lock'): HTMLElement => {
  const span = document.createElement('span');
  span.className = 'mu-mark';
  const path = name === 'check' ? 'M5 12.5l4.5 4.5L19 7.5' : 'M7 11V8a5 5 0 0 1 10 0v3m-11 0h12v9H6v-9Z';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  return span;
};

/** Where the run waited for a person to sign in: asked, and signed in once the browser's own profile says so. Its state is a status line (a glyph and words), never a box that reads as a button. */
function signInCard(wait: NonNullable<ChatModel['waits']>[number]): HTMLElement {
  const waiting = !wait.remembered && wait.t1 === undefined;
  const text = waiting ? 'Waiting for you' : wait.remembered ? `Signed in to ${wait.site} · remembered` : `Signed in to ${wait.site}`;
  const state = reportEl('div', { class: 'mu-status', role: 'status' }, mark(waiting ? 'lock' : 'check'), reportEl('span', { text }));
  return card(`mu-signin${wait.remembered ? ' mu-remembered' : ''}`, 'shield', 'Secure Store', waiting ? `Sign in to ${wait.site}` : '', state);
}

/** A bubble of the agent's words (a paragraph per blank line), the files it names as chips under them. */
function agentBubble(text: string, name: string, more: string[] = []): HTMLElement {
  // The files a text names are read from the text as written (an address such as https://host/reports/summary.pdf names one), then every address is shortened.
  const { text: kept, files: named } = museFiles(text);
  const files = [...named, ...more.filter((each) => !named.includes(each))];
  return reportEl('div', { class: 'mu-row agent' }, reportEl('div', { class: 'mu-tag', text: name }), reportEl('div', { class: 'mu-bubble' }, ...reportParagraphs(museShorten(kept))),
    files.length > 0 && reportEl('div', { class: 'mu-files' }, ...files.map((file) => reportEl('span', { class: 'mu-file', title: file, text: file }))));
}

/** The text of a blob. An embedded recording keeps its blobs as data: URLs, which a host's `connect-src 'self'` will not let a fetch() read, so those are decoded here; any other URL is fetched. */
async function pageText(url: string): Promise<string> {
  const data = /^data:[^,]*?(;base64)?,/.exec(url);
  if (data) {
    const body = url.slice(data[0].length);
    return data[1] ? new TextDecoder().decode(Uint8Array.from(atob(body), (each) => each.charCodeAt(0))) : decodeURIComponent(body);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the page answered ${response.status}`);
  return response.text();
}

/** Layout containers a memory page may wrap its report in: walked through, so its headings, lists and notes keep their own places. */
const CONTAINERS = new Set(['main', 'section', 'article', 'div', 'aside', 'header', 'footer', 'details']);
const BLOCKS = ':scope > :is(h1, h2, h3, h4, ul, ol, pre, p, main, section, article, div, aside, header, footer, details)';

/** "What I remember": the host's artifact, read as a page and drawn as lines (its headings, lists and notes), every address shortened. When it cannot be read, the card says so.
 *  `settled` resolves once the card holds what it will hold (read, or said unreadable): until then it is only a line saying it is reading. */
function rememberCard(recording: Recording, artifact: NonNullable<ChatModel['artifact']>): { card: HTMLElement; settled: Promise<void> } {
  const body = reportEl('div', { class: 'mu-remember' }, reportEl('p', { class: 'mu-quiet', text: 'Reading what the agent kept…' }));
  const sha = artifact.files[artifact.entry];
  const url = sha ? recording.blobUrl(sha) : undefined;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const failed = (why: string) => { body.replaceChildren(reportEl('p', { class: 'mu-quiet', text: `What the agent remembers could not be read here${why ? ` (${why})` : ''}.` })); settle(); };
  if (!url) failed('it is not in this recording');
  else {
    void pageText(url).then((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parts: HTMLElement[] = [];
      let skippedTitle = false;
      let skipping = false;
      const ended = Date.parse(recording.manifest.recorded?.ended ?? '');
      const reference = Number.isNaN(ended) ? new Date() : new Date(ended);
      const plain = (raw: string) => museWhen(museShorten(raw.replace(/\s+/g, ' ').trim()), reference);
      const walk = (parent: Element) => {
        for (const node of [...parent.children]) {
          const tag = node.tagName.toLowerCase();
          // A layout container is walked through, so what it wraps keeps its own heading, list or note; one with no element inside is a note.
          if (CONTAINERS.has(tag) && node.querySelector(BLOCKS)) { walk(node); continue; }
          const text = plain(node.textContent ?? '');
          if (tag === 'h1' && !skippedTitle) { skippedTitle = true; continue; }
          if (tag === 'h1' || tag === 'h2') { skipping = false; parts.push(reportEl('h3', { class: 'mu-rh', text })); continue; }
          if (tag === 'h3' || tag === 'h4') {
            // A file's name is a heading a person reads; a host's index file has no heading and none of its lines.
            const friendly = /\.[A-Za-z0-9]{1,5}$/.test(text) ? museFriendlyFile(text) : text;
            skipping = friendly === undefined;
            if (friendly !== undefined) parts.push(reportEl('div', { class: 'mu-rsub', text: friendly }));
            continue;
          }
          if (skipping) continue;
          if (tag === 'ul' || tag === 'ol') parts.push(reportEl('ul', { class: 'mu-rlist' }, ...[...node.querySelectorAll('li')].map((li) => reportEl('li', { text: plain(li.textContent ?? '') }))));
          // A note is its lines, plainly: one a line, not a code box.
          else if (tag === 'pre') parts.push(reportEl('ul', { class: 'mu-rlist' }, ...(node.textContent ?? '').split('\n').map((line) => plain(line)).filter((line) => line !== '').map((line) => reportEl('li', { text: line }))));
          else if (text !== '') parts.push(reportEl('p', { class: 'mu-rp', text }));
        }
      };
      walk(doc.body);
      if (parts.length === 0) failed('the page held nothing to show'); else { body.replaceChildren(...parts); settle(); }
    }).catch((error: unknown) => failed(String((error as Error)?.message ?? error).slice(0, 80)));
  }
  return { card: card('mu-memory', 'brain', 'What I remember', 'Kept between runs', body), settled };
}

/** The run's saved answer (manifest.result: a cited result or a submitted record) as the agent's words: a row a line (its label, then its value), its cites as chips. */
function savedAnswer(answer: NonNullable<ChatModel['answer']>): { text: string; chips: string[] } {
  const text = answer.rows.map((row) => [row.label !== '' && row.text !== '' ? `${row.label}: ${row.text}` : row.label || row.text, row.note ?? ''].filter((each) => each !== '').join('\n')).filter((each) => each !== '').join('\n\n');
  const chips = answer.rows.flatMap((row) => row.cites.map((cite) => museShorten(cite.label ?? (cite.href.split('#')[0]!.split('/').pop() || cite.href))));
  return { text, chips: [...new Set(chips)] };
}

/** The agent's picture: one file beside the page (apps/viewer/muse-avatar.webp, copied by the build), shown in the avatar's square slot. Empty, the slot shows the agent's initial. */
export const MUSE_AVATAR: string = 'muse-avatar.webp';

const STATE = { done: 'Done', waiting: 'Waiting for you', working: 'is working' } as const;

/** The whole page. `root` takes the Muse layout; nothing of the analyst chat view is drawn. */
export function drawMuse(root: HTMLElement, model: ChatModel, recording: Recording): void {
  root.replaceChildren();
  root.classList.add('muse');
  const name = model.agent?.name ?? model.title;
  const header = reportEl('header', { class: 'mu-top' },
    reportEl('div', { class: 'mu-avatar', 'aria-hidden': 'true', ...(MUSE_AVATAR === '' ? { text: [...name][0]?.toUpperCase() ?? '·' } : {}) }, ...(MUSE_AVATAR === '' ? [] : [reportEl('img', { src: MUSE_AVATAR, alt: '' })])),
    reportEl('div', { class: 'mu-who' },
      reportEl('div', { class: 'mu-name', text: name }),
      reportEl('div', { class: `mu-state ${model.agent?.status ?? 'working'}`, text: STATE[model.agent?.status ?? 'working'] })));
  const column = reportEl('main', { class: 'mu-chat', 'aria-label': 'The conversation' });

  // Everything in time order: the person's words, the agent's, its thoughts, the browser steps, the sign-in waits.
  type Entry = { t: number; order: number; kind: 'user' | 'agent' | 'thought' | 'browser' | 'wait' | 'quiet'; item?: ChatItem; wait?: NonNullable<ChatModel['waits']>[number] };
  const entries: Entry[] = [];
  let order = 0;
  for (const thread of model.threads) {
    for (const item of thread.items) {
      const t = item.kind === 'tool' ? (item.t0 ?? item.t1 ?? 0) : (item.t ?? 0);
      if (item.kind === 'user') entries.push({ t, order: order++, kind: 'user', item });
      else if (item.kind === 'assistant') entries.push({ t, order: order++, kind: 'agent', item });
      else if (item.kind === 'thinking') entries.push({ t, order: order++, kind: 'thought', item });
      else if (item.kind === 'tool') entries.push({ t, order: order++, kind: item.browser ? 'browser' : 'quiet', item });
    }
  }
  // A sign-in found already there is told after the person's first words, not before them.
  const asked = entries.find((entry) => entry.kind === 'user')?.t ?? 0;
  for (const wait of model.waits ?? []) entries.push({ t: wait.remembered ? Math.max(wait.t0, asked + 1) : wait.t0, order: order++, kind: 'wait', wait });
  entries.sort((a, b) => a.t - b.t || a.order - b.order);

  // Browser steps with nothing said between them are one card; the thoughts and the other tool steps between two visible things fold into one
  // quiet disclosure ("Thought · 3 steps"), opened to read.
  let browsing: ToolItem[] = [];
  let thoughts: string[] = [];
  let hidden = false;
  let quiet: ToolItem[] = [];
  const flushBrowser = () => { if (browsing.length) column.append(browserCard(recording, browsing)); browsing = []; };
  const flushQuiet = () => {
    if (!hidden && quiet.length === 0 && thoughts.length === 0) return;
    const named = thoughts.length > 0 || hidden ? 'Thought' : 'Worked';
    const summary = quiet.length > 0 ? `${named} · ${quiet.length} ${quiet.length === 1 ? 'step' : 'steps'}` : named;
    column.append(reportEl('details', { class: 'mu-quiet-group' }, reportEl('summary', { text: summary }),
      ...thoughts.filter((text) => text.trim() !== '').map((text) => reportEl('div', { class: 'mu-thought-body' }, ...reportParagraphs(museShorten(text)))),
      quiet.length > 0 && reportEl('ul', { class: 'mu-steps-list' }, ...quiet.map((step) => reportEl('li', { text: museShorten(step.title).slice(0, 140) })))));
    thoughts = []; quiet = []; hidden = false;
  };
  const said: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'browser') { if (browsing.length === 0) flushQuiet(); browsing.push(entry.item as ToolItem); continue; }
    if (entry.kind === 'quiet') { quiet.push(entry.item as ToolItem); continue; }
    if (entry.kind === 'thought') { const item = entry.item as Extract<ChatItem, { kind: 'thinking' }>; thoughts.push(item.text); if (item.redacted) hidden = true; continue; }
    flushBrowser(); flushQuiet();
    if (entry.kind === 'wait') column.append(signInCard(entry.wait!));
    else if (entry.kind === 'user') {
      const item = entry.item as Extract<ChatItem, { kind: 'user' }>;
      if (item.text.trim() !== '') column.append(reportEl('div', { class: 'mu-row person' }, reportEl('div', { class: 'mu-tag', text: 'You' }), reportEl('div', { class: 'mu-bubble' }, ...reportParagraphs(museShorten(item.text)))));
    } else if (entry.kind === 'agent') {
      const item = entry.item as Extract<ChatItem, { kind: 'assistant' }>;
      if (item.text.trim() !== '') { column.append(agentBubble(item.text, name)); said.push(item.text.replace(/\s+/g, ' ')); }
    }
  }
  flushBrowser(); flushQuiet();
  // A run that delivered its answer as a saved result (not as a message) has it drawn here, as the agent's last bubble, unless the conversation already said it.
  if (model.answer && model.answer.from !== 'text') {
    const { text, chips } = savedAnswer(model.answer);
    const unsaid = model.answer.rows.filter((row) => row.text !== '' && !said.some((each) => each.includes(row.text.replace(/\s+/g, ' '))));
    if (text !== '' && (unsaid.length > 0 || (chips.length > 0 && model.answer.rows.every((row) => row.text === '')))) column.append(agentBubble(text, name, chips));
  }
  const memory = model.artifact ? rememberCard(recording, model.artifact) : undefined;
  if (memory) column.append(memory.card);
  // The end of the conversation: a marker after the last card, so "Done" waits for the card's END, not its top.
  const end = reportEl('div', { class: 'mu-end', 'aria-hidden': 'true' });
  column.append(end);

  const composer = reportEl('footer', { class: 'mu-composer' }, reportEl('div', { class: 'mu-input', text: 'This is a replay of a recorded run.' }));
  root.append(header, column, composer);

  // A finished run is "Done" once the end of its conversation has been in view; until then it reads as working, as it did when it ran. The marker is watched only
  // once the last card holds what it will hold (a card still reading is a short line), and the observer is sticky.
  const state = header.querySelector('.mu-state');
  if (model.agent?.status === 'done' && state && typeof IntersectionObserver === 'function') {
    state.className = 'mu-state working';
    state.textContent = STATE.working;
    void (memory?.settled ?? Promise.resolve()).then(() => {
      // The composer's fade covers the foot of the column: the end counts once it is above it.
      const seen = new IntersectionObserver((changes) => {
        if (!changes.some((change) => change.isIntersecting)) return;
        seen.disconnect();
        state.className = 'mu-state done';
        state.textContent = STATE.done;
      }, { root: column, rootMargin: '0px 0px -96px 0px' });
      seen.observe(end);
    });
  }
}
