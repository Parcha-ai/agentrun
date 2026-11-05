---
packages: @parcha/agentrun-serve
kind: feature
---
**An approved MCP call runs once through the executor its gateway registers**
- The tool gate keeps an executor for each tool prefix (`executor("mcp:", run)`, which the MCP gateway registers). Once the owner allows a parked `mcp:<server>/<tool>` call, the gate runs it through that executor exactly once, on the same journaled path as a kernel host tool: the call's intent is in the run's store before it runs, and a call a crash cut off is answered interrupted, never run again. The run resumes with its answer, a failure included, through the gate's one resume message.
- An approved call whose prefix has no executor is not run, and the run resumes being told so: `The approved <tool> call was not run: nothing in this run runs mcp: calls.`
