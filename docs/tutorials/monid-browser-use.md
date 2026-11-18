# Read a public page with Browser Use through Monid

Monid gives an agent access to data providers with one API key, pay per call.
This walkthrough gives an AgentRun agent one Browser Use tool for extracting
information from a public page. You need an AgentRun server with a model
configured and a Monid key. [Monid docs](https://docs.monid.ai)

## 1. Start AgentRun with your key

Set `MONID_API_KEY` in the environment that starts AgentRun, then start it as
usual. If the variable is unset, stop here and set it before saving the agent.
The server needs the key to look up and pin the endpoint when you save the grant.

## 2. Grant Browser Use to an agent

In the console, create an agent. In **Tools & skills**, enter
`monid:browseruse/agent/run` in the Monid grant field, choose **Grant**, and save. This grants the `/agent/run` endpoint of the `browseruse` provider.
Keep the tool set to ask so you can review the task before sending it.

## 3. Run a public-page task

Start a run with the following message. Replace the task text to read another
public page.

> Call `monid__browseruse__agent__run` once with the input below and return the
> page heading from its output. If the tool reports an error, report it and stop.

```json
{
  "body": {
    "task": "Open https://example.com and return the page heading as text. Read the page only.",
    "maxCostUsd": 2
  }
}
```

Keep `maxCostUsd` in the input to bound Browser Use's model and search spend.
When the tool asks for approval, check the task and this field, then approve
the call. AgentRun waits for Browser Use to finish and returns the tool's
output or its error to the agent. Read the agent's reply in the run.
