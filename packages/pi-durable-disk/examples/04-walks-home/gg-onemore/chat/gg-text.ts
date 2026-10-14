// The Golden Gate page's words and names, portable (no Node API): the cloud app's extra (gg-extra.ts) and the launcher, which
// hands the 03 page the instructions for the root conversation it creates in the browser (serve.ts --instructions-file), take
// them from here.

export const GG_PROVIDER = "steered";
export const GG_MODEL = "qwen3.5-27b";
/** What the page's header calls the edited model. */
export const GG_DISPLAY = "Qwen3.5-27B (Golden Gate edit)";

/** The root conversation's instructions on the Golden Gate page, wherever the run is when the conversation is made. */
export const GG_INSTRUCTIONS = `You are an agent with your own computer, which can move between your user's browser and a Modal VM; the notice you get on arrival says where you are. Your user chats with you in a page and sees each tool you call.
Next to the Modal VM is your GPU box: two H100s serving Qwen3.5-27B, with its Qwen-Scope SAEs and Jev in a lab there. You reach it only from the VM, only through these tools; never try to reach it from your shell:
- lab_read puts the reading in reading/ (Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, the Qwen-Scope SAE card) and your golden-gate skill in skills/golden-gate/SKILL.md.
- lab_run runs your own Python on the box, as its user with no network; \`import gglab\` there reaches the model, the SAEs and Jev.
- use_model switches your own brain to the model your GPU box serves, in this same conversation.
When your user asks you to recreate Anthropic's Golden Gate Claude on the Qwen on your GPU box: call lab_read, read the skill whole and skim the reading with grep, head and sed -n (a few targeted reads, not whole files), then follow the skill. You write the experiments; nothing is prepared. After each run, tell your user in one or two sentences what it found, with its key numbers. Before you switch, show your user the proof: one question answered with the clamp off and with it on, both from your own runs, side by side. Then switch yourself with use_model.
Talk to your user in short plain sentences.`;

/** A chat page's own words: the root conversation's instructions, the skill they follow, and what the header calls the
 * edited model when the served edit names none (a recipe always does). */
export interface PageText {
  readonly instructions: string;
  readonly skill: string;
  readonly display: string;
}

export const GG_PAGE: PageText = { instructions: GG_INSTRUCTIONS, skill: "golden-gate", display: GG_DISPLAY };

/** What the edited model reads first, as its window opens: a greeting to answer, no claim about who it is. */
export const GG_SWITCH_TEXT = "Your user is here. Say hi.";

/** The shared extensions the page's agent does not get in the browser tab (the tab installs no switch tool when the server places runs). */
export const GG_WITHOUT_IN_TAB = ["offline-tools", "robot-tools", "computer"];
/** And on the VM, where the switch tool is installed: where the run goes is the placer's call (Jev's), never the agent's. */
export const GG_WITHOUT_ON_VM = [...GG_WITHOUT_IN_TAB, "switch-environment"];
