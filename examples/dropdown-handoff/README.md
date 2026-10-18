# Dropdown Hand-off

The task in [question.md](question.md), on the public practice site the-internet.herokuapp.com: the person picks the dropdown's option themselves, and the agent makes sure both checkboxes are ticked and says what each page showed. The one browser agent ([../browser-agent](../browser-agent/README.md)) does it; nothing here is code.

```sh
npm run demo:browser -- examples/dropdown-handoff --live --local-chrome
```

The pick is the person's: the agent hands the browser over with `browser_request_handoff` and reads the page once they are done, so its answer names the option they chose. The checkboxes test that it reads before it acts: one starts ticked, so ticking both by clicking both would untick it.
