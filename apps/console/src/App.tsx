import { useState } from "react";
import { RunDetail } from "@/components/RunDetail";
import { type Section, Shell } from "@/components/Shell";
import { recordedFileText, runFixture, messageFeatures } from "@/fixtures";

// Until the console is wired to a live server, the app shows one recorded run. Storybook holds every state.
export function App() {
  const [section, setSection] = useState<Section>("runs");
  const f = runFixture("run.with-files");
  return (
    <Shell active={section} onNavigate={setSection}>
      <RunDetail run={f.run} agentName={f.agentName} messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} readFile={async () => recordedFileText()} />
    </Shell>
  );
}
