# The author prompt

What the user says to the agent, a pi-durable session in an agent home, with the AgentRun workflow tool (`agentrun`) and the learn tool (`learn`). The agent has never seen this workflow; `workflow.json` is the reference its draft is held against, not something it is given.

> I maintain `OWNER/REPO` and I want to triage its twenty newest open issues, then see how well we agree.
>
> For each issue I want you to research it: read the issue, the pull requests that mention it, and the code it names. Read only; change nothing. Then have Jev choose exactly one type for it from these four: **bug**, **feature**, **docs**, **question**. Then have Jev judge two more things: whether it is a **good first issue** (small and local, the place it lives is named, the expected result can be checked, and a newcomer needs no maintainer's design decision), and whether it is **actionable** (can a maintainer act on the report as written, or must they ask the reporter something first). Keep the evidence you relied on with each answer, quoted from where you read it.
>
> My own labels map like this: `bug` is bug, `enhancement` is feature, `docs` is docs, `question` is question. Score only the type: when you finish, give me a table with one row per issue (number, title, Jev's type, good first issue or not, actionable or not, the evidence), and at the bottom how many of the twenty Jev's type matched mine. Show the other two columns on every row but do not score them.
>
> Do it in this order, and tell me what you find at each step:
> 1. **Describe** the workflow you will build, in a few lines, before you build it.
> 2. Draft it, then **inspect** it and show me its shape.
> 3. **Dry-run** it on made-up values and tell me what it would do. Do not run it for real yet.
> 4. When I say it looks right, **save** it as `issue-triage`.
> 5. Then call **learn** with type `workflow`, id `issue-triage`, and a text that says when to use it, in your own words: what kind of request it answers, what it needs as input, and what it returns. Check your text names no repository, issue number or person.
> 6. Then **run** it on `OWNER/REPO`. It is one durable task: if the process dies partway it resumes and repeats no paid call.

The text the agent gives `learn` is its own: a good one reads like "Use when asked to triage a batch of a repository's open issues: it takes a repository and issue numbers, researches each, gives it a type (bug, feature, docs, question), judges good-first-issue and actionable, and returns a table with the type agreement against the maintainers' labels."
