// What the default chat view (chat.html?r=<id>, no &muse) draws, as one string a test can compare: the chat root's HTML with every blob:/data: address
// (which differs per build and per load) replaced by a mark. Run in the page; settles by waiting until the same HTML is read twice, 300 ms apart.
export const DEFAULT_VIEW = `(async () => {
  const read = () => document.querySelector('#chat-root').innerHTML.replace(/(src|href)="(?:blob|data):[^"]*"/g, '$1="…"');
  let last = read();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = read();
    if (now === last && document.querySelector('#chat-root .thread')) return now;
    last = now;
  }
  return last;
})()`;

/** The page's text without the rules the Muse layout adds (they start at its marker comment and run to the end of the style element). */
export const withoutMuseRules = (html: string): string => {
  const start = html.indexOf('/* The Muse layout');
  if (start < 0) return html;
  return html.slice(0, start) + html.slice(html.indexOf('</style>', start));
};
