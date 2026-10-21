// The facts pass: one cheap read of each company's latest annual report, kept once and frozen, so every code arm that
// replays on it and the judge of a defensible code read the same facts and differ only in the choice. Its answer has
// no place for a code, and its rules ask for none.

export const FACTS_RULES = `# Rules

## The job

- The input is a company's name, and its ticker and website when they are known. Find the company's latest annual
  report (a 10-K, or a 20-F or 40-F for a foreign filer), read it, and record six facts from it:
  - the report: its URL, its form, the fiscal year it covers and the end of that year;
  - the cover: the registrant's name and its principal executive offices as the cover states them (the city, the state
    or province when there is one, and the country);
  - the opening of Item 1 Business (a 20-F's Item 4, a 40-F's description of the business in its annual information
    form): its first paragraph, at most 800 characters, word for word;
  - every reportable segment with its revenue and its share of total revenue, and the total; or that the company
    reports one segment;
  - the largest revenue line: the segment with the most revenue, or, when the reportable segments are regions, the
    product or service line with the most revenue in the revenue disaggregation note, and which of the two it is;
  - the revenue by product or service line when the report gives it, at most 12 lines, or that it gives none.
- Each fact names the page or document it comes from as you read it in this run, where on it (a section, or "pdf p.
  N"), and a quote of at most 300 characters that shows it. Look at the cover and the segment table's page with
  read_document \`{ pages: [N], question }\`: a table read only as text loses its layout.
- Record no industry code or classification of any kind. sec.gov and EDGAR are refused by every tool, and so are their
  mirrors and the sites that list industry codes.
- Finish by calling answer once.
`;

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
const where = {
  url: { ...text(600), description: 'The page or document, as read in this run.' },
  locator: { ...text(200), description: 'Where on it: a section, or "pdf p. N".' },
  quote: { ...text(300), description: 'The words that show it.' },
};
const cited = (properties, required) => ({
  type: 'object', additionalProperties: false, required: [...required, 'url', 'locator', 'quote'], properties: { ...properties, ...where },
});
const line = { type: 'object', additionalProperties: false, required: ['name', 'revenue', 'share'], properties: { name: text(200), revenue: { type: 'number' }, share: { type: 'number', minimum: 0, maximum: 1 } } };

/** The facts pass's answer tool: six facts, each with where it was read. `recorded` is the report's URL. */
export function answerFacts() {
  return {
    description: 'Give the six facts, once: the latest annual report, its cover, the opening of Item 1, the reportable segments, the largest revenue line, and the revenue by product or service line, each with the page it comes from and a quote.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['report', 'cover', 'item1', 'segments', 'largestLine', 'revenueLines'],
      properties: {
        report: cited({ form: { type: 'string', enum: ['10-K', '10-KT', '20-F', '40-F'] }, fiscalYear: { type: 'integer', minimum: 1990, maximum: 2100 }, periodEnd: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, ['form', 'fiscalYear', 'periodEnd']),
        cover: cited({ name: text(200), city: text(100), state: text(100), country: text(100) }, ['name', 'city', 'country']),
        item1: { type: 'object', additionalProperties: false, required: ['text', 'url', 'locator'], properties: { text: { ...text(800), description: 'Its first paragraph, word for word.' }, url: where.url, locator: where.locator } },
        segments: {
          anyOf: [
            cited({ list: { type: 'array', minItems: 1, maxItems: 30, items: line }, total: { type: 'number' } }, ['list', 'total']),
            cited({ oneSegment: { const: true } }, ['oneSegment']),
          ],
        },
        largestLine: cited({ ...line.properties, basis: { type: 'string', enum: ['segment', 'disaggregation'] } }, ['name', 'revenue', 'share', 'basis']),
        revenueLines: {
          anyOf: [
            cited({ list: { type: 'array', minItems: 1, maxItems: 12, items: line } }, ['list']),
            { type: 'object', additionalProperties: false, required: ['none'], properties: { none: { const: true } } },
          ],
        },
      },
    },
    recorded: (args) => args.report.url,
  };
}
