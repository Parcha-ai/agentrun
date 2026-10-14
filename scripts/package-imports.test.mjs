import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importsOf } from './package-imports.mjs';

test('a string, a comment or a template literal that looks like an import is not one', () => {
  assert.deepEqual(importsOf(`const frame = "records-from"; const g = 'x from "nope"';`), []);
  assert.deepEqual(importsOf(`const frame = "records-from";\nconst after = require('real');`), ['real'], 'a quote left open by the text above does not swallow the next line');
  assert.deepEqual(importsOf(`// import z from 'comment'\nexport const a = 1;`), []);
  assert.deepEqual(importsOf(`/* import y from 'block'\n   require('inblock') */ export const a = 1;`), []);
  assert.deepEqual(importsOf('const t = `from \'tmpl\'`;'), []);
  assert.deepEqual(importsOf('const t = `a ${require(\'inexpr\')} b from \'tmpl2\'`;'), ['inexpr'], 'code inside a template expression is code');
  assert.deepEqual(importsOf(`const transformfrom = "x"; const sfrom = 'y';`), []);
  assert.deepEqual(importsOf(`const s = "say \\"from 'x'\\""; import q from 'afterescape';`), ['afterescape']);
  assert.deepEqual(importsOf(`const r = /from '(\\w+)'/; import a from 'afterregex';`), ['afterregex']);
});

test('every import form of a built .js file is read', () => {
  assert.deepEqual(importsOf(`import a from 'a'; import { b } from "@s/b/sub"; import * as ns from 'ns'; import d, { n } from 'dn';`), ['a', '@s/b/sub', 'ns', 'dn']);
  assert.deepEqual(importsOf(`import 'side';`), ['side']);
  assert.deepEqual(importsOf(`import {\n  a,\n  b,\n} from\n  'multi';`), ['multi']);
  assert.deepEqual(importsOf(`export * from 'c'; export { d } from 'd';`), ['c', 'd']);
  assert.deepEqual(importsOf(`export * as ns from 'nsmod'; export * as default from 'defmod';`), ['nsmod', 'defmod']);
  assert.deepEqual(importsOf(`const f = require('f'); const e = await import('e');`), ['f', 'e']);
  assert.deepEqual(importsOf(`import legacy = require('legacy');`), ['legacy']);
  assert.deepEqual(importsOf(`import j from './j.json' with { type: 'json' };`), ['./j.json']);
  assert.deepEqual(importsOf(`const lazy = await import(\`tpl\`); const req = require(\`tplreq\`);`), ['tpl', 'tplreq']);
});

test('every import form of a .d.ts file is read', () => {
  assert.deepEqual(importsOf(`import type { X } from 'tx'; export type Y = import('ty').Y;`), ['tx', 'ty']);
  assert.deepEqual(importsOf(`declare const z: typeof import("tz");`), ['tz']);
  assert.deepEqual(importsOf(`export type { T } from 'typenamed'; export type * from 'typestar'; export type * as S from 'typestarns';`), ['typenamed', 'typestar', 'typestarns']);
  assert.deepEqual(importsOf(`import type L = require('typeeq'); export import R = require('exeq');`), ['typeeq', 'exeq']);
  assert.deepEqual(importsOf(`declare module 'ambient' { import x from 'inner'; export const a: number; }`), ['inner'], 'the ambient module is a declaration, its own import is a dependency');
  assert.deepEqual(importsOf(`/// <reference types="node" />\n/// <reference path="./x.d.ts" />\nexport declare const name: "records-from";`), []);
});

test('only literal specifiers are listed, once per occurrence and in source order', () => {
  assert.deepEqual(importsOf(`const f = require(name); const e = await import(dynamicName); const p = require.resolve('resolved'); const u = import.meta.url;`), []);
  assert.deepEqual(importsOf(`import a from 'a'; import b from 'b'; import a2 from 'a';`), ['a', 'b', 'a']);
  assert.deepEqual(importsOf(''), []);
});
