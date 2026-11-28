// The release is the code its gate ran on. The release pull request records the commit the release gate passed as a line of
// its own, `Gated cut: <40-hex sha>` (a re-gate adds a line; the last counts). The tag's tree must be that commit's tree. A
// gate run on main before the bump also passes when the tag adds only the release's own files: version files whose every
// changed line is moved by the release's own versions, changelogs that only gain lines, and changes/ fragments deleted. Any
// other difference stops the release, naming the files and the commits under the tag the gate never saw: the merge queue
// can put pull requests ahead of the release pull request (beta.68 carried 11). The cure is a gate on the tag's commit itself:
// its fragments, at the tag and unfolded, are the publish job's fold's to write into the release, so they are named, not refused.
//   node scripts/release-gated-cut.mjs --tag <tag> [--cut <sha>]
// Without --cut it reads the line from the pull request merged as the tag's commit (GITHUB_REPOSITORY, GH_TOKEN). It
// fetches the cut by its sha when the checkout lacks it: a squash-merged release pull request's head is not on main.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { posix } from 'node:path';
import { getJson } from './release-ci-gate.mjs';
import { isMain } from './is-main.mjs';

const LINE = /^Gated cut: ([0-9a-f]{40})\s*$/;

/** The sha on the last `Gated cut: <40-hex sha>` line of the release pull request's body. */
export function gatedCut(body) {
  const found = String(body ?? '').split(/\r?\n/).map(line => LINE.exec(line)?.[1]).filter(Boolean);
  if (!found.length) throw new Error('the release pull request has no "Gated cut: <40-hex sha>" line: add the sha the release gate passed on');
  return found.at(-1);
}

const VERSION_FILES = [/(^|\/)package(-lock)?\.json$/, /^render\.yaml$/, /^deploy\//, /^python\/pyproject\.toml$/, /^python\/agentrun\/__init__\.py$/];
const isVersionFile = path => VERSION_FILES.some(pattern => pattern.test(path));
const isChangelog = path => posix.basename(path) === 'CHANGELOG.md';
const isFragment = path => posix.dirname(path) === 'changes' && path.endsWith('.md') && path !== 'changes/README.md';

function versionOf(path, text) {
  if (text === undefined) return undefined;
  if (path.endsWith('package.json')) {
    try { return JSON.parse(text).version; } catch { return undefined; }
  }
  if (path === 'python/pyproject.toml') return /^version = "([^"]+)"$/m.exec(text)?.[1];
  return undefined;
}

/** The release's version moves, [old, new] once each: from every package.json and the Python client's pyproject whose version changed. */
export function versionMoves(changes) {
  const moves = new Map();
  for (const { path, before, after } of changes) {
    const [from, to] = [versionOf(path, before), versionOf(path, after)];
    if (typeof from === 'string' && typeof to === 'string' && from !== to && !moves.has(from)) moves.set(from, to);
  }
  return [...moves];
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function moved(line, moves) {
  if (!moves.length) return line;
  const olds = moves.map(([from]) => from).sort((a, b) => b.length - a.length);
  const to = new Map(moves);
  return line.replace(new RegExp(`(?<![0-9.])(${olds.map(escape).join('|')})(?![0-9A-Za-z])`, 'g'), from => to.get(from));
}

/** A changelog only gains lines: every line it had is still there, in the same order. */
export function changelogGains(before, after) {
  const had = before.split('\n');
  let at = 0;
  for (const line of after.split('\n')) if (at < had.length && line === had[at]) at += 1;
  return at === had.length;
}

/** Whether one changed file is the release's own, given its version moves. */
export function releaseOwn({ path, status, before, after, modes = [] }, moves) {
  if (isFragment(path)) return status === 'D';
  if (isChangelog(path)) return status === 'A' || (status === 'M' && changelogGains(before, after));
  if (!isVersionFile(path) || status !== 'M' || modes[0] !== modes[1]) return false;
  const [was, is] = [before.split('\n'), after.split('\n')];
  return was.length === is.length && was.every((line, i) => line === is[i] || moved(line, moves) === is[i]);
}

const short = sha => sha.slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The verdict, from the cut and tag shas and trees, the changes between the two trees, the changes/ fragments at the tag, and
 * the commits under the tag the cut lacks (`<short sha> <subject>`): `{ pass, say }`.
 */
export function verdict({ cut, tag, cutTree, tagTree, changes, fragments, commits }) {
  const trees = `the tag ${short(tag)} (tree ${short(tagTree)}) and the gated cut ${short(cut)} (tree ${short(cutTree)})`;
  const late = fragments.length
    ? `\n${plural(fragments.length, 'changes/ fragment')} at the tag, unfolded, which the publish job folds into the release: ${fragments.join(', ')}`
    : '';
  if (cutTree === tagTree) return { pass: true, say: `The release is the tree the gate ran on: ${trees} are the same.${late}` };
  const moves = versionMoves(changes);
  const extra = changes.filter(c => !releaseOwn(c, moves)).map(c => `${c.status} ${c.path}`);
  if (!extra.length) {
    return { pass: true, say: `The release is the tree the gate ran on: ${trees} differ only in the release's own files (${plural(changes.length, 'file')}).${late}` };
  }
  const listed = extra.slice(0, 25).map(line => `  ${line}`).join('\n');
  const named = commits.length
    ? `\n${plural(commits.length, 'commit')} the gate never saw:\n${commits.map(line => `  ${line}`).join('\n')}`
    : '';
  return {
    pass: false,
    say: `The release is not the code its gate ran on.\n${trees} differ beyond the release's own files, in ${plural(extra.length, 'file')}:\n${listed}${extra.length > 25 ? `\n  and ${extra.length - 25} more` : ''}${late}${named}\nGate the tag's commit itself, add its "Gated cut:" line to the release pull request, and dispatch again.`,
  };
}

function gitText(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The changes from one tree to another, with each file's text on both sides. */
function treeChanges(cut, tag) {
  const fields = gitText(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', cut, tag]).split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [modeA, modeB, blobA, blobB, status] = fields[i].replace(/^:/, '').split(' ');
    const path = fields[i + 1];
    const text = blob => (/^0+$/.test(blob) ? undefined : gitText(['cat-file', 'blob', blob]));
    changes.push({ path, status: status[0], modes: [modeA, modeB], before: text(blobA), after: text(blobB) });
  }
  return changes;
}

async function cutFromPullRequest(sha) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('Name the gated cut with --cut <sha>, or set GITHUB_REPOSITORY (and GH_TOKEN) to read it from the release pull request.');
    process.exit(2);
  }
  const pulls = await getJson(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, { token: process.env.GH_TOKEN });
  const merged = (Array.isArray(pulls) ? pulls : []).filter(pull => pull?.merge_commit_sha === sha && pull.merged_at);
  if (merged.length !== 1) throw new Error(`no one pull request was merged as ${sha}, so no release pull request names its gated cut`);
  console.log(`The release pull request: #${merged[0].number}.`);
  return gatedCut(merged[0].body);
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const tagName = flag('--tag');
  if (!tagName) {
    console.error('usage: node scripts/release-gated-cut.mjs --tag <tag> [--cut <sha>]');
    process.exit(2);
  }
  try {
    const tag = gitText(['rev-parse', `${tagName}^{commit}`]).trim();
    const cut = flag('--cut') ?? await cutFromPullRequest(tag);
    try {
      gitText(['cat-file', '-e', `${cut}^{commit}`]);
    } catch {
      gitText(['fetch', '--quiet', '--no-tags', 'origin', cut]);
    }
    const cutSha = gitText(['rev-parse', `${cut}^{commit}`]).trim();
    const tree = sha => gitText(['rev-parse', `${sha}^{tree}`]).trim();
    const fragments = gitText(['ls-tree', '--name-only', tag, 'changes/']).split('\n').filter(isFragment);
    const commits = gitText(['log', '--format=%h %s', '--abbrev=10', `${tag}^@`, '--not', cutSha]).split('\n').filter(Boolean);
    const said = verdict({ cut: cutSha, tag, cutTree: tree(cutSha), tagTree: tree(tag), changes: treeChanges(cutSha, tag), fragments, commits });
    (said.pass ? console.log : console.error)(said.say);
    if (process.env.GITHUB_STEP_SUMMARY && !said.pass) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${said.say}\n\`\`\`\n`);
    process.exit(said.pass ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
