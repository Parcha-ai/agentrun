import { Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { ACCEPT_LIMITS, type ConditionDraft, emptyCondition, emptyRule, OP_WORDS, OPS, type Op, type RuleDraft } from "@/lib/accept";

// The filter editor of a webhook or GitHub trigger (lib/accept.ts): rules, each an event, its actions and conditions on
// the body. The webhook form and a webhook's filter edit use AcceptEditor whole; the GitHub form keeps its event picker
// and gives each picked event a ConditionList, with AcceptEditor for the events the picker doesn't offer. Every issue,
// the form's own or the server's, is shown under the field the server names (`source.accept[i].where[j].pointer`).

type Issues = Record<string, string>;

/** What the event is, and where conditions read, for each signature scheme (serve's trigger-signatures.ts). */
export const EVENT_HINTS: Record<"standard" | "github" | "composio", string> = {
  standard: "The event is the JSON body's top-level type (Standard Webhooks), such as issue.opened. Conditions read the body: /title is its title.",
  github: "The event is the X-GitHub-Event header: pull_request, issue_comment, push. Conditions read the body.",
  composio: "The event is the body's metadata.trigger_slug, such as GITHUB_ISSUE_ADDED_EVENT (else its type, as composio.connected_account.expired). Conditions read the whole body, where the event's own data is under /data/: /data/title.",
};

/** How an `in` list's lines are read (valueOfLine), said under it. */
export const IN_HINT = "One value a line. A number, true, false or null is that JSON value, and so is a line in double quotes (\"42\" is the text 42) or a {…} or […]. Any other line is its text.";

/** An issue under its field, marked with the field's server name. */
const said = (issues: Issues, field: string) => (issues[field] ? <span data-issue={field}>{issues[field]}</span> : undefined);
/** An issue that has no field of its own on the page (a rule's, a condition's), as a line. */
export const Said = ({ issues, field }: { issues: Issues; field: string }) =>
  issues[field] ? <p className="font-mono text-small text-destructive-text" role="alert"><span data-issue={field}>{issues[field]}</span></p> : null;

/** A rule's conditions. `name`: the prefix of every control's name (`accept-0`); `at`: the rule's field as the server
 *  names it (`source.accept[0]`). */
export function ConditionList({ name, at, where, onChange, issues, label }: { name: string; at: string; where: ConditionDraft[]; onChange: (where: ConditionDraft[]) => void; issues: Issues; label: string }) {
  const set = (j: number, change: Partial<ConditionDraft>) => onChange(where.map((c, k) => (k === j ? { ...c, ...change } : c)));
  // A list's lines become the starts-with text's first one: an input holds one line.
  const pickOp = (j: number, op: Op) => set(j, op === "prefix" ? { op, value: where[j]!.value.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? "" } : { op });
  const full = where.length >= ACCEPT_LIMITS.conditions;
  return (
    <div className="min-w-0 space-y-2">
      <p className="caps text-small font-semibold">{label} <span className="font-normal normal-case text-muted-foreground">(optional)</span></p>
      {where.length > 0 && <p className="text-small text-muted-foreground">Each names a field of the body as a JSON pointer (/title, /issue/labels/0/name) and a test; all of them must hold.</p>}
      <Said issues={issues} field={`${at}.where`} />
      {where.map((c, j) => {
        const here = `${at}.where[${j}]`;
        const n = `${name}-where-${j}`;
        return (
          <div key={c.key} data-condition={n} className="space-y-3 border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Field" className="min-w-40 flex-1" error={said(issues, `${here}.pointer`)}>
                <Input name={`${n}-pointer`} value={c.pointer} onChange={(e) => set(j, { pointer: e.target.value })} placeholder="/title" autoComplete="off" spellCheck={false} />
              </Field>
              <Segmented name={`${n}-op`} label={`Condition ${j + 1}'s test`} value={c.op} onChange={(op) => pickOp(j, op)} options={OPS.map((op) => ({ value: op, label: OP_WORDS[op] }))} />
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove condition ${j + 1}`} onClick={() => onChange(where.filter((_, k) => k !== j))}><X aria-hidden /></Button>
            </div>
            {c.op === "in" && (
              <Field label="Values" hint={IN_HINT} error={said(issues, `${here}.in`)}>
                <Textarea name={`${n}-value`} rows={3} value={c.value} onChange={(e) => set(j, { value: e.target.value })} spellCheck={false} />
              </Field>
            )}
            {c.op === "prefix" && (
              <Field label="Text" hint="Its first line, trimmed, starts with this, in any case." error={said(issues, `${here}.prefix`)}>
                <Input name={`${n}-value`} value={c.value} onChange={(e) => set(j, { value: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
            )}
            <Said issues={issues} field={here} />
            <Said issues={issues} field={`${here}.exists`} />
          </div>
        );
      })}
      <Button type="button" size="sm" onClick={() => onChange([...where, emptyCondition()])} disabled={full}><Plus aria-hidden /> Add a condition</Button>
    </div>
  );
}

/** A filter's rules, each an event typed by its name, its actions and its conditions. `name`: the prefix of every
 *  control's name (`accept`); `indexOf`: a rule's index in the sent `accept` (the GitHub form mixes its picker's rules in);
 *  `room`: how many rules may still be added in all. */
export function AcceptEditor({ name, rules, onChange, issues, indexOf = (i) => i, room, eventHint, eventPlaceholder, addLabel = "Add a rule", empty }: {
  name: string; rules: RuleDraft[]; onChange: (rules: RuleDraft[]) => void; issues: Issues; indexOf?: (i: number) => number; room: number; eventHint: string; eventPlaceholder?: string; addLabel?: string; empty?: ReactNode;
}) {
  const set = (i: number, change: Partial<RuleDraft>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...change } : r)));
  return (
    <div className="min-w-0 space-y-3">
      {!rules.length && empty}
      {rules.map((r, i) => {
        const at = `source.accept[${indexOf(i)}]`;
        const n = `${name}-${i}`;
        return (
          <section key={r.key} data-rule={n} aria-label={`Rule ${i + 1}`} className="space-y-4 border p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="caps text-label text-muted-foreground">Rule {i + 1}</p>
              <Button type="button" size="xs" variant="ghost" aria-label={`Remove rule ${i + 1}`} onClick={() => onChange(rules.filter((_, k) => k !== i))}><Trash2 aria-hidden /> Remove</Button>
            </div>
            <Said issues={issues} field={at} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Event" hint={eventHint} error={said(issues, `${at}.event`)}>
                <Input name={`${n}-event`} value={r.event} onChange={(e) => set(i, { event: e.target.value })} placeholder={eventPlaceholder} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Actions" optional hint="The body's top-level action is one of these, split by commas (opened, edited). None: any action, or none." error={said(issues, `${at}.actions`)}>
                <Input name={`${n}-actions`} value={r.actions} onChange={(e) => set(i, { actions: e.target.value })} placeholder="opened, edited" autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <ConditionList name={n} at={at} where={r.where} onChange={(where) => set(i, { where })} issues={issues} label="Only when" />
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => onChange([...rules, emptyRule()])} disabled={room <= 0}><Plus aria-hidden /> {addLabel}</Button>
        {room <= 0 && <span className="text-small text-muted-foreground">{ACCEPT_LIMITS.rules} rules, the most a trigger takes.</span>}
      </div>
    </div>
  );
}
