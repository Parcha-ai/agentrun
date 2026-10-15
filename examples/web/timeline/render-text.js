import { foldCalls, groupTimeline } from "./group.js";
import { foldLabel } from "./labels.js";
const clock = (row) => row.timestamp.slice(11, 19);
const statusOf = (call) => !call.result ? "running" : call.result.tool_status === "success" ? "ok" : call.result.tool_result_size_bytes === null ? "interrupted" : "failed";
function rowText(row) {
    const summary = row.summary ?? row.kind;
    return row.kind === "text_block" ? `Agent: ${summary}` : row.kind === "final_answer" ? `Answer: ${summary}` : summary;
}
function foldEntry(fold) {
    const [only] = fold.calls;
    if (fold.calls.length === 1 && only)
        return { text: only.use.summary ?? fold.tool, status: statusOf(only), reasons: statusOf(only) === "failed" ? [only] : [] };
    const counts = new Map();
    for (const call of fold.calls)
        counts.set(statusOf(call), (counts.get(statusOf(call)) ?? 0) + 1);
    const status = [...counts].map(([name, count]) => `${count} ${name}`).join(", ");
    const text = foldLabel(fold.tool, fold.calls.map((call) => ({ input: call.use.tool_input_preview, output: call.result?.tool_result_preview ?? null })));
    return { text, status, reasons: fold.calls.filter((call) => statusOf(call) === "failed") };
}
function linesOf(groups, depth, fold) {
    const lines = [];
    for (const group of groups) {
        if (group.type === "row") {
            lines.push({ at: clock(group.row), depth, text: rowText(group.row) });
            continue;
        }
        const folds = fold ? foldCalls(group.calls) : group.calls.map((call) => ({ tool: call.use.tool_name ?? "", calls: [call] }));
        const at = clock(group.calls[0].use);
        const nested = folds.length > 1;
        if (nested)
            lines.push({ at, depth, text: `Ran ${group.calls.length} tools` });
        for (const entry of folds) {
            const { text, status, reasons } = foldEntry(entry);
            const inner = nested ? depth + 1 : depth;
            lines.push({ at: nested ? undefined : at, depth: inner, text: `${text.padEnd(58)}  ${status}` });
            for (const call of reasons)
                lines.push({ depth: inner + 1, text: call.result?.summary ?? statusOf(call) });
            for (const call of entry.calls)
                lines.push(...linesOf(call.inner, inner + 1, fold));
        }
    }
    return lines;
}
const isRows = (input) => input.every((item) => "kind" in item);
/** Plain text, one line per row or group: `HH:MM:SS  text`. `fold: false` shows every call on its own line. */
export function renderText(input, options = {}) {
    const groups = isRows(input) ? groupTimeline(input) : input;
    return linesOf(groups, 0, options.fold !== false)
        .map((line) => `${(line.at ?? "").padEnd(8)}  ${"  ".repeat(line.depth)}${line.text}`.trimEnd())
        .join("\n");
}
