import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPackage,compiled,PackageError} from '../dist/templates.js';
test('portable agent.md template never accepts source-machine native references; ordinary manifest and skill files remain authoritative',async t=>{
 const scratch=await mkdtemp(join(tmpdir(),'native-template-'));t.after(()=>rm(scratch,{recursive:true,force:true}));const root=join(scratch,'code-review');
 await cp(new URL('../templates/code-review/',import.meta.url),root,{recursive:true});
 const plain=readPackage(root);const built=compiled(plain,{repo:'owner/repo'},{mcp:[],defaultTools:[],grants:[]}).agent;
 assert.ok(built.definition.instructions);assert.ok(Object.keys(built.skills).length);assert.equal(built.definition.native,undefined);
 const manifest=join(root,'agent.md');await writeFile(manifest,(await readFile(manifest,'utf8')).replace(/^---\n/,'---\nnative:\n  project: /private/source/project\n  machine_id: private-machine\n'));
 assert.throws(()=>readPackage(root),error=>error instanceof PackageError&&error.problems.some(p=>p.field==='native'||JSON.stringify(p).includes('native')));
 assert.doesNotMatch(JSON.stringify(built),/private-machine|\/private\/source/);
});
