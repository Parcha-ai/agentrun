// The reference job's record against examples/reference/expected.json. Everything is compared exactly except the token
// counts under `usage`: the faux model counts a quarter of the characters it is sent, so any text a pi release changes in
// a tool description moves them. Each must be a positive integer; the cost must still equal the expected one.
export function withoutTokens(record) {
  const usage = Object.fromEntries(Object.entries(record.usage ?? {}).map(([name, { tokens: _tokens, ...rest }]) => [name, rest]));
  return { ...record, usage };
}

/** Problems with `actual` against `expected`: a differing field (compared with the token counts left out), or a token count that is not a non-negative integer, or not positive where the expected one is. */
export function recordProblems(actual, expected) {
  const problems = [];
  if (JSON.stringify(withoutTokens(actual)) !== JSON.stringify(withoutTokens(expected))) problems.push('the record differs from expected.json apart from its token counts');
  for (const [name, { tokens }] of Object.entries(expected.usage ?? {})) {
    const got = actual.usage?.[name]?.tokens;
    if (!Number.isInteger(got) || got < 0 || (tokens > 0 && got <= 0)) problems.push(`usage.${name}.tokens is ${JSON.stringify(got)}, expected ${tokens > 0 ? 'a positive' : 'a non-negative'} integer`);
  }
  return problems;
}
