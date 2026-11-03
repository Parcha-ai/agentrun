import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserText, assertBundledPackage, assertConsoleDependencies } from '../apps/console/build-boundary.mjs';

test('the browser boundary refuses private integrations in dependencies and emitted assets', () => {
  assert.doesNotThrow(() => assertConsoleDependencies({ dependencies: { react: '18.3.1', clsx: '2.1.1' } }));
  assert.throws(() => assertConsoleDependencies({ dependencies: { '@descope/react-sdk': '1.0.0' } }), /unreviewed/);
  assert.doesNotThrow(() => assertBundledPackage('scheduler'));
  assert.throws(() => assertBundledPackage('private-integration-sdk'), /unreviewed/);
  for (const text of ['fetch("https://' + ['grep', 'ai'].join('.') + '/api")', 'posthog.capture("event")', 'https://docs.' + ['parcha', 'dev'].join('.')]) {
    assert.throws(() => assertBrowserText(text, 'assets/app.js'), /private integration/);
  }
  assert.doesNotThrow(() => assertBrowserText('fetch("/v2/agents")', 'assets/app.js'));
});
