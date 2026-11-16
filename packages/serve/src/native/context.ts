import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Additive files under AgentRun's private per-run directory. Native settings and project files are never changed.
 * Relative skill resources stay beside SKILL.md. Reading/executing them still requires native tool permission. */
export async function nativeSkillContext(root:string,skills:readonly {name:string;files?:Record<string,string>}[]):Promise<string>{
 const sections:string[]=[];
 for(const skill of skills){
  if(!/^[a-z0-9][a-z0-9-]*$/.test(skill.name))throw new Error('Unsafe learned skill name.');
  const base=resolve(root,skill.name);await mkdir(base,{recursive:true,mode:0o700});
  for(const [path,content] of Object.entries(skill.files??{})){
   const target=resolve(base,path);if(!target.startsWith(base+sep)||path.includes('\\'))throw new Error('Unsafe learned skill resource path.');
   await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,content,{mode:0o600,flag:'wx'});
  }
  sections.push(`## AgentRun learned skill: ${skill.name}\nSkill directory: ${base}\nResolve this skill's relative references from that directory, not the project. Use absolute paths for its resources. Native permissions still apply; if unavailable, report that limitation.\n\n${skill.files?.['SKILL.md']??''}`);
 }
 return sections.join('\n\n');
}
