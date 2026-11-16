import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {unlink} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {discoverNative} from '../dist/native/discovery.js';
import {launchNative} from '../dist/native/connection.js';
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

for(const localAgent of ['local',null]) test(`local Claude settings override the shared main agent with ${localAgent??'no agent'}`,async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.project,'.claude','settings.json'),JSON.stringify({agent:'shared',env:{SECRET:'SHARED_SETTINGS_SECRET'}}));
 await f.put(join(f.project,'.claude','settings.local.json'),JSON.stringify({agent:localAgent,env:{SECRET:'LOCAL_SETTINGS_SECRET'}}));
 const shared=join(f.project,'.claude','agents','shared.md'),local=join(f.project,'.claude','agents','local.md');
 await f.put(shared,'---\nname: shared\n---\nSHARED_AGENT_POLICY');await f.put(local,'---\nname: local\n---\nLOCAL_AGENT_POLICY');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets.find(x=>x.selector.kind==='project');
 const snapshot=await snapshotNativeInstructions(target);
 assert.deepEqual(snapshot.files.map(x=>x.path),localAgent?[local]:[]);
 assert.equal(snapshot.text.includes('LOCAL_AGENT_POLICY'),localAgent!==null);
 assert.doesNotMatch(snapshot.text,/SHARED_AGENT_POLICY|SHARED_SETTINGS_SECRET|LOCAL_SETTINGS_SECRET/);
});

test('ambiguous Claude ancestor-local policy refuses completeness while an explicit agent stays selected',async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.root,'.claude','settings.local.json'),JSON.stringify({agent:'ancestor'}));
 await f.put(join(f.project,'.claude','settings.json'),JSON.stringify({agent:'project'}));
 const agent=join(f.project,'.claude','agents','project.md'),explicit=join(f.project,'.claude','agents','explicit.md');
 await f.put(join(f.root,'.claude','agents','ancestor.md'),'---\nname: ancestor\n---\nANCESTOR_AGENT_POLICY');
 await f.put(agent,'---\nname: project\n---\nPROJECT_AGENT_POLICY');await f.put(explicit,'---\nname: explicit\n---\nEXPLICIT_AGENT_POLICY');
 const {targets}=await discoverNative({project:f.project,runtime:'claude-code',env:f.env});
 const project=await snapshotNativeInstructions(targets.find(x=>x.selector.kind==='project'));
 assert.match(project.incomplete,/Claude.*policy/i);
 assert.deepEqual(project.files.map(x=>x.path),[agent]);assert.match(project.text,/PROJECT_AGENT_POLICY/);assert.doesNotMatch(project.text,/ANCESTOR_AGENT_POLICY/);
 const selected=await snapshotNativeInstructions(targets.find(x=>x.selector.name==='explicit'));
 assert.match(selected.incomplete,/Claude.*policy/i);
 assert.deepEqual(selected.files.map(x=>x.path),[explicit]);assert.match(selected.text,/EXPLICIT_AGENT_POLICY/);assert.doesNotMatch(selected.text,/PROJECT_AGENT_POLICY|ANCESTOR_AGENT_POLICY/);
});

test('saved native policy is redacted before the shared UTF8 grading bound and cannot clear incomplete source evidence',()=>{
 const source={text:'Source policy: preserve owner review.',files:[],truncated:false};
 const combined=withSavedNativeInstructions(source,'PRIVATE_TOKEN\n'+'🌱'.repeat(18000),text=>text.replaceAll('PRIVATE_TOKEN','[redacted]'));
 assert.equal(combined.truncated,true);assert.ok(Buffer.byteLength(combined.text,'utf8')<=65536);
 assert.match(combined.text,/preserve owner review/);assert.match(combined.text,/\[redacted\]/);assert.doesNotMatch(combined.text,/PRIVATE_TOKEN|\uFFFD/);
 assert.equal(withSavedNativeInstructions({...source,truncated:true},'Short saved policy.',text=>text).truncated,true);
 assert.deepEqual(withSavedNativeInstructions(source,'',text=>text),source);
});

for(const location of ['user','project','selected profile']) test(`Codex ${location} custom model instructions cannot be certified as complete AGENTS evidence`,async t=>{
 const f=await nativeFixture(t);
 const path=location==='project'?join(f.project,'.codex','config.toml'):join(f.env.CODEX_HOME,location==='selected profile'?'review.config.toml':'config.toml');
 await f.put(join(f.project,'AGENTS.md'),'Captured source policy: preserve review.');
 await f.put(path,'"model_\\u0069nstructions_file" = """private-policy.md"""\n[model_providers.private]\nenv_key = "CONFIGURATION_SECRET"\n');
 await f.put(join(f.env.CODEX_HOME,'private-policy.md'),'Uncaptured policy: never export release data.');
 const targets=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets;
 const target=targets.find(x=>x.selector.kind===(location==='selected profile'?'profile':'project'));
 const snapshot=await snapshotNativeInstructions(target);
 assert.equal(snapshot.truncated,false,'the policy gap is distinct from the byte limit');
 assert.equal(snapshot.codexConfigurationChecked,true);
 assert.match(snapshot.incomplete,/Codex.*policy/i);
 assert.match(snapshot.text,/Captured source policy/);assert.doesNotMatch(snapshot.text,/CONFIGURATION_SECRET|private-policy.md/);
 assert.ok(snapshot.files.some(file=>file.path===path&&file.sha256===target.configuration.find(item=>item.path===path).sha256));
 const saved=withSavedNativeInstructions(snapshot,'PRIVATE_TOKEN\n'+'🌱'.repeat(18000),text=>text.replaceAll('PRIVATE_TOKEN','[redacted]'));
 assert.equal(saved.incomplete,snapshot.incomplete);assert.equal(saved.truncated,true);assert.equal(saved.codexConfigurationChecked,true);
 assert.ok(Buffer.byteLength(saved.text,'utf8')<=65536);assert.doesNotMatch(saved.text,/PRIVATE_TOKEN|\uFFFD/);
});

test('ordinary Codex configuration and unselected custom-policy profiles do not disable complete evidence',async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.env.CODEX_HOME,'config.toml'),'model = "native-model"\n# model_instructions_file = "not-active.md"\n[mcp_servers.docs]\ncommand = "docs"\n');
 await f.put(join(f.env.CODEX_HOME,'other.config.toml'),'model_instructions_file = "other.md"\n');
 await f.put(join(f.env.CODEX_HOME,'review.config.toml'),'model = "review-model"\n');
 const {targets}=await discoverNative({project:f.project,runtime:'codex',env:f.env});
 for(const target of targets.filter(x=>x.selector.name!=='other')){
  const snapshot=await snapshotNativeInstructions(target);assert.equal(snapshot.incomplete,undefined);assert.equal(snapshot.truncated,false);
 }
});

for(const condition of ['invalid','unreadable','changed']) test(`Codex ${condition} configuration cannot certify complete instruction evidence`,async t=>{
 const f=await nativeFixture(t);const path=join(f.env.CODEX_HOME,'config.toml');
 await f.put(path,condition==='invalid'?'model_instructions_file = "unfinished':'model = "native-model"\n');
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 if(condition==='unreadable')await unlink(path);
 if(condition==='changed')await f.put(path,'model_instructions_file = "new-policy.md"\n');
 const snapshot=await snapshotNativeInstructions(target);assert.match(snapshot.incomplete,/Codex.*configuration/i);assert.equal(snapshot.truncated,false);
});

test('system Codex custom policy is discovered and cannot certify a complete grading snapshot', {skip:process.platform==='win32'},async t=>{
 const f=await nativeFixture(t);const system=join(f.root,'system-config.toml');await f.put(system,'model_instructions_file = "system-policy.md"\n');
 // Redirect only the OS-owned filesystem boundary; never edit the machine's actual configuration.
 const read=fsPromises.readFile;
 t.mock.method(fsPromises,'readFile',(path,...args)=>read(path==='/etc/codex/config.toml'?system:path,...args));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 assert.ok(target.configuration.some(file=>file.path==='/etc/codex/config.toml'));
 const snapshot=await snapshotNativeInstructions(target);assert.match(snapshot.incomplete,/Codex.*policy/i);
 assert.ok(snapshot.files.some(file=>file.path==='/etc/codex/config.toml'));
});

for(const key of ['developer_instructions','experimental_instructions_file'])test(`Codex ${key} cannot bypass the custom policy evidence refusal`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.env.CODEX_HOME,'config.toml'),`${key} = 'PRIVATE_POLICY_VALUE'\n`);
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);assert.match(snapshot.incomplete,/Codex.*policy/i);assert.doesNotMatch(snapshot.text,/PRIVATE_POLICY_VALUE/);
});

for(const selector of ['', 'profile = "review"\n'])test(`legacy Codex profile policy without CLI selection fails closed ${selector?'with':'without'} a default profile`,async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.env.CODEX_HOME,'config.toml'),`${selector}[profiles.review]\nmodel_instructions_file = "PRIVATE_POLICY_VALUE"\n`);
 const target=(await discoverNative({project:f.project,runtime:'codex',env:f.env})).targets.find(x=>x.selector.kind==='project');
 const snapshot=await snapshotNativeInstructions(target);assert.match(snapshot.incomplete,/Codex.*policy/i);assert.doesNotMatch(snapshot.text,/PRIVATE_POLICY_VALUE/);
});

for(const location of ['deep global','inside project','project root','project .claude'])test(`Claude project policy wins with CLAUDE_CONFIG_DIR at ${location}`,async t=>{
 const f=await nativeFixture(t);
 const global=location==='deep global'?join(f.home,'nested','config','claude'):location==='inside project'?join(f.project,'nested','global'):location==='project root'?f.project:join(f.project,'.claude');
 f.env.CLAUDE_CONFIG_DIR=global;
 await f.put(join(global,'settings.json'),JSON.stringify({agent:'global'}));
 await f.put(join(global,'agents','global.md'),'---\nname: global\n---\nGLOBAL_AGENT_POLICY');
 await f.put(join(f.root,'.claude','settings.json'),JSON.stringify({agent:'ancestor'}));
 const shared=join(f.project,'.claude','settings.json'),projectAgent=join(f.project,'.claude','agents','project.md');
 await f.put(shared,JSON.stringify({agent:'project'}));await f.put(projectAgent,'---\nname: project\n---\nPROJECT_AGENT_POLICY');
 const targets=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets;
 const target=targets.find(x=>x.selector.kind==='project');
 const snapshot=await snapshotNativeInstructions(target);
 assert.equal(snapshot.claudeConfigurationChecked,true);
 assert.deepEqual(snapshot.files.map(file=>file.path),[projectAgent]);assert.match(snapshot.text,/PROJECT_AGENT_POLICY/);assert.doesNotMatch(snapshot.text,/GLOBAL_AGENT_POLICY|ANCESTOR_AGENT_POLICY/);
 // A stored binding from before discovery retained precedence must be rediscovered at launch.
 const old={...target,configuration:[...target.configuration].sort((a,b)=>a.path.localeCompare(b.path)),connected:true};
 const refreshed=await snapshotNativeInstructions(await launchNative(old,f.env));
 assert.deepEqual(refreshed.files,snapshot.files);
 const explicit=await snapshotNativeInstructions(targets.find(x=>x.selector.kind==='agent'&&x.selector.name==='global'));
 assert.match(explicit.text,/GLOBAL_AGENT_POLICY/);assert.doesNotMatch(explicit.text,/PROJECT_AGENT_POLICY|ANCESTOR_AGENT_POLICY/);
 const local=join(f.project,'.claude','settings.local.json'),localAgent=join(f.project,'.claude','agents','local.md');
 await f.put(local,JSON.stringify({agent:'local'}));await f.put(localAgent,'---\nname: local\n---\nLOCAL_AGENT_POLICY');
 const localTarget=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.deepEqual((await snapshotNativeInstructions(localTarget)).files.map(file=>file.path),[localAgent]);
});

test('Claude project agent definitions shadow same-name custom global agents using discovery scope order',async t=>{
 const f=await nativeFixture(t);f.env.CLAUDE_CONFIG_DIR=join(f.project,'a','b','custom');
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'reviewer'}));
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'agents','z-global.md'),'---\nname: reviewer\n---\nGLOBAL_REVIEWER');
 const projectAgent=join(f.project,'.claude','agents','a-project.md');
 await f.put(projectAgent,'---\nname: reviewer\n---\nPROJECT_REVIEWER');
 const {targets}=await discoverNative({project:f.project,runtime:'claude-code',env:f.env});
 for(const target of targets){
  const snapshot=await snapshotNativeInstructions(target);assert.deepEqual(snapshot.files.map(file=>file.path),[projectAgent]);assert.match(snapshot.text,/PROJECT_REVIEWER/);assert.doesNotMatch(snapshot.text,/GLOBAL_REVIEWER/);
 }
});

test('Claude global settings.local.json is inactive unless its directory is also a project scope',async t=>{
 const f=await nativeFixture(t);f.env.CLAUDE_CONFIG_DIR=join(f.home,'custom','claude');
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'global'}));
 const globalAgent=join(f.env.CLAUDE_CONFIG_DIR,'agents','global.md');
 await f.put(globalAgent,'---\nname: global\n---\nGLOBAL_AGENT_POLICY');
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'agents','inactive.md'),'---\nname: inactive\n---\nINACTIVE_AGENT_POLICY');
 const before=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const local=join(f.env.CLAUDE_CONFIG_DIR,'settings.local.json');await f.put(local,JSON.stringify({agent:'inactive'}));
 const after=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(after.fingerprint,before.fingerprint,'an inactive global local-settings file cannot change native launch metadata');
 assert.ok(!after.configuration.some(file=>file.path===local));
 const snapshot=await snapshotNativeInstructions(after);
 assert.deepEqual(snapshot.files.map(file=>file.path),[globalAgent]);assert.match(snapshot.text,/GLOBAL_AGENT_POLICY/);assert.doesNotMatch(snapshot.text,/INACTIVE_AGENT_POLICY/);
});

test('a Claude project under HOME ignores the user settings.local.json encountered again as an ancestor',async t=>{
 const f=await nativeFixture(t);f.project=join(f.home,'repo');await f.put(join(f.project,'README.md'),'fixture');
 execFileSync('git',['init','-q',f.project],{env:f.env});
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'global'}));
 const globalAgent=join(f.env.CLAUDE_CONFIG_DIR,'agents','global.md');await f.put(globalAgent,'---\nname: global\n---\nGLOBAL_AGENT_POLICY');
 const before=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const ignored=join(f.env.CLAUDE_CONFIG_DIR,'settings.local.json');await f.put(ignored,JSON.stringify({agent:'bogus'}));
 const after=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(after.fingerprint,before.fingerprint);assert.ok(!after.configuration.some(file=>file.path===ignored));
 const snapshot=await snapshotNativeInstructions(after);assert.equal(snapshot.incomplete,undefined);assert.deepEqual(snapshot.files.map(file=>file.path),[globalAgent]);
});

test('Claude inactive ancestor shared settings cannot override the actual global main agent or model',async t=>{
 const f=await nativeFixture(t);await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'global',model:'global-model'}));
 const globalAgent=join(f.env.CLAUDE_CONFIG_DIR,'agents','global.md');await f.put(globalAgent,'---\nname: global\n---\nGLOBAL_AGENT_POLICY');
 await f.put(join(f.root,'.claude','settings.json'),JSON.stringify({agent:'inactive',model:'inactive-model'}));
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(target.model,'global-model');assert.ok(!target.configuration.some(file=>file.path===join(f.root,'.claude','settings.json')));
 const snapshot=await snapshotNativeInstructions(target);assert.equal(snapshot.incomplete,undefined);assert.deepEqual(snapshot.files.map(file=>file.path),[globalAgent]);
});

for(const source of ['ancestor local','ancestor agent','worktree control'])test(`Claude ${source} ambiguity refuses policy completeness without blocking native tasks`,async t=>{
 const f=await nativeFixture(t);
 await f.put(join(f.project,'.claude','settings.json'),JSON.stringify({model:'project-model'}));
 if(source==='ancestor local')await f.put(join(f.root,'.claude','settings.local.json'),JSON.stringify({agent:'unknown',model:'unknown-model'}));
 if(source==='ancestor agent')await f.put(join(f.root,'.claude','agents','reviewer.md'),'---\nname: reviewer\nmodel: unknown-model\n---\nPotential repository policy.');
 if(source==='worktree control')await f.put(join(f.project,'.git'),'gitdir: ../main/.git/worktrees/fixture\n');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(target.model,null,'discovery cannot claim an effective model from unresolved source scopes');
 assert.equal(target.capabilities.launch,true);assert.equal(target.capabilities.notes,false);
 const launched=await launchNative({...target,connected:true},f.env);assert.equal(launched.state,'ready');
 assert.match((await snapshotNativeInstructions(launched)).incomplete,/Claude.*policy/i);
});

test('Claude agent definitions walk to the actual repository root, exclude higher ancestors, and prefer cwd',async t=>{
 const f=await nativeFixture(t);const repository=join(f.root,'repo');f.project=join(repository,'nested');await f.put(join(f.project,'README.md'),'fixture');execFileSync('git',['init','-q',repository],{env:f.env});
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'reviewer'}));
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'agents','reviewer.md'),'---\nname: reviewer\n---\nGLOBAL_REVIEWER');
 await f.put(join(f.root,'.claude','agents','outside.md'),'---\nname: outside\n---\nOUTSIDE_REPOSITORY_POLICY');
 await f.put(join(f.root,'.claude','settings.local.json'),JSON.stringify({agent:'outside',model:'outside-model'}));
 const repositoryAgent=join(repository,'.claude','agents','reviewer.md');await f.put(repositoryAgent,'---\nname: reviewer\n---\nREPOSITORY_REVIEWER');
 const found=await discoverNative({project:f.project,runtime:'claude-code',env:f.env});assert.ok(!found.targets.some(target=>target.selector.name==='outside'));
 const snapshot=await snapshotNativeInstructions(found.targets[0]);assert.equal(snapshot.incomplete,undefined);assert.deepEqual(snapshot.files.map(file=>file.path),[repositoryAgent]);assert.doesNotMatch(snapshot.text,/OUTSIDE_REPOSITORY_POLICY|GLOBAL_REVIEWER/);
 const cwdAgent=join(f.project,'.claude','agents','reviewer.md');await f.put(cwdAgent,'---\nname: reviewer\n---\nCURRENT_REVIEWER');
 const current=await snapshotNativeInstructions((await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0]);assert.equal(current.incomplete,undefined);assert.deepEqual(current.files.map(file=>file.path),[cwdAgent]);
});

for(const kind of ['nested','duplicate','symlink'])test(`Claude ${kind} agent definitions refuse unverified policy selection`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({agent:'reviewer'}));
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'agents','first.md'),'---\nname: reviewer\n---\nFIRST_POLICY');
 if(kind==='symlink'){
  const source=join(f.root,'linked-policy.md');await f.put(source,'---\nname: reviewer\n---\nLINKED_PROJECT_POLICY');
  const agents=join(f.project,'.claude','agents');await fsPromises.mkdir(agents,{recursive:true});await fsPromises.symlink(source,join(agents,'reviewer.md'));
 }else await f.put(join(f.env.CLAUDE_CONFIG_DIR,'agents',kind==='nested'?'nested/other.md':'second.md'),'---\nname: reviewer\n---\nOTHER_POLICY');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal(target.capabilities.launch,true);assert.equal(target.capabilities.notes,false);assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);
});

const claudeImports = [
 '@AGENTS.md', 'Follow @../policy/rules.md before editing.', 'Read (@/absolute/policy.md).',
 '@~/private-policy.md', '@Design\\ Docs/policy.md', '`unclosed example followed by @AGENTS.md',
];
for (const policy of claudeImports) test(`Claude uncaptured import is incomplete evidence: ${policy}`, async t => {
 const f=await nativeFixture(t);const path=join(f.project,'CLAUDE.md');await f.put(path,policy);
 await f.put(join(f.project,'AGENTS.md'),'IMPORTED_RULE: require owner review.');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);
 assert.match(snapshot.incomplete,/Claude.*import/i);assert.equal(snapshot.truncated,false);
 assert.equal(snapshot.claudePolicySourcesChecked,true);assert.ok(snapshot.text.includes(policy));
 assert.doesNotMatch(snapshot.text,/IMPORTED_RULE/,'uncaptured imports must never be described as captured');
 assert.deepEqual(snapshot.files.map(file=>file.path),[path]);
});

for (const policy of [
 'Require owner review. Contact owner@example.com or first.last+team@example.co.uk.',
 'Examples: `@AGENTS.md` and ``code ` @other.md`` are inert.',
 '```md\n@AGENTS.md\n```\n~~~text\n@other.md\n~~~',
 `Quoted paths: @"AGENTS.md" and @'other.md'.`,
]) test(`Claude inert import examples retain complete evidence: ${JSON.stringify(policy)}`, async t => {
 const f=await nativeFixture(t);await f.put(join(f.project,'CLAUDE.md'),policy);
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);
 assert.equal(snapshot.incomplete,undefined);assert.equal(snapshot.truncated,false);assert.equal(snapshot.claudePolicySourcesChecked,true);
});

test('Claude import detection precedes redaction and survives saved policy, UTF8 bounds and JSON',async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'CLAUDE.local.md'),'@PRIVATE_POLICY.md\n'+'🌱'.repeat(18000));
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target,text=>text.replaceAll('@PRIVATE_POLICY.md','[redacted]'));
 const saved=JSON.parse(JSON.stringify(withSavedNativeInstructions(snapshot,'Saved instructions.',text=>text)));
 assert.match(saved.incomplete,/Claude.*import/i);assert.equal(saved.truncated,true);assert.equal(saved.claudePolicySourcesChecked,true);
 assert.ok(Buffer.byteLength(saved.text,'utf8')<=65536);assert.doesNotMatch(saved.text,/PRIVATE_POLICY|\uFFFD/);
});

for(const location of ['project','project .claude','ancestor','user Claude only'])test(`Claude direct AGENTS fallback remains uncaptured policy: ${location}`,async t=>{
 const f=await nativeFixture(t);
 const path=location==='project .claude'?join(f.project,'.claude','AGENTS.md'):location==='ancestor'?join(f.root,'AGENTS.md'):join(f.project,'AGENTS.md');
 await f.put(path,'DIRECT_AGENTS_POLICY: require owner review.');
 if(location==='user Claude only')await f.put(join(f.env.CLAUDE_CONFIG_DIR,'CLAUDE.md'),'User guidance does not shadow project AGENTS.');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);
 assert.match(snapshot.incomplete,/Claude.*(AGENTS|policy sources)/i);assert.equal(snapshot.truncated,false);
 assert.doesNotMatch(snapshot.text,/DIRECT_AGENTS_POLICY/);
});

for(const shadow of ['CLAUDE.md','CLAUDE.local.md','.claude/CLAUDE.md'])test(`Claude default ${shadow} shadows direct AGENTS policy`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,shadow),'Keep owner review.');
 await f.put(join(f.project,'AGENTS.md'),'INACTIVE_AGENTS_POLICY');
 await f.put(join(f.project,'.claude','settings.json'),JSON.stringify({pluginConfigs:{'agents-md@builtin':{options:{instructionFiles:'claude-md-and-agents-md'}}}}));
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 const snapshot=await snapshotNativeInstructions(target);
 assert.equal(snapshot.incomplete,undefined,'project pluginConfigs does not activate the user-only instruction selector');
 assert.doesNotMatch(snapshot.text,/INACTIVE_AGENTS_POLICY/);
});

for(const plugin of ['agents-md@builtin','cc-plugin-agents-md@builtin'])test(`Claude user ${plugin} selection cannot certify additional policy as inactive`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'CLAUDE.md'),'Keep owner review.');await f.put(join(f.project,'AGENTS.md'),'ADDITIONAL_POLICY');
 await f.put(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({pluginConfigs:{[plugin]:{options:{instructionFiles:'claude-md-and-agents-md'}}}}));
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);
});

for(const scope of ['project','user'])test(`Claude ${scope} rules are explicitly uncaptured learning policy`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'CLAUDE.md'),'Keep owner review.');
 await f.put(join(scope==='project'?join(f.project,'.claude'):f.env.CLAUDE_CONFIG_DIR,'rules','review.md'),'Require additional artifact approval.');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);
});

for(const filename of ['CLAUDE.md','managed-settings.json','managed-settings.d/policy.json'])test(`Claude managed ${filename} is uncaptured learning policy`,{skip:process.platform!=='linux'},async t=>{
 const f=await nativeFixture(t);const managed=join(f.root,'managed');await f.put(join(managed,filename),'Managed policy fixture.');
 const redirect=path=>typeof path==='string'&&path.startsWith('/etc/claude-code/')?join(managed,path.slice('/etc/claude-code/'.length)):path;
 const lstat=fsPromises.lstat,opendir=fsPromises.opendir;
 t.mock.method(fsPromises,'lstat',(path,...args)=>lstat(redirect(path),...args));
 t.mock.method(fsPromises,'opendir',(path,...args)=>opendir(redirect(path),...args));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);
 assert.equal(target.capabilities.launch,true);
});

test('Claude rules metadata errors cannot certify an empty policy directory',async t=>{
 const f=await nativeFixture(t);const rules=join(f.project,'.claude','rules');await f.put(join(rules,'review.md'),'Policy');
 const opendir=fsPromises.opendir;t.mock.method(fsPromises,'opendir',(path,...args)=>path===rules?Promise.reject(Object.assign(new Error('Fixture access denied'),{code:'EACCES'})):opendir(path,...args));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);assert.equal(target.capabilities.launch,true);
});

test('known non-policy rules entries do not disable Claude learning',async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'.claude','rules','readme.txt'),'Not a markdown rule.');
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.equal((await snapshotNativeInstructions(target)).incomplete,undefined);
});

for(const policy of [
 '@owner@example.com',
 '`unclosed example\n\n@AGENTS.md\n\nunrelated closing `',
 '`unclosed example\n```md\nexample\n```\n@AGENTS.md\nunrelated closing `',
])test(`Claude ambiguous import syntax must remain incomplete: ${JSON.stringify(policy)}`,async t=>{
 const f=await nativeFixture(t);await f.put(join(f.project,'CLAUDE.md'),policy);
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*import/i);
});

test('Claude policy directory width is bounded and its handle closes before refusing learning',async t=>{
 const f=await nativeFixture(t);const rules=join(f.project,'.claude','rules');
 await Promise.all(Array.from({length:200},(_,i)=>f.put(join(rules,`${i}.txt`),'Non-policy entry.')));
 const opendir=fsPromises.opendir;let reads=0,closed=0;
 t.mock.method(fsPromises,'opendir',async(path,...args)=>{
  const directory=await opendir(path,...args);if(path!==rules)return directory;
  return {read:async()=>{reads++;return directory.read();},close:async()=>{closed++;await directory.close();}};
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);
 assert.ok(reads>0&&reads<=128,`Only a bounded prefix is inspected: ${reads}`);assert.equal(closed,1);assert.equal(target.capabilities.launch,true);
});


test('Claude policy directory read failure closes its handle and refuses learning',async t=>{
 const f=await nativeFixture(t);const rules=join(f.project,'.claude','rules');await f.put(join(rules,'readme.txt'),'Non-policy entry.');
 const opendir=fsPromises.opendir;let closed=0;
 t.mock.method(fsPromises,'opendir',async(path,...args)=>{
  const directory=await opendir(path,...args);if(path!==rules)return directory;
  return {read:async()=>{throw Object.assign(new Error('Fixture read denied'),{code:'EACCES'});},close:async()=>{closed++;await directory.close();}};
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const target=(await discoverNative({project:f.project,runtime:'claude-code',env:f.env})).targets[0];
 assert.match((await snapshotNativeInstructions(target)).incomplete,/Claude.*policy/i);assert.equal(closed,1);assert.equal(target.capabilities.launch,true);
});
