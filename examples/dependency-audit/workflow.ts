// The audit as a workflow: every dependency of a package.json is a branch that reads the registry, the advisory database, an
// install in a box, and the repository (the browser on its pages, vision on its badges); a finding cites what was read; a typed
// question sorts the facts. The verdicts are flags on facts the receipts show, never a judgment of a package's quality.
import type { Workflow } from '@parcha/agentrun-dsl';

/** The least a claim needs to reach the report: the receipt it read. */
const Fact = {
  type: 'object', additionalProperties: false, required: ['claim', 'source', 'receipt'],
  properties: {
    claim: { type: 'string', minLength: 1, description: 'One fact, stated as the receipt shows it.' },
    source: { type: 'string', enum: ['registry', 'advisories', 'install', 'repository', 'badge'] },
    receipt: { type: 'string', minLength: 1, description: 'The receipt the claim was read from, exactly as the tool returned it.' },
  },
} as const;

const Cited = {
  type: 'object', additionalProperties: false, required: ['path', 'sha256', 'url'],
  properties: { path: { type: 'string' }, sha256: { type: 'string' }, url: { type: 'string' } },
} as const;

export const workflow = {
  v: 2,
  name: 'dependency-audit',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['project', 'dependencies'],
      properties: {
        project: { type: 'string', minLength: 1 },
        dependencies: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'version'], properties: { name: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 } } } },
      },
    },
    Registry: {
      type: 'object', required: ['receipt', 'name', 'version', 'repository', 'deprecated', 'scripts'],
      properties: {
        receipt: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' },
        repository: { type: 'string', description: 'The https URL of the source repository, or an empty string.' },
        deprecated: { type: 'string', description: 'The registry\'s deprecation message for this version, or an empty string.' },
        scripts: { type: 'object', description: 'The install-time scripts (preinstall, install, postinstall) the version declares.' },
      },
    },
    Advisories: {
      type: 'object', required: ['receipt', 'ids'],
      properties: { receipt: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, summaries: { type: 'object' } },
    },
    Install: {
      type: 'object', required: ['receipt', 'ran', 'hosts'],
      properties: {
        receipt: { type: 'string' }, ran: { type: 'boolean', description: 'Whether the install ran in a box. False says why in `note`.' }, note: { type: 'string' },
        scripts: { type: 'array', items: { type: 'string' } },
        hosts: { type: 'array', items: { type: 'string' }, description: 'Every host the install reached, from the box\'s network log.' },
        outside: { type: 'array', items: { type: 'string' }, description: 'The hosts that are not the package registry.' },
      },
    },
    Repository: {
      type: 'object', additionalProperties: false, required: ['pages', 'archived', 'badges'],
      properties: {
        pages: { type: 'array', items: Cited, description: 'The repository pages read, each a receipt of the browser.' },
        archived: { type: 'string', enum: ['yes', 'no', 'unknown'], description: 'Whether the repository page says it is archived. unknown when no page was read.' },
        archived_on: { type: 'string' },
        last_release: { type: 'string', description: 'The newest release\'s date as the releases page shows it, or an empty string.' },
        badges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'receipt'], properties: { label: { type: 'string' }, value: { type: 'string' }, receipt: { type: 'string' } } } },
        walled: { type: 'boolean', description: 'A page that stopped the browser is reported here and cites nothing.' },
      },
    },
    Finding: {
      type: 'object', additionalProperties: false, required: ['name', 'version', 'facts'],
      properties: { name: { type: 'string' }, version: { type: 'string' }, facts: { type: 'array', items: Fact } },
    },
    Verdict: {
      type: 'object', additionalProperties: false, required: ['flag'],
      properties: {
        flag: {
          type: 'string', enum: ['clear', 'notice', 'act'], description: 'Which flag do the cited facts raise?',
          criteria: {
            clear: 'None of the facts is a live advisory, an install-time download from outside the registry, an archived repository or a deprecation.',
            notice: 'A fact shows a deprecation or an archived repository, and no live advisory or outside download. An install that was not run, or a repository that was not read, is not a flag.',
            act: 'A fact shows a live advisory on the pinned version, or an install that reached a host that is not the package registry.',
          },
        },
      },
    },
    Row: {
      type: 'object', additionalProperties: false, required: ['name', 'version', 'flag', 'confidence', 'facts', 'dropped'],
      properties: {
        name: { type: 'string' }, version: { type: 'string' }, flag: { type: 'string' }, confidence: { type: 'number' },
        facts: { type: 'array', items: Fact }, dropped: { type: 'integer', description: 'Claims the finding made that cite no receipt this branch holds. They are not in the report.' },
      },
    },
    Result: {
      type: 'object', additionalProperties: false, required: ['project', 'rows', 'report_markdown'],
      properties: { project: { type: 'string' }, rows: { type: 'array', items: { $ref: '#/definitions/Row' } }, report_markdown: { type: 'string' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    {
      node: 'map', label: 'dependencies', itemsPath: 'dependencies', as: 'audit', resultPath: 'row', maxConcurrency: 6,
      body: { node: 'chain', steps: [
        { node: 'call', label: 'registry', via: 'tool', tool: 'registry', args: { name: '{item.name}', version: '{item.version}' }, out: 'Registry', as: 'registry', deadline_s: 30, retry: { attempts: 2, on: ['timeout', 'http_5xx', 'connection'] } },
        { node: 'call', label: 'advisories', via: 'tool', tool: 'advisories', args: { name: '{item.name}', version: '{item.version}' }, out: 'Advisories', as: 'advisories', deadline_s: 30, retry: { attempts: 2, on: ['timeout', 'http_5xx', 'connection'] } },
        { node: 'call', label: 'install in a box', via: 'tool', tool: 'install', args: { name: '{item.name}', version: '{item.version}', scripts: '{registry.scripts}' }, out: 'Install', as: 'install', deadline_s: 240 },
        {
          node: 'agent', label: 'repository', state: { name: '{item.name}', repository: '{registry.repository}' }, out: 'Repository', as: 'repository',
          instructions: 'Read the dependency\'s public repository. If `repository` is empty, answer archived "unknown" with no pages. Otherwise: run page.goto on the repository page, browser_read it with what "text", and say whether the page says the repository was archived (archived "yes" with archived_on, "no" when the page shows it open); then run page.goto on its /releases page, browser_read it with what "text", and give the newest release\'s date as shown. List each page you read in `pages` with the path, sha256 and url the browser_read result gave in its details. If the repository page shows README badges, call badge_image for up to three of them and read each saved image with the read tool (ask for its label and its value, exactly as shown); list what it said in `badges` with the look\'s receipt path. A page that stopped the browser is reported with walled true and cites nothing from it. Never guess: a page you did not read is unknown.',
          tools: ['run', 'browser_read', 'snapshot', 'badge_image', 'read'],
        },
        {
          node: 'extract', label: 'finding', state: { name: '{item.name}', version: '{item.version}', registry: '{registry}', advisories: '{advisories}', install: '{install}', repository: '{repository}' }, out: 'Finding', as: 'finding', tools: [],
          instructions: 'List the facts the receipts show about this dependency, each as one claim with its source and the receipt it was read from: the deprecation message if any, each advisory id, each install script and each host outside the package registry the install reached, whether the repository is archived and its last release date, and each badge. Cite a receipt exactly as it appears in the input. Write nothing a receipt does not show, and no opinion of the package.',
        },
        { node: 'judge', label: 'verdict', state: { name: '{item.name}', version: '{item.version}', facts: '{finding.facts}' }, out: 'Verdict', as: 'verdict' },
        {
          node: 'code', label: 'row',
          code: '(s) => { const held = new Set([s.registry.receipt, s.advisories.receipt, s.install.receipt, ...s.repository.pages.map((p) => p.path), ...s.repository.badges.map((b) => b.receipt)]); const facts = s.finding.facts.filter((f) => held.has(f.receipt)); const conf = s.verdict$answers && s.verdict$answers.answers && s.verdict$answers.answers.flag && s.verdict$answers.answers.flag.confidence; return { row: { name: s.item.name, version: s.item.version, flag: s.verdict.flag, confidence: typeof conf === "number" ? conf : 0, facts, dropped: s.finding.facts.length - facts.length } }; }',
        },
      ] },
    },
    {
      node: 'code', label: 'rank',
      code: '(s) => { const order = { act: 0, notice: 1, clear: 2 }; return { ranked: s.audit.slice().sort((a, b) => order[a.flag] - order[b.flag] || b.facts.length - a.facts.length || (a.name < b.name ? -1 : 1)) }; }',
    },
    {
      node: 'code', label: 'report',
      code: '(s) => { const mark = { act: "ACT", notice: "NOTICE", clear: "CLEAR" }; const lines = ["# Dependency audit: " + s.project, "", "Each line is a fact a receipt shows. A flag is a count of facts, not a judgment of a package.", "", "| Dependency | Flag | Facts |", "|---|---|---|"]; for (const r of s.ranked) lines.push("| " + r.name + "@" + r.version + " | " + mark[r.flag] + " | " + r.facts.length + " |"); for (const r of s.ranked) { if (r.flag === "clear") continue; lines.push("", "## " + r.name + "@" + r.version + " (" + mark[r.flag] + ")"); for (const f of r.facts) lines.push("- " + f.claim + " [" + f.source + ": " + f.receipt + "]"); } return { result: { project: s.project, rows: s.ranked, report_markdown: lines.join("\\n") } }; }',
    },
  ] },
} as const satisfies Workflow;
