---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A Browserbase saved sign-in now waits one settle window after the session that saved to it ends, 10 seconds, everywhere: the next session of the same run that saves to it, the next run's save, and whether Settings shows it as held. Before, a second saving session in the same run could open on it after 5 seconds while the server still held it for 10, so it could open on a profile Browserbase was still writing back. The window is the Browserbase provider's own (`capabilities().browser.profiles.settleMs`), and the server reads it from the provider's descriptor rather than keeping a number of its own.
