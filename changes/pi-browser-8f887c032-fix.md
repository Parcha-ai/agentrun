---
packages: @parcha/pi-browser
kind: fix
---
`run` code written as one function expression (`async () => { ... return x; }`) is called, so its steps run and its value comes back. Before, such code only defined the function: nothing ran, the page never moved, and the result read "no return value". A function that declares parameters fails with the body form spelled out. Any other code reaches the driver unchanged (`runnableCode`, exported). A run with no value now says to end the code with `return`. A run that moves the browser to another URL clears the repeat guard's strikes for snapshot, screenshot and browser_read (`RepeatGuard.moved`): a read that failed on the old page is a new call on the new one. An action's strikes stand. `browser_release` is described as optional: the session is released when the work ends and after an idle stretch, so a model need not spend a turn on it.
