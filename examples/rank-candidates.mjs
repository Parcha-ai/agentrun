// Rank a list with Jev: score every candidate against a brief, drop the weak ones, drop near-duplicates,
// keep at most a few per bucket, and return the top k with a reason for every candidate that was cut.
//
// It is a reusable workflow: run it directly, or call it from another workflow with a `workflow` node.
// Jev only answers typed questions (how well does this fit; are these two the same). Sorting, quotas
// and the cut-off are exact work, so they are code. A long list needs nothing special: a `sift` splits
// itself into requests that fit the host's limits.
export const rankCandidates = {
  v: 2,
  name: 'Rank candidates',
  schemas: contracts(),
  input: { schemaId: 'Request' },
  output: { schemaId: 'Ranking', path: 'ranking' },
  root: {
    node: 'chain',
    steps: [
      {
        // One score per candidate. `fit.answers[i].answers.fit.score` is the expected level, a number
        // between 0 and 3 that orders candidates more finely than the rounded level in `fit.values`.
        node: 'sift', label: 'score-fit', itemsPath: 'candidates',
        state: { brief: '{brief}' }, out: 'Fit', as: 'fit',
      },
      {
        node: 'code', label: 'shortlist',
        // Keep candidates at or above the minimum score, best first (earlier wins a tie), and pair up
        // the best 2 × top of them for the duplicate check.
        code: `s => {
          const scored = s.candidates.map((candidate, index) => ({ candidate, index, score: s.fit.answers[index].answers.fit.score }));
          const cut = scored.filter(c => c.score < s.minScore).map(c => ({ id: c.candidate.id, reason: 'below the minimum score' }));
          const pool = scored.filter(c => c.score >= s.minScore).sort((a, b) => b.score - a.score || a.index - b.index);
          const considered = pool.slice(0, s.top * 2);
          const pairs = [];
          for (let i = 0; i < considered.length; i++) for (let j = i + 1; j < considered.length; j++) {
            pairs.push({ keep: considered[i].candidate, other: considered[j].candidate });
          }
          return { pool, pairs, cut };
        }`,
      },
      {
        // Each pair is one item, so 2 × top candidates make top × (2 × top − 1) questions.
        node: 'sift', label: 'find-duplicates', itemsPath: 'pairs',
        out: 'Same', as: 'duplicates', keep: { path: 'same', gte: 0.8 },
      },
      {
        node: 'code', label: 'rank',
        // Walk the pool best first. A candidate is cut when a better one that stays covers the same
        // ground, when its bucket is full, or when the list is full.
        code: `s => {
          const cut = [...s.cut];
          const ranked = [];
          const perBucket = {};
          for (const { candidate, score } of s.pool) {
            const twin = s.duplicates.items.find(pair => pair.other.id === candidate.id && ranked.some(r => r.id === pair.keep.id));
            const taken = perBucket[candidate.bucket] ?? 0;
            if (twin) cut.push({ id: candidate.id, reason: 'duplicate of ' + twin.keep.id });
            else if (ranked.length >= s.top) cut.push({ id: candidate.id, reason: 'beyond the top ' + s.top });
            else if (taken >= s.perBucket) cut.push({ id: candidate.id, reason: 'bucket ' + candidate.bucket + ' is full' });
            else {
              perBucket[candidate.bucket] = taken + 1;
              ranked.push({ id: candidate.id, title: candidate.title, bucket: candidate.bucket, score });
            }
          }
          return { ranking: { ranked, cut } };
        }`,
      },
    ],
  },
};

function contracts() {
  const text = { type: 'string', minLength: 1 };
  const candidate = {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'bucket', 'summary'],
    properties: { id: text, title: text, bucket: text, summary: text },
  };
  return {
    Request: {
      type: 'object', additionalProperties: false,
      required: ['brief', 'candidates', 'top', 'perBucket', 'minScore'],
      properties: {
        brief: text,
        candidates: { type: 'array', items: candidate },
        top: { type: 'integer', minimum: 1 },
        perBucket: { type: 'integer', minimum: 1 },
        minScore: { type: 'number', minimum: 0, maximum: 3 },
      },
    },
    Fit: {
      type: 'object', additionalProperties: false, required: ['fit'],
      properties: {
        fit: {
          type: 'integer',
          description: 'How well does this candidate serve the brief?',
          criteria: [
            'Unrelated to the brief.',
            'Touches the brief but would not serve it.',
            'Serves part of the brief.',
            'Serves the brief directly.',
          ],
        },
      },
    },
    Same: {
      type: 'object', additionalProperties: false, required: ['same'],
      properties: {
        same: { type: 'boolean', description: 'Would `keep` and `other` give the audience the same thing, so that only one is needed?' },
      },
    },
    Ranking: {
      type: 'object', additionalProperties: false, required: ['ranked', 'cut'],
      properties: {
        ranked: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'title', 'bucket', 'score'],
            properties: { id: text, title: text, bucket: text, score: { type: 'number' } },
          },
        },
        cut: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: text, reason: text } },
        },
      },
    },
  };
}
