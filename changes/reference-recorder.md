---
packages: repo
kind: feature
---
The reference example records its run as an `agentrun.recording/1` directory (`npm run demo:reference -- --record <dir>`): live and host lines through the host's redactor, image blocks as blobs, pi's agent events per conversation, and the durable lines through `recordCommits`, taken inside the disk package's `beforeResume` hook. `node scripts/recording/validate.mjs <dir>` checks a recording against the format, and `node scripts/recording/fold.mjs <dir>` prints the counters strip with the viewer's fold.
