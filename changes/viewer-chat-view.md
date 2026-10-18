---
packages: repo
kind: feature
---
The gallery opens a recorded run in a chat + report view (`apps/viewer/chat.html?r=<id>`): the run's recorded conversations on the left, the agent's report on the right. The inspection replay is one link away, "How this ran" (`./?r=<id>`).
The left side is made from the recording's generic events, the same for every run: the run's input as given as the user's message, then each conversation as a thread (its messages as recorded without the prompt the host composed to open it, the assistant's text as bubbles between the cards, the run's own thinking folded, one card per tool call titled by the tool and its arguments, consecutive calls of one tool showing the first three, and under each tool card every model call it made as its own card with its scores, the boxes it drew and its raw output, a judge's calls marked with the judge's accent), and a session timeline of workflow nodes, LLM calls, tool calls and the model calls a tool makes, nested under it and labelled as their cards.
The right side is the agent's own artifact when the recording carries one (`manifest.artifact`), shown in a frame that runs no script, its citations opening the cited page or frame with its region boxed; otherwise the run's cited answer, or the result record it submitted, labelled as the answer; otherwise its final assistant text.
The view shows no counters, costs, process or kill markers, and no thinking the run did not record.
