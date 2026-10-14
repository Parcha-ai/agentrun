// The reference job's record against examples/reference/expected.json. Everything is compared exactly (key order aside) except the
// token counts under `usage`: the faux model counts a quarter of the characters it is sent, so any text a pi release changes in a tool
// description moves them. A count the fixed record has as positive must be a positive integer; one it has as zero must stay zero; the
// cost must still equal the expected one.
const stable = value => (Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value));

export function withoutTokens(record) {
  const usage = Object.fromEntries(Object.entries(record.usage ?? {}).map(([name, { tokens: _tokens, ...rest }]) => [name, rest]));
  return { ...record, usage };
}

/** Problems with `actual` against `expected`: a differing field (compared with the token counts left out, and key order ignored), a count the
 *  fixed record has as zero that is not zero, or one it has as positive that is not a positive integer. */
export function recordProblems(actual, expected) {
  const problems = [];
  if (stable(withoutTokens(actual)) !== stable(withoutTokens(expected))) problems.push('the record differs from expected.json apart from its token counts');
  for (const [name, { tokens }] of Object.entries(expected.usage ?? {})) {
    const got = actual.usage?.[name]?.tokens;
    if (tokens === 0 ? got !== 0 : !Number.isInteger(got) || got <= 0) problems.push(`usage.${name}.tokens is ${JSON.stringify(got)}, expected ${tokens === 0 ? '0' : 'a positive integer'}`);
  }
  return problems;
}
