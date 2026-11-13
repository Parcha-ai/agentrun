type Named = { name: string; id: string };

/** The one order of every agent picker: by name, A to Z, ignoring case and accents ("beta" beside "Beta", "Éclair" with
 *  the e's), a number in a name read as a number ("agent 9" before "agent 10"), the id breaking a tie. The server lists
 *  agents newest first, which a person scanning many cannot read. */
export const byName = (a: Named, b: Named): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Agents in picker order (byName), by the name a picker shows: the definition's, else the id. */
export const agentsByName = <T extends { agent_id: string; definition: { name?: string } }>(agents: readonly T[]): T[] =>
  [...agents].sort((a, b) => byName({ name: a.definition.name || a.agent_id, id: a.agent_id }, { name: b.definition.name || b.agent_id, id: b.agent_id }));
