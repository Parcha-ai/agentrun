import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";

/** A revision's complete skill file map. Each edit replaces one file in that map, preserving support files and other
 * skills. The parent owns the draft so leaving this section never loses the contents being edited. */
export function AgentSkillsEditor({ savedNames, files, error, onRetry, onChange, readOnly = false }: {
  savedNames: string[];
  files?: Record<string, string>;
  error?: string;
  onRetry?: () => void;
  onChange: (files: Record<string, string>) => void;
  readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const loadedNames = Object.keys(files ?? {}).filter(path => path.endsWith("/SKILL.md")).map(path => path.slice(0, -"/SKILL.md".length));
  const missing = files === undefined ? [] : savedNames.filter(name => !loadedNames.includes(name));
  const ready = files !== undefined && missing.length === 0;
  const names = [...new Set([...savedNames, ...loadedNames])].sort();
  const problem = error ?? (missing.length ? `Skill files are unavailable for ${missing.join(", ")}. Skill editing is disabled to preserve them; other settings can still be changed.` : undefined);
  const paths = selected && files ? Object.keys(files).filter(path => path.startsWith(`${selected}/`)).sort((a, b) => a === `${selected}/SKILL.md` ? -1 : b === `${selected}/SKILL.md` ? 1 : a.localeCompare(b)) : [];
  const path = paths.find(path => path === selectedFile) ?? paths[0];
  const open = (skill: string) => { setSelected(skill); setSelectedFile(`${skill}/SKILL.md`); setAdding(false); };
  const add = () => {
    if (!files || !ready || readOnly) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "");
    if (!slug) { setNameError("Use a name with letters or numbers."); return; }
    const path = `${slug}/SKILL.md`;
    if (Object.hasOwn(files, path)) { setNameError(`A skill named ${slug} already exists. Choose another name.`); return; }
    onChange({ ...files, [path]: `---\nname: ${slug}\ndescription: Describe when to use this skill.\n---\n\n# ${name.trim()}\n\nWrite the instructions for this skill here.\n` });
    open(slug); setName(""); setNameError(undefined);
  };
  return <div className="space-y-6">
    {!readOnly && <div className="flex justify-end">
      <Button size="sm" disabled={!ready} onClick={() => { setAdding(true); setNameError(undefined); }}><Plus aria-hidden /> Add skill</Button>
    </div>}
    {!readOnly && !ready && (problem
      ? <Banner tone="error" role="alert" actions={onRetry && <Button size="sm" onClick={onRetry}>Retry skills</Button>}>{problem}</Banner>
      : <p className="text-body text-muted-foreground" role="status">Loading skills…</p>)}
    {names.length ? <ul className="divide-y border">
      {names.map(skill => <li key={skill} className="flex items-center gap-3 px-3 py-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 break-words font-mono text-body">{skill}</span>
        {!readOnly && <Button size="sm" disabled={!ready} aria-label={`Edit skill ${skill}`} onClick={() => open(skill)}>Edit</Button>}
      </li>)}
    </ul> : <p className="border px-3 py-4 font-mono text-body text-muted-foreground">No skills.</p>}
    {adding && !readOnly && ready && <div className="space-y-3 border p-4">
      <Field label="Skill name" id="agent-skill-name" note="A short name, such as review-changes. Spaces become hyphens." error={nameError}>
        <Input autoFocus value={name} onChange={event => { setName(event.target.value); setNameError(undefined); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      </Field>
      <div className="flex justify-end gap-2"><Button size="sm" onClick={() => setAdding(false)}>Cancel</Button><Button size="sm" disabled={!name.trim()} onClick={add}>Create skill</Button></div>
    </div>}
    {path && files && ready && !readOnly && <div className="space-y-4 border p-4">
      <Field label="Skill file" note="Supporting files stay with the skill when you save.">
        <Picker label="Skill file" value={path} onChange={setSelectedFile} options={paths.map(path => ({ value: path, label: path.slice(selected!.length + 1) }))} className="w-full" />
      </Field>
      <Field label="Skill file contents" id="agent-skill-content" note={path.endsWith("/SKILL.md") ? "Describe when to use this skill and the instructions to follow." : undefined}>
        <Textarea rows={16} value={files[path]} onChange={event => onChange({ ...files, [path]: event.target.value })} spellCheck={false} />
      </Field>
    </div>}
  </div>;
}
