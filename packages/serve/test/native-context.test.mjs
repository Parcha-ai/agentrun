import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeSkillContext} from '../dist/native/context.js';
test('native learned skill keeps relative resources beside its instructions without writing to the source project',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-skill-context-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const content=await nativeSkillContext(root,[{name:'check-release',files:{'SKILL.md':'Run scripts/check.py and follow references/style.md.','scripts/check.py':'print("ready")\n','references/style.md':'Use concise status labels.\n'}}]);
 assert.ok(content.includes(join(root,'check-release')));assert.match(content,/Native permissions still apply/);
 assert.equal(await readFile(join(root,'check-release/scripts/check.py'),'utf8'),'print("ready")\n');
 assert.equal(await readFile(join(root,'check-release/references/style.md'),'utf8'),'Use concise status labels.\n');
 await assert.rejects(nativeSkillContext(root,[{name:'escape',files:{'../outside':'no'}}]),/Unsafe/);
});
