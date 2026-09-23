import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { cleanText } from './presentation.js';

/** Structural view contract: the inspector never executes or changes a workflow. */
export interface InspectorView {
  title: string; digest: string; status: string; summary: string[];
  nodes: { path: string; label: string; kind: string; status: string; summary: string; details: string[] }[];
  output?: string[];
  readOnly?: boolean;
}
export type InspectorAction = 'run' | 'save' | 'load' | 'input' | 'history' | 'stop' | 'edit';
type Page = 'overview' | 'stages' | 'detail' | 'output' | 'actions';
const MAX_CHARS = 24_000, MAX_LINES = 600;
const safeLine = (value: string) => cleanText(value).replace(/[\n\t]/g, ' ');

/** Exported for deterministic rendering/navigation tests, without a terminal or model. */
export class WorkflowInspector implements Component {
  private page: Page = 'overview';
  private selected = 0;
  private selectedPath?: string;
  private actionIndex = 0;
  private scroll = 0;
  private viewport = 12;
  private detailLength = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly getView: () => InspectorView,
    private readonly theme: Pick<Theme, 'fg' | 'bold'>,
    private readonly done: (action: InspectorAction | undefined) => void,
    private readonly redraw: () => void = () => {},
    private readonly rows: () => number = () => 24) {}

  startRefresh(): void {
    if (this.timer) return;
    let previous = this.fingerprint();
    this.timer = setInterval(() => {
      const next = this.fingerprint();
      if (next !== previous) { previous = next; this.redraw(); }
    }, 250);
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  invalidate(): void { /* Rendering always reads the current view and theme. */ }

  private view(): InspectorView {
    const view = this.getView();
    const index = this.selectedPath ? view.nodes.findIndex(node => node.path === this.selectedPath) : -1;
    this.selected = Math.max(0, Math.min(index >= 0 ? index : this.selected, view.nodes.length - 1));
    this.selectedPath = view.nodes[this.selected]?.path;
    return view;
  }
  private actions(view: InspectorView): InspectorAction[] {
    if (view.readOnly) return [];
    return view.status === 'running' ? ['stop', 'history'] : ['run', 'input', 'edit', 'save', 'load', 'history'];
  }
  private fingerprint(): string {
    const view = this.view();
    // Track the visible projection, not raw receipts or the whole workflow state.
    const visible = this.page === 'detail' ? view.nodes[this.selected]?.details ?? []
      : this.page === 'output' ? view.output ?? [] : view.summary;
    let budget = MAX_CHARS;
    const text: string[] = [];
    for (const line of visible) { if (budget <= 0 || text.length >= MAX_LINES) break; text.push(line.slice(0, budget)); budget -= line.length; }
    return JSON.stringify([view.title, view.digest, view.status, view.readOnly, view.output !== undefined,
      view.nodes.map(node => [node.path, node.label, node.kind, node.status, node.summary]), text]);
  }
  handleInput(data: string): void {
    const view = this.view();
    if (matchesKey(data, 'escape')) {
      if (this.page === 'overview') { this.dispose(); this.done(undefined); return; }
      this.page = this.page === 'detail' ? 'stages' : 'overview'; this.scroll = 0;
    } else if (matchesKey(data, 'ctrl+c')) {
      // Close the view, never silently cancel a workflow.
      this.dispose(); this.done(undefined); return;
    } else if (data === 'a' && !view.readOnly && this.page !== 'actions') {
      this.page = 'actions'; this.actionIndex = 0; this.scroll = 0;
    } else if (data === 'g') {
      this.page = 'stages'; this.scroll = 0;
    } else if (data === 'v') {
      this.page = 'overview'; this.scroll = 0;
    } else if (data === 'o' && view.output) {
      this.page = 'output'; this.scroll = 0;
    } else if (matchesKey(data, 'enter')) {
      if (this.page === 'actions') {
        const action = this.actions(view)[this.actionIndex];
        if (action) { this.dispose(); this.done(action); return; }
      } else if (this.page === 'overview') {
        this.page = 'stages'; this.scroll = 0;
      } else if (this.page === 'stages' && view.nodes.length) {
        this.page = 'detail'; this.scroll = 0;
      }
    } else {
      const direction = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : 0;
      const pageDirection = matchesKey(data, 'pageUp') ? -1 : matchesKey(data, 'pageDown') ? 1 : 0;
      const amount = direction || pageDirection * this.viewport;
      if (this.page === 'stages') {
        this.selected = Math.max(0, Math.min(view.nodes.length - 1, this.selected + amount));
        this.selectedPath = view.nodes[this.selected]?.path;
      } else if (this.page === 'actions') {
        this.actionIndex = Math.max(0, Math.min(this.actions(view).length - 1, this.actionIndex + amount));
      } else this.scroll = Math.max(0, Math.min(Math.max(0, this.detailLength - this.viewport), this.scroll + amount));
    }
    this.redraw();
  }

  private wrapped(values: Iterable<string>, width: number): { lines: string[]; clipped: boolean } {
    const lines: string[] = [];
    let remaining = MAX_CHARS, clipped = false;
    for (const value of values) {
      if (!remaining || lines.length >= MAX_LINES) { clipped = true; break; }
      // Slice before sanitizing/wrapping so a huge individual field stays bounded.
      const portion = value.slice(0, remaining);
      remaining -= portion.length;
      if (portion.length < value.length) clipped = true;
      const clean = cleanText(portion).replace(/\t/g, '  ');
      const paragraphs = clean.split('\n');
      for (const [index, line] of paragraphs.entries()) {
        const wrapped = wrapTextWithAnsi(line, width);
        const available = MAX_LINES - lines.length;
        if (wrapped.length > available) clipped = true;
        lines.push(...wrapped.slice(0, available));
        if (lines.length >= MAX_LINES) { if (index < paragraphs.length - 1) clipped = true; break; }
      }
    }
    return { lines, clipped };
  }

  render(width: number): string[] {
    const view = this.view();
    const columns = Math.max(1, width);
    // Cover the viewport except Pi's two status rows, including on tall terminals.
    const height = Math.max(8, this.rows() - 2);
    this.viewport = height - 6;
    const cut = (value: string) => truncateToWidth(safeLine(value.slice(0, MAX_CHARS)), columns);
    const title = this.theme.bold(cut(view.title));
    const subtitle = cut(`${view.status} · ${view.digest.slice(0, 12)}`);
    let body: string[] = [], position = '', clipped = false;
    if (this.page === 'stages') {
      const first = Math.max(0, Math.min(this.selected - Math.floor(this.viewport / 2), view.nodes.length - this.viewport));
      body = view.nodes.slice(first, first + this.viewport).map((node, index) => {
        const selected = first + index === this.selected;
        const depth = Math.min(5, (node.path.match(/\/(?:steps|body|branches|workflow)(?:\/|$)/g) ?? []).length);
        const text = cut(`${selected ? '›' : ' '} ${'  '.repeat(depth)}${node.label} · ${node.kind} · ${node.status}`);
        return selected ? this.theme.fg('accent', text) : text;
      });
      if (!body.length) body = [cut('No stages yet. Use Actions to load a workflow.')];
      position = view.nodes.length ? `Stage ${this.selected + 1}/${view.nodes.length}` : 'No stages';
    } else if (this.page === 'actions') {
      const actions = this.actions(view);
      this.actionIndex = Math.min(this.actionIndex, actions.length - 1);
      const labels: Record<InspectorAction, string> = { run: 'Run this workflow', save: 'Save procedure', load: 'Load procedure', input: 'Change input', history: 'Inspect run history', stop: 'Stop running workflow', edit: 'Edit procedure' };
      const first = Math.max(0, this.actionIndex - this.viewport + 1);
      body = actions.slice(first, first + this.viewport).map((action, index) => cut(`${first + index === this.actionIndex ? '›' : ' '} ${labels[action]}`));
      position = 'Choose an action; execution stays with Pi.';
    } else {
      const node = view.nodes[this.selected];
      const details = function* () {
        if (!node) { yield 'This stage is no longer available.'; return; }
        yield node.label; yield `${node.kind} · ${node.status}`; yield node.path; yield node.summary;
        yield* node.details;
      };
      const values = this.page === 'overview' ? view.summary : this.page === 'output' ? view.output ?? ['No output recorded.'] : details();
      const wrapped = this.wrapped(values, columns);
      this.detailLength = wrapped.lines.length; clipped = wrapped.clipped;
      this.scroll = Math.max(0, Math.min(this.scroll, this.detailLength - this.viewport));
      body = wrapped.lines.slice(this.scroll, this.scroll + this.viewport);
      position = `${this.page === 'overview' ? 'Overview' : this.page === 'output' ? 'Output' : 'Stage details'} · lines ${this.detailLength ? this.scroll + 1 : 0}–${Math.min(this.scroll + this.viewport, this.detailLength)}/${this.detailLength}`;
    }
    while (body.length < this.viewport) body.push('');
    const guidance = this.page === 'stages' ? '↑↓ stages · Enter inspect · v overview' : this.page === 'actions' ? '↑↓ actions · Enter choose · Esc back' : '↑↓ scroll · g stages · v overview';
    const footer = clipped ? 'Display clipped; see full run record.' : `${view.readOnly ? 'Read-only · ' : 'a actions · '}${view.output ? 'o output · ' : ''}${this.page === 'overview' ? 'Esc close' : 'Esc back'}`;
    return [title, subtitle, cut(position), ...body.slice(0, this.viewport),
      this.theme.fg('muted', cut(guidance)), this.theme.fg(clipped ? 'warning' : 'muted', cut(footer)), ''];
  }
}

export async function showWorkflowInspector(ctx: ExtensionContext, getView: () => InspectorView): Promise<InspectorAction | undefined> {
  if (ctx.mode !== 'tui') return undefined;
  return ctx.ui.custom<InspectorAction | undefined>((tui, theme, _keys, done) => {
    const component = new WorkflowInspector(getView, theme, done, () => tui.requestRender(), () => tui.terminal.rows);
    component.startRefresh();
    return component;
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, anchor: 'top-left' } });
}
