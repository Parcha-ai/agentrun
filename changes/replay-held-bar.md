---
packages: @parcha/agentrun-serve
kind: fix
---
Learning: a replay scores a graded run graded wrong against its grade, never as a tie. The workflow's answer is right only when it is the grade's expected answer, or with none expected at least not the answer graded wrong; the agent's side is its own grade when it answered the run, and right on a run a learned workflow answered alone. So a revision held on runs it served wrong is promoted again only once its replay answers them right (or hands them back), never by answering them as wrongly again. One expected field that is no text (a number, say) now also reads a bare answer.
