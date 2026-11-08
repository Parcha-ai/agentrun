// The agentrun-cli skill, generated with the CLI's command table (generate-clients.mjs): SKILL.md from the template
// below with its slots filled from the table (the command groups, and recipe 5, which names a command only once the
// table has it), and references/commands.md, one entry per command. recipeProblems() is what --check holds the recipes
// to: every `agentrun` command and flag they name is one the CLI has, so the skill cannot teach a command that is gone.
// Each recipe's shell blocks run in order in one directory (packages/agentrun/test/skill.test.mjs), each ending with a
// `# exit N` line that says how its last command exits.

const GLOBAL = ['base-url', 'data', 'help'];
const flagOf = (name) => name.replace(/_/g, '-').toLowerCase();

/** Every command of the CLI: the table's, with the flags follow.mjs adds to some, and the hand-written ones. */
export function allCommands(table, { flags, wait, local }) {
  const generated = table.map((entry) => ({
    ...entry,
    flags: [
      ...[...entry.query, ...entry.headers, ...entry.bodyFlags].map((f) => ({ name: `--${flagOf(f.name)}`, value: f.type === 'boolean' ? '' : f.enum ? f.enum.join('|') : f.type.toUpperCase(), type: f.enum ? 'string, one of these' : f.type, required: f.required, description: f.description })),
      ...(entry.hasBody ? [
        { name: '--body', value: 'JSON|@FILE|-', type: entry.bodyTypes.join(', '), required: entry.bodyRequired, description: entry.secretBody ? 'The body, from stdin (-) or a file only: it holds a secret.' : 'The whole body: inline, from a file or from stdin. The flags above win over a JSON body\'s fields.' },
        { name: '--body-type', value: 'TYPE', type: 'string', required: false, description: `The body's type, one of ${entry.bodyTypes.join(', ')}; any other than JSON is sent as given.` },
      ] : []),
      ...(flags[entry.operationId]?.help ?? []).map(([name, text]) => handFlag(name, text)),
    ],
    route: `${entry.method} ${entry.path}`,
  }));
  const hand = [wait, ...local].map((entry) => ({ ...entry, flags: entry.help.filter(([name]) => name.startsWith('--')).map(([name, text]) => handFlag(name, text)) }));
  return [...generated, ...hand].sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

const handFlag = (spec, description) => {
  const [name, value = ''] = spec.split(' ');
  return { name, value, type: !value ? 'boolean' : value === 'SECONDS' ? 'number' : 'string', required: false, description, own: true };
};

const usage = (entry) => `agentrun ${entry.command.join(' ')}${entry.pathParams.map((name) => ` ${name.toUpperCase()}`).join('')}`;
const find = (commands, operationId) => commands.find((entry) => entry.operationId === operationId);

/** Recipe 5's slot: the commands that raise a run's cap and answer a tool call's approval, once the table has them. */
function capRecipe(commands) {
  const raise = find(commands, 'raiseRunCap');
  const approve = find(commands, 'answerApproval');
  const intro = 'A run stopped at its spend cap, or waiting for a tool call to be approved, exits 8 with `pending.kind` `budget` or `approval` in out.json.';
  if (!raise && !approve) {
    return [`${intro} This version of the CLI has no command for either yet; look for one among the run commands, and if there is none, the person raises the cap or approves the call in the console (the run's \`console_url\`):`, '',
      '```sh', 'agentrun runs --help', '# exit 0: the run commands, one per line', '```'];
  }
  const lines = [intro, ''];
  if (raise) {
    const field = (usd) => (raise.flags.find((f) => f.name === '--max-cost-usd') ? `--max-cost-usd ${usd}` : `--body '{"max_cost_usd": ${usd}}'`);
    // --cap-mode strict when the start takes it: then no request goes past the cap, which the text says, with what the
    // default allows.
    const start = find(commands, 'createRun');
    const strict = start?.flags.some((f) => f.name === '--cap-mode') ?? false;
    lines.push(strict
      ? 'A cap too small for the task stops the run before a request it cannot pay for. With `--cap-mode strict` no request is sent that the cap cannot cover; under the default, `expected`, a request that misses the cache can go over by at most the run\'s `cost.overshoot_bound_usd`:'
      : 'A cap too small for the task stops the run before a request it cannot pay for:', '',
      '```sh',
      `agentrun runs start notes --max-cost-usd 0.05${strict ? ' --cap-mode strict' : ''} --body '{"input": {"content": "Write moon.md with everything known about the Moon."}}' --wait > out.json`,
      '# exit 8 once it stops at its cap: out.json has pending.kind budget, with cap_usd, spent_usd and suggested_cap_usd; 0 if the cap was enough',
      '```', '',
      'Only the person who set the cap raises it: ask them for the new cap (`pending.suggested_cap_usd` is one that lets it go on). Then the run goes on from where it stopped:', '',
      '```sh', `run=$(node -p 'require("./out.json").run_id')`, `${usage(raise).replace('RUN_ID', '"$run"')} ${field(1)}`, 'agentrun runs wait "$run" > out.json', '# exit 0 completed, as in recipe 2', '```', '');
  }
  // answerApproval is left out of the table (resources.json's omit): the server takes that answer from no token.
  if (!approve) lines.push('A tool call waiting for approval (`pending.kind` `approval`) is answered by the person in the console (the run\'s `console_url`): the server takes that answer only from their own session there, never from a token, so the CLI has no command for it. Tell them, then `agentrun runs wait "$run"` once they have.');
  if (approve) lines.push(`A tool call waiting for approval (\`pending.id\` names it) is answered by the person: \`${usage(approve)}${approve.flags.find((f) => f.name === '--decision') ? ' --decision allow' : ''}\` (${approve.summary.toLowerCase()}). The server may take that answer only from the person's own session; a \`403\` means they answer it in the console.`);
  return lines;
}

const RECIPES = (commands) => [
  '## Recipes',
  '',
  'Run them in order, in one working directory: each writes `out.json`, the run as its command printed it, and the next reads it. The last line of each block says how its last command exits.',
  '',
  '### 1. Make an agent from a definition file',
  '',
  '```sh',
  "cat > agent.json <<'EOF'",
  '{"definition": {"id": "notes", "version": 1, "name": "Notes", "instructions": "Do what you are asked, and write what you make to a file.", "skills": [], "tools": ["write", "ask_person"]}}',
  'EOF',
  'agentrun agents create --body @agent.json',
  '# exit 0: the agent; exit 1 with error.code agent_exists: agentrun agents update notes --body @agent.json makes its next revision',
  '```',
  '',
  'Ask the person before you create or change an agent. `agentrun server capabilities` lists the harnesses, models and tools this server has.',
  '',
  '### 2. Start a run with a spend cap and wait for it',
  '',
  '```sh',
  `agentrun runs start notes --max-cost-usd 5 --body '{"input": {"content": "Write notes.md with three facts about the Moon."}}' --wait > out.json`,
  '# exit 0 completed (result.final_answer); 1 failed or cancelled (error says why); 8 it waits on a person (recipe 3)',
  '```',
  '',
  '`--wait` follows the run until it ends or needs a person, and `--timeout SECONDS` stops waiting (exit 1, the run goes on). `agentrun runs wait RUN_ID` waits again; `agentrun runs timeline RUN_ID --follow` prints each step as it comes.',
  '',
  '### 3. Answer a run that asks',
  '',
  '```sh',
  `agentrun runs start notes --max-cost-usd 5 --body '{"input": {"content": "Ask me which region to cover, then write region.md about it."}}' --wait > out.json`,
  '# exit 8: it waits on a person; out.json has pending.kind question and pending.question, what it asks',
  '```',
  '',
  'Answer only what the person told you, or ask them. Then:',
  '',
  '```sh',
  `run=$(node -p 'require("./out.json").run_id')`,
  'agentrun runs message "$run" --content "Europe"',
  'agentrun runs wait "$run" > out.json',
  '# exit 0 completed, as in recipe 2',
  '```',
  '',
  '### 4. Read what it wrote and what it cost',
  '',
  '```sh',
  `run=$(node -p 'require("./out.json").run_id')`,
  'agentrun runs files "$run"',
  'agentrun runs read-file "$run" region.md',
  `agentrun runs get "$run" > out.json && node -p 'JSON.stringify(require("./out.json").cost)'`,
  '# exit 0: files lists each path, read-file prints one file, cost.usd is what it spent and cap_usd its cap',
  '```',
  '',
  '`cost.usd` is null while the cost is unknown: never report it as $0. Tell the person the outcome and give them the run\'s `console_url`.',
  '',
  '### 5. Raise a cap or approve a call',
  '',
  ...capRecipe(commands),
];

/** SKILL.md: the template, its slots filled from the commands. */
export function skillText(commands, hash) {
  const groups = new Map();
  for (const entry of commands) groups.set(entry.command[0], [...(groups.get(entry.command[0]) ?? []), entry]);
  return [
    '---',
    'name: agentrun-cli',
    'description: Drive an AgentRun server from a shell with the agentrun CLI. Make an agent from a definition file, start a run with a spend cap and wait for it, answer a run that asks a question, read the files it wrote and what it cost, save tool keys, and call any other route of the server. Use when asked to run or manage AgentRun agents from the terminal or a script, or for anything the server\'s MCP tools do not cover (files, tool keys, triggers, webhooks, revisions, learning).',
    '---',
    '<!-- Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document and its skill template. Do not edit: run node scripts/generate-clients.mjs. -->',
    `<!-- SHA-256 of what the command table is made of (operationsOf in scripts/generate-clients.mjs): ${hash} -->`,
    '',
    '# AgentRun CLI',
    '',
    '`agentrun` drives an AgentRun server (the open platform\'s server for agents) through its API. It is the command `npm install -g @parcha/agentrun` puts on the PATH; without it, write `npx @parcha/agentrun` in its place. Each command prints the server\'s JSON answer on stdout, one line when piped, and an error\'s JSON on stderr. `agentrun help` lists the commands, `agentrun GROUP COMMAND --help` gives one\'s flags, and [references/commands.md](references/commands.md) has every command with its flags and route.',
    '',
    '## The server and the token',
    '',
    'The first of these that is set wins:',
    '',
    '1. `--base-url URL` (the API, ending `/v2`), else `AGENTRUN_BASE_URL`, with the token in `AGENTRUN_API_KEY`.',
    '2. The config file `$XDG_CONFIG_HOME/agentrun/config.json` (else `~/.config/agentrun/config.json`), written by `agentrun login`, which checks the token first. The CLI refuses the file if anyone else can read it.',
    '3. The server started on this machine with `npx @parcha/agentrun`, whose data directory (`~/.agentrun`, or `--data DIR`) says where it listens and holds its token: nothing to set.',
    '',
    'The token goes on stdin, never on the command line:',
    '',
    '```sh',
    'agentrun login --base-url "$AGENTRUN_BASE_URL" < token.txt',
    '```',
    '',
    'Never print, echo or log the token, and never pass it as an argument; the CLI never prints it. `agentrun logout` removes the config file. A tool key\'s value is read the same way, from stdin or a variable you name: `agentrun tool-keys set KEY_ID FIELD --from-env VAR` (`agentrun tool-keys list` names the keys and fields, never a value).',
    '',
    ...RECIPES(commands),
    '',
    '## Exit codes',
    '',
    '- 0: done; for `runs wait` and `runs start --wait`, the run completed.',
    '- 1: the server refused (its error JSON on stderr); for a wait, the run failed or was cancelled, or `--timeout` passed.',
    '- 2: bad usage, nothing sent: a bad flag or argument, or a base URL that is not http or https or has a query, a fragment, a user or a password.',
    '- 3: the server cannot be reached.',
    '- 4: no token, the token was refused, or the config file, the local server\'s record or its token file was refused (open to others, or not what it should hold).',
    '- 8: the run waits on a person: a question, its spend cap, a stopped turn, or a paused workflow. stderr says what to run next.',
    '',
    '## From a program',
    '',
    'Two clients call the same API from code, with the same server and token. Neither is published yet: each installs from this repository. `@parcha/agentrun-client` (packages/client) is the TypeScript one, `new AgentRun({ baseUrl, apiKey })`. `parcha-agentrun` (python/) is the Python one, `AgentRun(base_url=..., api_key=...)` from the `agentrun` module; `pip install "git+https://github.com/Parcha-ai/agentrun#subdirectory=python"` installs it. Both default to `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY` and read no config file. Each command here is a method, grouped the same way: `agentrun runs start` is `client.runs.start`, and `client.runs.wait` and `client.runs.follow` do what `--wait` and `--follow` do.',
    '',
    '## Commands',
    '',
    ...[...groups].map(([noun, entries]) => entries.length === 1 && entries[0].command.length === 1
      ? `- \`${usage(entries[0])}\`: ${entries[0].summary}`
      : `- \`agentrun ${noun}\`: ${entries.map((entry) => entry.command[1]).join(', ')}`),
    '- `agentrun api METHOD PATH [--body JSON|@FILE|-]`: any route, PATH under the base URL',
    '',
  ].join('\n');
}

const cell = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

/** references/commands.md: one entry per command, its usage, summary, flags and route. */
export function referenceText(commands, hash) {
  const lines = [
    '# agentrun commands',
    '',
    '<!-- Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs. -->',
    `<!-- SHA-256 of what the command table is made of (operationsOf in scripts/generate-clients.mjs): ${hash} -->`,
    '',
    'Every command of the agentrun CLI, by group. Arguments in capitals are positional; every command also takes `--base-url URL`, `--data DIR` and `--help`. A body field with one value (a string, number or boolean) is a flag of its own, and `--body` gives the whole body. A positional argument is refused when it is or holds a `.` or `..` path segment; a file\'s PATH keeps its slashes, and no segment of it may be empty.',
  ];
  let group;
  for (const entry of commands) {
    if (entry.command[0] !== group) lines.push('', `## ${(group = entry.command[0])}`);
    lines.push('', `### \`${usage(entry)}\``, '', `${cell(entry.summary)}.`.replace(/\.\.$/, '.'), '', `Route: ${entry.route ? `\`${entry.route}\`` : 'none, it runs on this machine'}.${entry.raw ? ' It prints the answer\'s bytes as they are.' : ''}${entry.multiSegment?.length ? ` ${entry.multiSegment.map((name) => name.toUpperCase()).join(', ')} keeps its slashes.` : ''}`);
    if (entry.flags.length) {
      lines.push('');
      for (const f of entry.flags) lines.push(`- \`${f.name}${f.value ? ` ${f.value}` : ''}\` (${f.type}${f.required ? ', required' : ''}${f.own ? ', this CLI\'s own' : ''})${cell(f.description) ? `: ${cell(f.description)}` : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

const BUILT_IN = [{ command: ['help'], flags: [] }, { command: ['api'], flags: [{ name: '--body' }] }];

/** The commands and flags SKILL.md names, in its shell blocks and its inline code, that the CLI does not have. The
 *  Commands section is left out: it is the table's own list. */
export function recipeProblems(commands, text) {
  const known = [...commands, ...BUILT_IN];
  const named = text.replace(/\n## Commands\n[\s\S]*?(?=\n## |$)/, '');
  const snippets = [...named.matchAll(/^```sh\n([\s\S]*?)^```$/gm), ...named.matchAll(/`(agentrun [^`]+)`/g)].map((match) => match[1]);
  const problems = new Set();
  for (const snippet of snippets) {
    for (const call of snippet.matchAll(/(?:^|[\s;|&(])agentrun((?: +[^\s|;&)#]+)*)/gm)) {
      const tokens = call[1].trim().split(/ +/).filter(Boolean);
      const words = [];
      for (const token of tokens) if (/^[a-z][a-z-]*$/.test(token) && words.length < 2) words.push(token); else break;
      if (!words.length) continue;
      const name = `agentrun ${words.join(' ')}`;
      const group = known.filter((entry) => entry.command[0] === words[0]);
      const entry = group.find((e) => e.command.length === 1 || e.command[1] === words[1]);
      if (!group.length || (!entry && words.length > 1)) {
        problems.add(`the skill names ${name}, a command the CLI does not have`);
        continue;
      }
      const flags = new Set([...GLOBAL.map((flag) => `--${flag}`), ...(entry?.flags ?? []).map((f) => f.name)]);
      for (const token of tokens) {
        const flag = token.split('=')[0];
        if (flag.startsWith('--') && !flags.has(flag)) problems.add(`the skill gives ${name} ${flag}, a flag it does not have`);
      }
    }
  }
  return [...problems];
}
