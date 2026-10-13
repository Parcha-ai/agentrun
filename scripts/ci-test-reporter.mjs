// The reporter CI's npm test adds (through NODE_OPTIONS) beside spec: with TEST_RESULTS_DIR set, it writes, per package,
// <package>.progress.log with one line as each test starts running and one as it ends, and <package>.junit.xml, rewritten as
// each test file ends (CI's --test-force-exit ends the process as soon as the last test does, before a reporter's own end).
// A run killed while a test hangs still names it in the progress log: a "start" line with no "pass" or "fail" after it. On
// Node 22, while other files are reporting, that is the hung file's own start line (Node 22 holds back a running file's events,
// and its --test-timeout bounds the whole file); Node 24 names the test. Spec and junit write a test only when it ends (junit
// only when the whole run ends), so a hung test leaves nothing in either. "start" is test:dequeue, emitted right before the
// test runs; test:start comes in declaration order once results are reported, so a hung test never gets one. Each line is
// appended synchronously, so it is on disk when the run is killed. Without TEST_RESULTS_DIR it writes nothing. It yields
// nothing, so its own destination stays empty.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { junit } from 'node:test/reporters';

const line = (type, data) => {
  const where = data.file ? `${data.file}:${data.line ?? 0}` : '?';
  const name = '  '.repeat(data.nesting ?? 0) + data.name;
  const end = type === 'test:dequeue' ? 'start' : type === 'test:pass' ? 'pass ' : 'fail ';
  return `${new Date().toISOString()} ${end} ${where} ${name}${type === 'test:dequeue' ? '' : ` (${Math.round(data.details?.duration_ms ?? 0)} ms)`}\n`;
};

export default async function* ciTestReporter(source) {
  const dir = process.env.TEST_RESULTS_DIR;
  // npm runs each workspace's test script in the package's own directory, so its name names the files
  const name = basename(process.cwd());
  if (dir) mkdirSync(dir, { recursive: true });
  const events = [];
  for await (const event of source) {
    if (!dir) continue;
    events.push(event);
    const { type, data } = event;
    if (type === 'test:dequeue' || type === 'test:pass' || type === 'test:fail') appendFileSync(join(dir, `${name}.progress.log`), line(type, data));
    // a file (a top-level test) ended: the results so far, in junit's own format
    if ((type === 'test:pass' || type === 'test:fail') && !data.nesting) {
      let xml = '';
      for await (const chunk of junit((async function* () { yield* events; })())) xml += chunk;
      writeFileSync(join(dir, `${name}.junit.xml`), xml);
    }
  }
}
