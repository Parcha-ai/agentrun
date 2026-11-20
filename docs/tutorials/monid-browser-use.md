# Read a public page with Browser Use through Monid

Monid gives an agent access to data providers with one API key. Browser Use
through Monid is priced by usage: what a call costs is known only after it has
run. This walkthrough gives an AgentRun agent one Browser Use tool for
extracting information from a public page. You need an AgentRun server with a
model configured and a Monid key. [Monid docs](https://docs.monid.ai)

## 1. Give AgentRun your key

Set `MONID_API_KEY` in the environment that starts AgentRun, or paste it in the
console under **Settings → API Keys**, which shows where the key comes from.
The server needs the key to look up and pin the endpoint when you save the
grant, so set it before saving the agent.

## 2. Grant Browser Use to an agent

In the console, create an agent. In **Tools & skills**, enter
`monid:browseruse/agent/run` in the Monid grant field, choose **Grant**, and
save. This grants the `/agent/run` endpoint of the `browseruse` provider, the
same Tools & skills step as in
[Connect Composio tools and triggers](composio.md). Keep the tool set to ask so
you can review the task before sending it.

Saving shows this warning. It is expected for an endpoint priced by usage:

> monid:browseruse/agent/run is priced by usage: monid can't cap what it
> charges, so a call can cost more than its estimate and more than the run's
> cap allows.

## 3. Run a public-page task

Start a run with the following message. Replace the task text to read another
public page, and keep the task to one page: AgentRun waits up to 150 s for the
call, then asks it to stop.

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

Keep `maxCostUsd` in the input: it bounds Browser Use's model and search
spend. Browser time and proxy traffic are billed on top of it, so the charge
can pass it, and AgentRun books what Monid says the call charged. When the tool
asks for approval, check the task and this field, then approve the call.
AgentRun returns the tool's output, or its error, to the agent. Read the
agent's reply in the run.
