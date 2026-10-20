// The Muse layout of a recorded run: the same events as the chat view, drawn as a phone chat. A round avatar at the top with the agent's
// name and state under it; one column of bubbles (the person's words right-aligned, the agent's replies as bubbles, its thinking folded and
// quiet); the browser inline as a card with the agent's last frame; a sign-in card where the run waited for a person; the answer as the agent's
// bubble with the files it names as chips; and "What I remember" as a card. No report page beside it, and no web address in what it shows:
// every address is shortened to its host. Everything comes from the model made of the recording's own lines (extractChat with `muse`).
import type { ChatBrowser, ChatItem, ChatModel } from './chat-model.ts';
import { fetchBlob } from './blobs.ts';
import { reportEl, reportParagraphs } from './chat-report.ts';
import type { Recording } from './format.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** A text with every web address shortened to its host: the chat shows where, never the whole address. */
export function museShorten(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, (address) => { try { return new URL(address).host || address; } catch { return address; } });
}

const FILE = /[\w][\w .-]*\.(?:pdf|csv|xlsx?|docx?|pptx?|txt|json|md|zip|png|jpe?g)\b/gi;

/** The files a text names: each as a chip. A line that is only a file's name (a list item) is taken out of the text, so the chip is not said twice. */
export function museFiles(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const kept = text.split('\n').filter((line) => {
    const bare = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (bare !== '' && new RegExp(`^${FILE.source}$`, 'i').test(bare)) { if (!files.includes(bare)) files.push(bare); return false; }
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  for (const found of kept.match(FILE) ?? []) { const name = found.trim(); if (!files.includes(name)) files.push(name); }
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

/** The browser as one card: the latest frame the steps held, who has it, and Take control (shown, disabled: a replay is over). */
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
  const take = reportEl('button', { class: 'mu-take', type: 'button', disabled: true, title: 'Replay: the run is over', text: 'Take control' });
  return card('mu-browser', 'globe', 'Browser', site ? `Browsing ${site}` : 'Browsing',
    reportEl('div', { class: 'mu-shot' }, src ? reportEl('img', { loading: 'lazy', src, alt: site ? `The browser on ${site}` : 'The browser' }) : reportEl('span', { class: 'mu-shot-none', text: 'No picture was recorded here' })),
    reportEl('div', { class: 'mu-strip' }, reportEl('div', { class: 'mu-labels' }, ...labels.map((label) => reportEl('span', { class: `mu-label${label.held ? ' held' : ''}`, text: label.text }))), take));
}

/** Where the run waited for a person to sign in: asked, and signed in once the browser's own profile says so. */
function signInCard(wait: NonNullable<ChatModel['waits']>[number]): HTMLElement {
  const button = reportEl('button', { class: 'mu-wide', type: 'button', disabled: true, title: 'Replay: the run is over', text: wait.t1 === undefined ? 'Waiting for you' : 'Signed in' });
  return card('mu-signin', 'shield', 'Secure Store', `Sign in to ${wait.site}`, button);
}

/** A bubble of the agent's words (a paragraph per blank line), the files it names as chips under them. */
function agentBubble(text: string): HTMLElement {
  const { text: words, files } = museFiles(museShorten(text));
  return reportEl('div', { class: 'mu-row agent' }, reportEl('div', { class: 'mu-bubble' }, ...reportParagraphs(words)),
    files.length > 0 && reportEl('div', { class: 'mu-files' }, ...files.map((name) => reportEl('span', { class: 'mu-file', title: name, text: name }))));
}

/** "What I remember": the host's artifact, read as a page and drawn as lines (its headings, lists and notes), every address shortened. When it cannot be read, the card says so. */
function rememberCard(recording: Recording, artifact: NonNullable<ChatModel['artifact']>): HTMLElement {
  const body = reportEl('div', { class: 'mu-remember' }, reportEl('p', { class: 'mu-quiet', text: 'Reading what the agent kept…' }));
  const sha = artifact.files[artifact.entry];
  const url = sha ? recording.blobUrl(sha) : undefined;
  const failed = (why: string) => body.replaceChildren(reportEl('p', { class: 'mu-quiet', text: `What the agent remembers could not be read here${why ? ` (${why})` : ''}.` }));
  if (!url) failed('it is not in this recording');
  else {
    void fetchBlob(url).then((response) => (response.ok ? response.text() : Promise.reject(new Error(`the page answered ${response.status}`)))).then((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parts: HTMLElement[] = [];
      let skippedTitle = false;
      for (const node of [...doc.body.children]) {
        const tag = node.tagName.toLowerCase();
        const text = museShorten((node.textContent ?? '').replace(/[ \t]+/g, ' ').trim());
        if (tag === 'h1' && !skippedTitle) { skippedTitle = true; continue; }
        if (tag === 'h1' || tag === 'h2') parts.push(reportEl('h3', { class: 'mu-rh', text }));
        else if (tag === 'h3' || tag === 'h4') parts.push(reportEl('div', { class: 'mu-rsub', text }));
        else if (tag === 'ul' || tag === 'ol') parts.push(reportEl('ul', { class: 'mu-rlist' }, ...[...node.querySelectorAll('li')].map((li) => reportEl('li', { text: museShorten((li.textContent ?? '').replace(/\s+/g, ' ').trim()) }))));
        else if (text !== '') parts.push(reportEl('p', { class: tag === 'pre' ? 'mu-rpre' : 'mu-rp', text }));
      }
      if (parts.length === 0) failed('the page held nothing to show'); else body.replaceChildren(...parts);
    }).catch((error: unknown) => failed(String((error as Error)?.message ?? error).slice(0, 80)));
  }
  return card('mu-memory', 'brain', 'What I remember', 'Kept between runs', body);
}

const STATE = { done: 'Done', waiting: 'Waiting for you', working: 'is working' } as const;

/** The whole page. `root` takes the Muse layout; nothing of the analyst chat view is drawn. */
export function drawMuse(root: HTMLElement, model: ChatModel, recording: Recording): void {
  root.replaceChildren();
  root.classList.add('muse');
  const name = model.agent?.name ?? model.title;
  const header = reportEl('header', { class: 'mu-top' },
    reportEl('div', { class: 'mu-avatar', 'aria-hidden': 'true', text: [...name][0]?.toUpperCase() ?? '·' }),
    reportEl('div', { class: 'mu-name', text: name }),
    reportEl('div', { class: `mu-state ${model.agent?.status ?? 'working'}`, text: STATE[model.agent?.status ?? 'working'] }));
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
  for (const wait of model.waits ?? []) entries.push({ t: wait.t0, order: order++, kind: 'wait', wait });
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
  for (const entry of entries) {
    if (entry.kind === 'browser') { if (browsing.length === 0) flushQuiet(); browsing.push(entry.item as ToolItem); continue; }
    if (entry.kind === 'quiet') { quiet.push(entry.item as ToolItem); continue; }
    if (entry.kind === 'thought') { const item = entry.item as Extract<ChatItem, { kind: 'thinking' }>; thoughts.push(item.text); if (item.redacted) hidden = true; continue; }
    flushBrowser(); flushQuiet();
    if (entry.kind === 'wait') column.append(signInCard(entry.wait!));
    else if (entry.kind === 'user') {
      const item = entry.item as Extract<ChatItem, { kind: 'user' }>;
      if (item.text.trim() !== '') column.append(reportEl('div', { class: 'mu-row person' }, reportEl('div', { class: 'mu-bubble' }, ...reportParagraphs(museShorten(item.text)))));
    } else if (entry.kind === 'agent') {
      const item = entry.item as Extract<ChatItem, { kind: 'assistant' }>;
      if (item.text.trim() !== '') column.append(agentBubble(item.text));
    }
  }
  flushBrowser(); flushQuiet();
  if (model.artifact) column.append(rememberCard(recording, model.artifact));

  const composer = reportEl('footer', { class: 'mu-composer' }, reportEl('div', { class: 'mu-input', text: 'This is a replay of a recorded run.' }));
  root.append(header, column, composer);
}
