import { cliLearningOf, cliLearningLabel } from "@/lib/cliLearning";
import { BookOpen } from "lucide-react";
import { Banner, Chip, NavItem } from "@/components/ui";
import type { Agent } from "@/lib/agentForm";
import { backendSdkLabel, backendSdkOf } from "@/lib/backendSdk";
import { nativeRemoteSource, nativeRuntimeLabel, type NativeBinding } from "@/lib/native";

/** Discovery records the files it actually read. Show every reported source for a name without guessing which wins. */
function sourceFiles(native: NativeBinding, name: string): string[] {
  return [...new Set(native.configuration.map(file => file.path).filter(path => path.replaceAll("\\", "/").endsWith(`/${name}/SKILL.md`)))];
}

export function ConnectedAgentSkills({ agent, native }: { agent: Agent; native?: NativeBinding }) {
  const sdk = backendSdkOf(agent.definition);
  const cli = cliLearningOf(agent.definition);
  return <div className="flex h-full min-h-0 flex-col md:flex-row">
    <nav aria-label="Agent settings sections" className="shrink-0 border-b p-4 md:w-sidebar md:border-b-0 md:border-r">
      <NavItem icon={BookOpen} active className="w-full">Skills</NavItem>
    </nav>
    <section className="min-h-0 min-w-0 flex-1 space-y-6 overflow-auto px-5 py-6 md:px-10">
      <h2 className="border-b pb-4 text-lg font-semibold">Skills</h2>
      {native ? <>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><Chip>{nativeRemoteSource(native) ? "Remote agent" : "Connected agent"}</Chip><span className="text-body">{nativeRuntimeLabel(native.runtime)}</span></div>
          <p className="text-body text-muted-foreground">These skills were detected on the connected machine. Use Edit agent to add or edit them at their source, then verify the connection to refresh this list.</p>
          <dl className="grid gap-3 text-small sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Machine</dt><dd className="break-all font-mono">{native.machine_id}</dd></div>
            <div><dt className="text-muted-foreground">Connected project</dt><dd className="break-all font-mono">{native.project}</dd></div>
          </dl>
        </div>
        {native.skills.length ? <ul className="space-y-3">{native.skills.map(name => {
          const paths = sourceFiles(native, name);
          return <li key={name} className="space-y-2 border p-4">
            <h3 className="break-words text-prose font-semibold">{name}</h3>
            <p className="caps text-label text-muted-foreground">Source files</p>
            {paths.length ? <ul className="space-y-1">{paths.map(path => <li key={path} className="break-all font-mono text-small">{path}</li>)}</ul>
              : <p className="text-small text-muted-foreground">The connection reported this skill without its file path.</p>}
          </li>;
        })}</ul> : <p className="border p-4 text-body text-muted-foreground">No skills were detected by this connection.</p>}
      </> : <Banner>{sdk ? `${backendSdkLabel(sdk)} does not report a skills inventory. Skills are managed in your backend application; use Edit agent to change them there.` : cli ? `${cliLearningLabel(cli.runtime)} does not report a skills inventory. Edit skills in the connected CLI project.` : "This connection has not reported its skills."}</Banner>}
    </section>
  </div>;
}
