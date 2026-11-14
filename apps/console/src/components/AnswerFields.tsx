import { useState } from "react";
import { Button } from "@/components/ui/button";
import { keyLabel } from "@/lib/answerJson";
import { type LinkedFiles, markdown } from "@/lib/format";

/** The part of a JSON Schema a value is read with: a string marked `contentMediaType: "text/markdown"` is Markdown, an
 *  object's properties and an array's items carry their own, and `title` names a field. Anything else is ignored. */
type Shape = { contentMediaType?: unknown; title?: unknown; properties?: Record<string, unknown>; items?: unknown };
const shapeOf = (schema: unknown): Shape | undefined => (schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Shape) : undefined);
const propertyOf = (schema: unknown, key: string): Shape | undefined => shapeOf(shapeOf(schema)?.properties?.[key]);
const isMarkdown = (schema: unknown): boolean => shapeOf(schema)?.contentMediaType === "text/markdown";

/** How a record reads: its schema (the agent's output schema), and the run's files a Markdown link may name. */
type Reading = { schema?: unknown; linked?: LinkedFiles };

/** One JSON value in words: a string wraps in place (Markdown when its schema says text/markdown), a number or boolean as
 *  written, null as "—", an object as its fields indented, an array as a list (an empty one says "none"). */
function Value({ value, schema, linked }: { value: unknown } & Reading) {
  if (value === null || value === undefined) return <span data-json-value className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span data-json-value className="text-muted-foreground">none</span>;
    const items = shapeOf(schema)?.items;
    return (
      <ul data-json="array" className="list-disc space-y-1 pl-5">
        {value.map((item, i) => <li key={i} className="min-w-0 break-words [overflow-wrap:anywhere]"><Value value={item} schema={items} linked={linked} /></li>)}
      </ul>
    );
  }
  if (typeof value === "object") return <Fields record={value as Record<string, unknown>} schema={schema} linked={linked} />;
  if (typeof value === "string" && isMarkdown(schema)) return <article data-json-markdown className="report max-w-none" dangerouslySetInnerHTML={{ __html: markdown(value, linked) }} />;
  return <span data-json-value className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</span>;
}

/** An object's fields: each key's label (its schema's title, else the key) over its value; a nested object's fields
 *  indented under it. */
function Fields({ record, schema, linked }: { record: Record<string, unknown> } & Reading) {
  return (
    <dl data-json="object" className="min-w-0 space-y-3 border-l pl-4">
      {Object.entries(record).map(([key, value]) => {
        const own = propertyOf(schema, key);
        return (
          <div key={key} className="min-w-0">
            <dt className="caps break-words [overflow-wrap:anywhere] text-label text-muted-foreground">{typeof own?.title === "string" && own.title.trim() ? own.title : keyLabel(key)}</dt>
            <dd className="mt-1 min-w-0 text-prose leading-relaxed">{<Value value={value} schema={own} linked={linked} />}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A record read as fields, with "Show raw JSON" for it pretty-printed and wrapped (no clipping): the record an answer ends
 *  in, or an agentic run's result.output read with its agent's output schema (`schema`), whose text/markdown strings render
 *  as Markdown sections. */
export function AnswerFields({ record, schema, linked }: { record: Record<string, unknown> } & Reading) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex justify-end">
        <Button type="button" size="xs" onClick={() => setRaw((r) => !r)}>{raw ? "Show fields" : "Show raw JSON"}</Button>
      </div>
      {raw
        ? <pre aria-label="The answer's JSON" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] border bg-card p-4 font-mono text-small leading-[1.8]">{JSON.stringify(record, null, 2)}</pre>
        : <div aria-label="The answer's fields" className="min-w-0 [&>dl]:border-l-0 [&>dl]:pl-0"><Fields record={record} schema={schema} linked={linked} /></div>}
    </section>
  );
}
