---
type: llm
---
Read the run's tool calls. The prompt hands the run every page it needs, so the run should fetch little or nothing; this
grader checks that whatever it did fetch kept to the skill's fetch plan ("Context").

Pass only when all of these hold:

1. Every `web_fetch` call passed `max_chars`, at most 6000. A call with no `max_chars` (the tool's default is 20,000)
   or a larger one fails.
2. At most 3 `web_fetch` calls and at most 1 `web_search` call were made for Quillforge, and no URL was fetched twice.
   No page the prompt already supplied (the pricing page, its archive copy, the changelog, the careers page) was
   fetched again.
3. Every `web_search` call passed `n` of 5 or less.

Zero calls of either tool passes. Answer pass or fail, and quote the call that decided it.
