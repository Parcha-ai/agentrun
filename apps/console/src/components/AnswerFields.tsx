import { useState } from "react";
import { Button } from "@/components/ui/button";
import { keyLabel } from "@/lib/answerJson";
import { type LinkedFiles, markdown } from "@/lib/format";

/** The part of a JSON Schema a value is read with: a string marked `contentMediaType: "text/markdown"` is Markdown, an
 *  object's properties and an array's items carry their own, `title` names a field, and a local `$ref` stands for the part
 *  of the root it points at. Anything else is ignored. */
type Shape = { contentMediaType?: unknown; title?: unknown; properties?: Record<string, unknown>; items?: unknown; $ref?: unknown };
const objectOf = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
/** `schema`, its local `$ref` ("#/$defs/report", any JSON pointer into `root`) followed, a few deep at most. */
function shapeOf(schema: unknown, root: unknown): Shape | undefined {
  let at = objectOf(schema) as Shape | undefined;
  for (let hops = 0; at && typeof at.$ref === "string" && at.$ref.startsWith("#") && hops < 8; hops++) {
    const path = at.$ref.slice(1).split("/").filter(Boolean).map((part) => decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~"));
    at = objectOf(path.reduce<unknown>((node, key) => objectOf(node)?.[key], root)) as Shape | undefined;
  }
  return at;
}
const isMarkdown = (schema: unknown, root: unknown): boolean => shapeOf(schema, root)?.contentMediaType === "text/markdown";

/** How a value reads: its schema (the agent's output schema, or the part of it for that value), the root schema a `$ref`
 *  points into, and the run's files a Markdown link may name. */
type Reading = { schema?: unknown; root?: unknown; linked?: LinkedFiles };

/** One JSON value in words: a string wraps in place (Markdown when its schema says text/markdown), a number or boolean as
 *  written, null as "—", an object as its fields indented, an array as a list (an empty one says "none"). */
function Value({ value, schema, root, linked }: { value: unknown } & Reading) {
  if (value === null || value === undefined) return <span data-json-value className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span data-json-value className="text-muted-foreground">none</span>;
    const items = shapeOf(schema, root)?.items;
    return (
      <ul data-json="array" className="list-disc space-y-1 pl-5">
        {value.map((item, i) => <li key={i} className="min-w-0 break-words [overflow-wrap:anywhere]"><Value value={item} schema={items} root={root} linked={linked} /></li>)}
      </ul>
    );
  }
  if (typeof value === "object") return <Fields record={value as Record<string, unknown>} schema={schema} root={root} linked={linked} />;
  if (typeof value === "string" && isMarkdown(schema, root)) return <article data-json-markdown className="report max-w-none" dangerouslySetInnerHTML={{ __html: markdown(value, linked) }} />;
  return <span data-json-value className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</span>;
}

/** An object's fields: each key's label (its schema's title, else the key) over its value; a nested object's fields
 *  indented under it. */
function Fields({ record, schema, root, linked }: { record: Record<string, unknown> } & Reading) {
  const properties = shapeOf(schema, root)?.properties;
  return (
    <dl data-json="object" className="min-w-0 space-y-3 border-l pl-4">
      {Object.entries(record).map(([key, value]) => {
        const own = properties?.[key];
        const title = shapeOf(own, root)?.title;
        return (
          <div key={key} className="min-w-0">
            <dt className="caps break-words [overflow-wrap:anywhere] text-label text-muted-foreground">{typeof title === "string" && title.trim() ? title : keyLabel(key)}</dt>
            <dd className="mt-1 min-w-0 text-prose leading-relaxed">{<Value value={value} schema={own} root={root} linked={linked} />}</dd>
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
        : <div aria-label="The answer's fields" className="min-w-0 [&>dl]:border-l-0 [&>dl]:pl-0"><Fields record={record} schema={schema} root={schema} linked={linked} /></div>}
    </section>
  );
}

/** An agentic run's result.output that is not an object (a list, a string, a number), read with its schema as a field's
 *  value is: a list of text/markdown strings as Markdown, item by item. */
export function AnswerValue({ value, schema, linked }: { value: unknown; schema?: unknown; linked?: LinkedFiles }) {
  return <div aria-label="The answer's value" className="min-w-0 text-prose leading-relaxed"><Value value={value} schema={schema} root={schema} linked={linked} /></div>;
}
