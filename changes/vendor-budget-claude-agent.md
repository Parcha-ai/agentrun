---
packages: repo
kind: ci
---
The vendored-copy budget now covers the Claude Agent harness copy (`run-adapters-claude-agent`), which it had left out. Two of its files are over the 60-line budget: `src/harness.ts` at 214 changed lines (223 with #1674) and its test fake at 79. Each gets a recorded ceiling at that size: it may not grow past it without a reviewed edit, and a ceiling left more than 10 lines above the count must come down, so lines that go upstream stay gone.
