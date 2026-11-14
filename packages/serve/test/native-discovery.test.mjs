import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, symlink } from 'node:fs/promises';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { discoverNative, nativeIdentity, verifyNative } from '../dist/native/discovery.js';
import { launchNative } from '../dist/native/connection.js';

test('discovery links canonical projects, named agents and profiles without executing hooks or copying secrets',async(t)=>{
 const f=await nativeFixture(t);
 const settings=join(f.project,'.claude','settings.json');
 await f.put(settings,JSON.stringify({model:'sonnet',hooks:{SessionStart:[{command:'must never run'}]},env:{SECRET:'must-not-leak'}}));
 await f.put(join(f.project,'.claude','agents','reviewer.md'),'---\nname: reviewer\nmodel: opus\ndescription: code review\n---\nReview code.');
 await f.put(join(f.project,'.claude','skills','check','SKILL.md'),'---\nname: check\n---\nCheck.');
 await f.put(join(f.project,'.mcp.json'),JSON.stringify({mcpServers:{database:{command:'db',env:{SECRET:'must-not-leak'}}}}));
 await f.put(join(f.home,'.codex','config.toml'),'model = "gpt-native"\n[mcp_servers.docs]\ncommand = "docs"\n');
 await f.put(join(f.home,'.codex','review.config.toml'),'model = "gpt-review"\n');
 const alias=join(f.root,'alias');await symlink(f.project,alias);
 const found=await discoverNative({project:alias,env:f.env});
 assert.deepEqual(found.targets.map(x=>[x.runtime,x.selector.kind,x.selector.name??null]),[['claude-code','project',null],['claude-code','agent','reviewer'],['codex','project',null],['codex','profile','review']]);
 assert.ok(found.targets.every(x=>x.project===f.project&&x.state==='needs_verification'));
 assert.equal(found.targets[0].model,'sonnet');assert.equal(found.targets[1].model,'opus');assert.equal(found.targets[3].model,'gpt-review');
 assert.deepEqual(found.targets[0].skills,['check']);assert.deepEqual(found.targets[0].mcp_servers,['database']);
 assert.equal(JSON.stringify(found).includes('must-not-leak'),false);
 assert.ok((await f.calls()).every(x=>x.args.length===1&&x.args[0]==='--version'));
 const before=found.targets[0];await f.put(settings,'{"model":"opus"}');
 const after=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(nativeIdentity(before),nativeIdentity(after));assert.notEqual(before.fingerprint,after.fingerprint);
 assert.equal(await readFile(settings,'utf8'),'{"model":"opus"}');
});

test('verification checks native sign-in without a model call and explains missing authentication',async(t)=>{
 const f=await nativeFixture(t);const found=await discoverNative({project:f.project,env:f.env});
 for(const target of found.targets){
  const verified=await verifyNative(target,{env:f.env});assert.equal(verified.state,'ready');assert.ok(verified.issues.some(x=>/untested/.test(x)));
  const rejected=await verifyNative(target,{env:{...f.env,NATIVE_TEST_AUTH:'no'}});assert.equal(rejected.state,'needs_attention');assert.ok(rejected.issues.some(x=>/Sign in/.test(x)));
 }
 assert.ok((await f.calls()).every(x=>x.args.includes('--version')||x.args.includes('status')));
});

test('desktop-only Claude tools are reported as a compatibility gap rather than native CLI tools',async(t)=>{
 const f=await nativeFixture(t);
 await f.put(join(f.home,'.config','Claude','claude_desktop_config.json'),'{"mcpServers":{"desktop-only":{"command":"desktop-secret"}}}');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.deepEqual(target.mcp_servers,[]);
 assert.ok(target.issues.some(issue=>/desktop-only/.test(issue)&&/Desktop/.test(issue)));
 assert.equal(JSON.stringify(target).includes('desktop-secret'),false);
});

test('native agent label discovery ignores unrelated frontmatter fields and does not parse instruction prose as metadata',async(t)=>{
 const f=await nativeFixture(t);
 await f.put(join(f.project,'.claude','agents','reviewer.md'),'---\nname: reviewer\nmodel: sonnet\ndescription: Review: code\n---\nname: not-an-agent\nmodel: not-a-model\n');
 const found=await discoverNative({project:f.project,runtime:'claude-code',env:f.env});
 assert.equal(found.targets[0].state,'needs_verification');
 assert.equal(found.targets[1].selector.name,'reviewer');assert.equal(found.targets[1].model,'sonnet');
});

test('native selectors use CLI-safe names while model identifiers retain provider separators',async(t)=>{
 const f=await nativeFixture(t);
 await f.put(join(f.project,'.claude','agents','bad.md'),'---\nname: bad/agent\nmodel: provider/model\n---\n');
 await f.put(join(f.home,'.codex','bad:profile.config.toml'),'model = "provider/model"\n');
 await f.put(join(f.home,'.codex','safe.profile.config.toml'),'model = "provider/model"\n');
 const found=await discoverNative({project:f.project,env:f.env});
 assert.ok(found.targets.every(t=>!t.selector.name||/^[\w.@+-]+$/.test(t.selector.name)));
 assert.equal(found.targets.find(t=>t.selector.name==='safe.profile').model,'provider/model');
 assert.ok(found.targets.some(t=>t.issues.some(issue=>/selector/.test(issue)&&/Rename/.test(issue))));
});

test('discovery rejects missing paths and files with an actionable project input error',async(t)=>{
 const f=await nativeFixture(t);const file=join(f.root,'file.txt');await f.put(file,'not a project directory');
 for(const project of [join(f.root,'missing'),file])await assert.rejects(discoverNative({project,env:f.env}),error=>error.code==='input_invalid'&&error.status===422&&/directory/.test(error.message));
 assert.deepEqual(await f.calls(),[]);
});

for(const [runtime,versions,minimum] of [
 ['claude-code',['2.1.321','2.0.999','1.999.999','3.0.0','unknown-version','2.1.323-beta.1','2.1.322.1'],'2.1.322'],
 ['codex',['0.167.1','0.166.999','1.0.0','unknown-version','0.168.0-beta.1','0.167.2.1'],'0.167.2'],
])test(`${runtime} unsupported native versions require attention and never reach authentication checks`,async(t)=>{
 const f=await nativeFixture(t);
 for(const version of versions){
  const env={...f.env,NATIVE_TEST_VERSION:version};
  const target=(await discoverNative({project:f.project,runtime,env})).targets[0];
  assert.equal(target.state,'needs_attention',version);
  assert.deepEqual([target.capabilities.launch,target.capabilities.notes,target.capabilities.skills],[false,false,false],version);
  assert.ok(target.issues.some(issue=>issue.includes(minimum)),JSON.stringify(target.issues));
  const verified=await verifyNative(target,{env});assert.equal(verified.state,'needs_attention');assert.equal(verified.connected,false);
 }
 assert.ok((await f.calls()).every(call=>call.args.length===1&&call.args[0]==='--version'));
});

for (const desktop of ['tools','invalid']) test(`Claude Desktop ${desktop} are advisory and do not block or fingerprint a valid Code project`,async t=>{
 const f=await nativeFixture(t),path=join(f.home,'.config','Claude','claude_desktop_config.json');
 const before=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 await f.put(path,desktop==='tools'?'{"mcpServers":{"desktop-only":{"command":"desktop-secret"}}}':'{not json');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(target.state,'needs_verification','an unrelated Desktop file is not a Code launch blocker');
 assert.equal(target.fingerprint,before.fingerprint,'Desktop configuration is not loaded by this Code project');
 assert.deepEqual(target.mcp_servers,[]);assert.ok(target.issues.some(issue=>/Desktop/.test(issue)));
 const checked=await verifyNative(target,{env:f.env});assert.equal(checked.state,'ready');assert.equal(checked.capabilities.launch,true);
 const launched=await launchNative({...checked,connected:true},f.env);assert.equal(launched.state,'ready');
 assert.equal(JSON.stringify(target).includes('desktop-secret'),false);
});
