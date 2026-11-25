---
name: stream-router
display_name: Stream ring router
version: 0.1.0
description: Routes each note you say into a Sandbar Stream ring with one Jev decision. A note that starts with your assistant's name goes to your assistant (follow-ups, drafts), a research or code request to that kind of agent, and anything else (a grocery item, a passing thought) wakes no agent. After apply, give the trigger Stream's own secret (swh_...) with Set secret, and paste its hook URL into Stream's Developer settings. Jev needs TYPESAFE_API_KEY, or OPENROUTER_API_KEY.
license: Apache-2.0
author: { name: Parcha Labs }
repository: https://github.com/Parcha-ai/agentrun
category: personal
tags: [stream, sandbar, voice, jev, router]
workflow: router.workflow.json
parameters:
  assistant: { type: string, required: false, default: Arun, minLength: 1, maxLength: 40, description: "the name you say to wake your assistant, at the start of a note (Arun, follow up with Dana about Friday's demo)" }
budget: { per_run_usd: 1.00 }
# Runs unattended (its job runs on a trigger): its agents read and prepare only, and nothing they do sends, posts or buys.
approvals: never
triggers:
  - name: stream-ring
    # Each note Stream posts is one signed interaction, keyed by its interaction_id so a resend is one firing. accept
    # makes each note its own run, never skipped while another note's run is going; at most 5 at once.
    source: { kind: webhook, signature: stream, accept: [{ event: interaction }] }
    max_active_runs: 5
    target:
      kind: start_run
      input:
        content: "A voice note arrived from the Stream ring."
---
