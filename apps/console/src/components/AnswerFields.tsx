import { useState } from "react";
import { keyLabel } from "@/lib/answerJson";

/** One JSON value in words: a string wraps in place, a number or boolean as written, null as "—", an object as its fields
 *  indented, an array as a list (an empty one says "none"). */
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span data-json-value className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span data-json-value className="text-muted-foreground">none</span>;
    return (
      <ul data-json="array" className="list-disc space-y-1 pl-5">
        {value.map((item, i) => <li key={i} className="min-w-0 break-words [overflow-wrap:anywhere]">{item && typeof item === "object" ? <Value value={item} /> : String(item)}</li>)}
      </ul>
    );
  }
  if (typeof value === "object") return <Fields record={value as Record<string, unknown>} />;
  return <span data-json-value className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</span>;
}

/** An object's fields: each key's label over its value; a nested object's fields indented under it. */
function Fields({ record }: { record: Record<string, unknown> }) {
  return (
    <dl data-json="object" className="min-w-0 space-y-3 border-l pl-4">
      {Object.entries(record).map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="caps text-[11px] text-muted-foreground">{keyLabel(key)}</dt>
          <dd className="mt-1 min-w-0 text-[15px] leading-relaxed">{<Value value={value} />}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The record an answer ends in, read as fields, with "Show raw JSON" for it pretty-printed and wrapped (no clipping). */
export function AnswerFields({ record }: { record: Record<string, unknown> }) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={() => setRaw((r) => !r)} className="caps border px-3 py-1.5 text-[11px] hover:bg-accent">{raw ? "Show fields" : "Show raw JSON"}</button>
      </div>
      {raw
        ? <pre aria-label="The answer's JSON" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] border bg-card p-4 font-mono text-[12px] leading-[1.8]">{JSON.stringify(record, null, 2)}</pre>
        : <div aria-label="The answer's fields" className="min-w-0 [&>dl]:border-l-0 [&>dl]:pl-0"><Fields record={record} /></div>}
    </section>
  );
}
