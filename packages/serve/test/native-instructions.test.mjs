import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {discoverNative} from '../dist/native/discovery.js';
import {snapshotNativeInstructions,withSavedNativeInstructions} from '../dist/native/instructions.js';

test('native grading snapshots standing policy and the selected main agent as evidence data, excluding other configuration',async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.root,'CLAUDE.md'),'Root policy: require owner review.');
 await f.put(join(f.project,'CLAUDE.md'),'Project policy: never delete artifacts without review.');
 const selected=join(f.project,'.claude','agents','definition.md');
 await f.put(selected,'---\nname: reviewer\nmodel: sonnet\n---\nKeep the owner review gate.');
 await f.put(join(f.project,'.claude','agents','other.md'),'---\nname: other\n---\nUNSELECTED_AGENT');
 await f.put(join(f.project,'.claude','settings.json'),'{"env":{"SECRET":"CONFIGURATION_SECRET"}}');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets.find(x=>x.selector.name==='reviewer');
 const snapshot=await snapshotNativeInstructions(target);
 assert.equal(snapshot.truncated,false);
 assert.deepEqual(snapshot.files.map(x=>x.path),[join(f.root,'CLAUDE.md'),join(f.project,'CLAUDE.md'),selected]);
 assert.match(snapshot.text,/evidence data/i);assert.match(snapshot.text,/require owner review/);assert.match(snapshot.text,/never delete artifacts/);assert.match(snapshot.text,/Keep the owner review gate/);
 assert.doesNotMatch(snapshot.text,/CONFIGURATION_SECRET|UNSELECTED_AGENT/);
});

test('native grading refuses a source instruction changed after run discovery',async t=>{
 const f=await nativeFixture(t);const path=join(f.project,'AGENTS.md');
 await f.put(path,'Never skip owner review.');
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 await f.put(path,'Skip owner review.');
 await assert.rejects(snapshotNativeInstructions(target),/changed after discovery/);
});

test('native grading redacts before the UTF8 byte cap and records incomplete instruction evidence',async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'AGENTS.md'),'PRIVATE_TOKEN\n'+'🌱'.repeat(18000));
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target,text=>text.replaceAll('PRIVATE_TOKEN','[redacted]'));
 assert.equal(snapshot.truncated,true);assert.ok(Buffer.byteLength(snapshot.text,'utf8')<=65536);
 assert.match(snapshot.text,/\[redacted\]/);assert.match(snapshot.text,/truncated/i);assert.doesNotMatch(snapshot.text,/PRIVATE_TOKEN|\uFFFD/);
});

test('project-default Claude policy includes the main agent selected by native settings without copying settings values',async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.project,'.claude','settings.json'),'{"agent":"reviewer","env":{"SECRET":"DO_NOT_COPY"}}');
 const agent=join(f.project,'.claude','agents','reviewer.md');
 await f.put(agent,'---\nname: reviewer\n---\nStanding reviewer policy: preserve owner approval.');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);
 assert.deepEqual(snapshot.files.map(x=>x.path),[agent]);assert.match(snapshot.text,/preserve owner approval/);assert.doesNotMatch(snapshot.text,/DO_NOT_COPY/);
});

test('saved native policy is redacted before the shared UTF8 grading bound and cannot clear incomplete source evidence',()=>{
 const source={text:'Source policy: preserve owner review.',files:[],truncated:false};
 const combined=withSavedNativeInstructions(source,'PRIVATE_TOKEN\n'+'🌱'.repeat(18000),text=>text.replaceAll('PRIVATE_TOKEN','[redacted]'));
 assert.equal(combined.truncated,true);assert.ok(Buffer.byteLength(combined.text,'utf8')<=65536);
 assert.match(combined.text,/preserve owner review/);assert.match(combined.text,/\[redacted\]/);assert.doesNotMatch(combined.text,/PRIVATE_TOKEN|\uFFFD/);
 assert.equal(withSavedNativeInstructions({...source,truncated:true},'Short saved policy.',text=>text).truncated,true);
 assert.deepEqual(withSavedNativeInstructions(source,'',text=>text),source);
});
