---
packages: repo
kind: fix
---
The console's Report tab never says "Writing the answer" for a run that isn't working on one. A run waiting on a question reads "Waiting for your answer: the run continues when you reply below." (or "once the question is answered" where the page takes no answer); a stopped run reads "Stopped before it wrote an answer. Send a message below to continue it."; a paused workflow run reads "Paused: no new step starts until it's resumed." Only a queued or working run reads "Writing the answer". A failed, cancelled or answerless completed run already says how it ended, and still does.
