export const failedCall = (call) => call.result?.tool_status === "failed";
const plain = (call) => !failedCall(call) && call.inner.length === 0;
const foldable = (group) => group.type === "calls" && group.calls.length === group.rounds && group.calls.every(plain);
/**
 * Rows to groups. A round is the calls of one assistant entry, in the order written. A row that names a parent call (a
 * nested call, a subagent's rows) sits inside that call. Adjacent rounds of one call of the same tool fold into one
 * group; any other row, a failed call or a call with inner rows ends the fold. Calls are never deduped.
 */
export function groupTimeline(rows) {
    const uses = new Map();
    const results = new Map();
    for (const row of rows) {
        if (row.kind === "tool_use" && row.tool_use_id)
            uses.set(row.tool_use_id, row);
        else if (row.kind === "tool_result" && row.tool_use_id)
            results.set(row.tool_use_id, row);
    }
    const inside = new Map();
    const top = [];
    for (const row of rows) {
        const named = row.parent_tool_use_id ?? (row.kind === "subagent_started" || row.kind === "subagent_completed" ? row.tool_use_id : null);
        const parent = named && uses.has(named) ? named : undefined;
        if (parent)
            inside.set(parent, [...(inside.get(parent) ?? []), row]);
        else if (!(row.kind === "tool_result" && row.tool_use_id && uses.has(row.tool_use_id)))
            top.push(row);
    }
    const lead = (row) => (row.kind === "subagent_started" ? 0 : row.kind === "subagent_completed" ? 2 : 1);
    const groups = [];
    for (const row of top) {
        if (row.kind !== "tool_use" || !row.tool_use_id) {
            groups.push({ type: "row", row });
            continue;
        }
        const call = { use: row, result: results.get(row.tool_use_id), inner: groupTimeline((inside.get(row.tool_use_id) ?? []).sort((a, b) => lead(a) - lead(b))) };
        const last = groups.at(-1);
        if (last?.type === "calls" && row.round !== undefined && last.round === row.round && last.conv === row.conversation_id)
            last.calls.push(call);
        else
            groups.push({ type: "calls", round: row.round, conv: row.conversation_id, rounds: 1, calls: [call] });
    }
    const folded = [];
    for (const group of groups) {
        const last = folded.at(-1);
        if (last && foldable(last) && foldable(group) && last.conv === group.conv && last.calls[0].use.tool_name === group.calls[0].use.tool_name) {
            last.calls.push(...group.calls);
            last.rounds += group.rounds;
        }
        else
            folded.push(group);
    }
    return folded;
}
/** Adjacent calls of one tool inside a group, folded; a call with inner rows keeps its own line. */
export function foldCalls(calls) {
    const folds = [];
    for (const call of calls) {
        const tool = call.use.tool_name ?? "";
        const last = folds.at(-1);
        if (last && last.tool === tool && call.inner.length === 0 && last.calls.every((other) => other.inner.length === 0))
            last.calls.push(call);
        else
            folds.push({ tool, calls: [call] });
    }
    return folds;
}
