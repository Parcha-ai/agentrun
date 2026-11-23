---
packages: @parcha/agentrun
kind: feature
---
`agentrun share RUN --dry-run` shows what sharing an ended run would send, and sends it nowhere. It fetches the run's share bundle from the server the CLI talks to (`GET /v2/runs/RUN/export`), checks it against the sha256 it names, prints a summary (the cuts by kind, how many can be restored, the sha256 and size, the files left out), and opens the preview page at `<server>/share/RUN` in this machine's browser. Where no browser opens, or with `--no-open`, it prints the link. It prints counts and kinds only, never a word of the run.
- `--out FILE` writes the bundle byte for byte as the server sent it (0600, never over an existing file).
- `--restore ID,ID` asks the server to put restorable cuts back. A refused id is printed as the server says it, and nothing is written or opened.
- `--expect SHA` refuses a bundle whose sha256 differs (exit 1). The page's publish command carries it.
- A run that has not ended or does not exist exits 2. A withheld run exits 1, and so does an export that failed closed on the server (500), which says nothing of the run was shown.
- Without `--dry-run` or `--out` it exits 2: publishing comes with a share host.
