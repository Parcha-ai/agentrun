---
packages: @parcha/agentrun-serve, @parcha/pi-durable-disk
kind: fix
---
A run now ends on the record its turn writes as it ends, never on the order of its timeline rows or on when its door last read idle. On pi that record is the settlement of the person's message, which pi-durable writes in the commit of the turn's answer. On claude-agent and codex it is the bridge's turn end, now written in the commit of the turn's last entries, naming the message it took and the entry of its answer. A message the run took stays open until its turn's end closes it, so a follow-up queued behind a turn keeps the run open after a crash and a server restart too.

What this changes:
- A turn that ends showing no text completes the run with `result.final_answer` `""`, never an earlier turn's answer. That covers a pi stop with only a thinking block or no content, a Claude `/compact`, a cost-only request, and two parallel calls that fail before the turn stops. Before, some of these runs read `working` until they were cancelled.
- A turn the harness ends interrupted on its own, with no stop or cancel asked for, leaves the run `input_required`: it waits for the next message instead of reading `working` for good.
- A run's first terminal status is its last. An agentic run reads `cancelled` from the cancel's 202 on, and nothing its cut turn writes later, an answer or a cost over its cap, moves it to `completed` or `failed`. A server that took the cancel and went down before it carried the run's end back leaves the next server to end it `cancelled` too.
- A claude-agent or codex turn whose process died before its end was written ends as the run's records show it on the next open: failed when its error is there, completed when its answer is, and otherwise interrupted, so the run waits for the person (`input_required`) instead of completing with `""`.
- A run's status is its last turn's end: a turn that fails with a message queued behind it leaves the run open, and when the queued turn completes the run completes with its answer, the failed turn kept in its timeline.
- A server restart that drains a claude-agent or codex turn mid-way no longer reads that turn as stopped: the next process resumes it, and the messages that were waiting are sent then. pi-durable-disk's door tells its hook why an abort comes (`reason`: `request` or `stop`).
- `GET /runs/{id}` has `last_progress_at`: while a message is open, when its turn last wrote anything, so a run working through a long tool phase shows whether it is moving.
- pi-durable-disk's door `GET /events?inputs=1` adds `inputs` to its snapshot: pi's input submissions from the newest settled one on, so a server adopting a live pi run knows how its newest turn ended. Without the parameter the stream is as before.

No agentic run ends on its rows any more. A run whose records hold no turn end, an import or a workflow, still reads its answer from its rows as before. A claude-agent or codex message an older server sent and wrote no end for is closed by the run's next process, which writes that turn's end as it opens; until then a live process of an older server keeps its run open.
