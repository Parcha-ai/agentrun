import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';

// These helpers never serialize provider errors, credentials, or configuration.
export class ResearchExampleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const allowedErrorNames = new Set(['Error', 'SyntaxError', 'TypeError', 'ReferenceError', 'RangeError', 'JevError', 'PiRunError']);
const allowedErrorCodes = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNKNOWN_FILE_EXTENSION',
  'configuration', 'invalid_request', 'invalid_response', 'http', 'connection', 'timeout', 'aborted', 'turn_limit', 'submission_limit', 'no_submission']);
export function safeErrorKind(error) {
  const name = allowedErrorNames.has(error?.name) ? error.name : 'unclassified_error';
  const code = allowedErrorCodes.has(error?.code) ? `/${error.code}` : '';
  return `${name}${code}`;
}

export function withCancellation(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolvePromise, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolvePromise(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function saveReport(path, report, signal) {
  const destination = resolve(path);
  const temporary = join(dirname(destination), `.${basename(destination)}.partial-${randomUUID()}`);
  let handle;
  let created = false;
  try {
    signal?.throwIfAborted();
    const bytes = JSON.stringify(report, null, 2) + '\n';
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(bytes, { signal });
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    // The hard link publishes only the fully written, closed file and refuses
    // an existing destination. rename() could silently replace older evidence.
    await link(temporary, destination);
  }
  catch (error) {
    signal?.throwIfAborted();
    throw new ResearchExampleError('output', error?.code === 'EEXIST'
      ? 'The report file already exists. Choose a new --out path; existing evidence was not replaced.'
      : 'Could not save the report. Check the destination directory and permissions.');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
  }
}

export function parseOptions(args) {
  const options = { live: false, summary: false, deadlineSeconds: 600 };
  let deadlineSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live' && !options.live) options.live = true;
    else if (arg === '--summary' && !options.summary) options.summary = true;
    else if (arg === '--deadline' && !deadlineSeen) {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value ?? '') || Number(value) > 3600) throw new ResearchExampleError('usage', '--deadline must be an integer from 1 to 3600 seconds.');
      options.deadlineSeconds = Number(value);
      deadlineSeen = true;
    }
    else if ((arg === '--config' || arg === '--out' || arg === '--cases') && !options[arg.slice(2)] && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new ResearchExampleError('usage', 'Use [--live [--config trusted-adapters.mjs] [--cases cases.json]] [--summary] [--deadline seconds] [--out new-report.json].');
  }
  if (options.config && !options.live) throw new ResearchExampleError('usage', '--config requires --live; offline mode never loads a provider configuration.');
  if (options.cases && !options.live) throw new ResearchExampleError('usage', '--cases requires --live; scripted evaluation uses only the bundled fixture cases.');
  return options;
}

const maxCaseFileBytes = 1024 * 1024;
export function validateEvidenceCases(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new ResearchExampleError('cases', 'Cases must be a JSON array containing 1 to 100 labeled examples.');
  }
  const ids = new Set();
  return Array.from(value, (row, index) => {
    const fail = message => { throw new ResearchExampleError('cases', `Case ${index + 1}: ${message}`); };
    const fields = ['id', 'question', 'text', 'keep', 'reason'];
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) {
      fail('use exactly id, question, text, keep and reason.');
    }
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(row.id)) fail('id must contain 1 to 80 letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit.');
    if (ids.has(row.id)) fail('id must be unique within the dataset.');
    ids.add(row.id);
    for (const [key, limit] of [['question', 4096], ['text', 24 * 1024], ['reason', 4096]]) {
      if (typeof row[key] !== 'string' || !row[key].trim() || Buffer.byteLength(row[key], 'utf8') > limit) fail(`${key} must be nonempty text of at most ${limit} UTF-8 bytes.`);
    }
    if (typeof row.keep !== 'boolean') fail('keep must be true or false.');
    return { id: row.id, question: row.question, text: row.text, keep: row.keep, reason: row.reason };
  });
}

export async function loadEvidenceCases(path, signal) {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxCaseFileBytes) throw new ResearchExampleError('cases', 'Cases must be a regular JSON file of at most 1 MiB.');
    // Read at most one byte beyond the bound, even if the file grows after stat.
    const bytes = Buffer.alloc(maxCaseFileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxCaseFileBytes) throw new ResearchExampleError('cases', 'Cases must be a regular JSON file of at most 1 MiB.');
    signal?.throwIfAborted();
    return validateEvidenceCases(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ResearchExampleError) throw error;
    throw new ResearchExampleError('cases', 'Could not read valid UTF-8 JSON cases. Check the file path, permissions and JSON syntax.');
  } finally { if (handle) await handle.close().catch(() => {}); }
}

export async function loadResearchAdapters({ config, signal, agents = true } = {}) {
  signal?.throwIfAborted();
  if (config) {
    let supplied;
    try { supplied = (await import(pathToFileURL(resolve(config)).href)).default; }
    catch (error) { throw new ResearchExampleError('configuration', `Could not load the trusted adapter module. Check its path, dependencies, and configured access. Error kind: ${safeErrorKind(error)}.`); }
    signal?.throwIfAborted();
    if (typeof supplied?.runJudge !== 'function' || (agents && typeof supplied?.runNode !== 'function')) {
      throw new ResearchExampleError('configuration', 'The adapter module must default-export { runJudge, runNode }; decision-only evaluation needs runJudge only.');
    }
    return { runJudge: supplied.runJudge, ...(agents ? { runNode: supplied.runNode } : {}) };
  }
  try {
    const { createJevRunner } = await import('@parcha/agentrun-jev');
    const runJudge = createJevRunner({ signal, maxAttempts: 1 });
    if (!agents) return { runJudge };
    const [{ createPiRunner }, { default: pi }] = await Promise.all([
      import('@parcha/agentrun-pi'), import('./pi-config.mjs'),
    ]);
    signal?.throwIfAborted();
    return { runJudge, runNode: createPiRunner({ ...pi, signal }) };
  } catch (error) {
    signal?.throwIfAborted();
    throw new ResearchExampleError('configuration', `Configure TypeSafe access and a saved Pi default (Pi is unnecessary for evaluation), or pass --config with your approved host adapters. No fallback was selected. Error kind: ${safeErrorKind(error)}.`);
  }
}

export async function runCli(action, args = process.argv.slice(2)) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('cancelled'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let timer;
  let timedOut = false;
  let deadlineSeconds;
  try {
    const options = parseOptions(args);
    deadlineSeconds = options.deadlineSeconds;
    timer = setTimeout(() => { timedOut = true; cancel(); }, deadlineSeconds * 1000);
    await withCancellation(action(controller.signal, options), controller.signal);
  }
  catch (error) {
    if (controller.signal.aborted) {
      console.error(`${timedOut ? `Research example exceeded its ${deadlineSeconds}-second deadline` : 'Research example cancelled'}. Discard any incomplete output; custom adapters must also honor cancellation.`);
      process.exitCode = 130;
    } else if (error instanceof ResearchExampleError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 1;
    } else {
      console.error('Research execution failed. Check adapter access and output contracts, then run the offline example to separate configuration from workflow errors. Provider error bodies are omitted.');
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export function isMain(url) { return !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href; }
