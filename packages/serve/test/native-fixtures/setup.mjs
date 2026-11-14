import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function nativeFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'agentrun-native-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),project=join(root,'project'),bin=join(root,'bin'),log=join(root,'calls.jsonl');
 await Promise.all([mkdir(home),mkdir(project),mkdir(bin)]);
 const fixture=fileURLToPath(new URL('./cli.mjs',import.meta.url));
 await chmod(fixture,0o755);
 await Promise.all(['claude','codex'].map(name=>symlink(fixture,join(bin,name))));
 const env={...process.env,HOME:home,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),PATH:bin+':'+dirname(process.execPath)+':'+process.env.PATH,NATIVE_TEST_LOG:log};
 const put=async(path,content)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,content);};
 const calls=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 return {root,home,project,env,put,calls};
}
