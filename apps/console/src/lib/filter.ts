/** Whether `query` keeps a row: each of its words, case aside, is in one of `texts` ("issue comment" keeps
 *  GITHUB_CREATE_AN_ISSUE_COMMENT). An empty query keeps every row. */
export function matchesFilter(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const said = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => said.includes(word));
}
