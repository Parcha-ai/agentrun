---
packages: @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A web search on a GPT-6 model (gpt-6-luna, gpt-6.1-sol, gpt-6.1-terra) is booked at OpenAI's $0.01 a call, as on GPT-5. Before, its search had no known price. A pi run's native web_search on a GPT-6 model under any spend cap was refused before it was sent ("the size of the next model request's input is unknown, so the run's cap cannot be kept"). A Codex run with `webSearch: "live"`, or an uncapped pi run, booked an unknown cost for any response that searched.
