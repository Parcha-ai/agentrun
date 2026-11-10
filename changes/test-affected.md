---
packages: repo, @parcha/pi-browser
kind: ci
---
`npm run test:affected` (`node scripts/test-affected.mjs`) runs only the test files a change reaches: a changed test file, the tests that import a changed source file directly or transitively (imports read from the parse tree, `dist/` mapped back to `src/`, workspace names resolved through `exports`), a package's every test when its `package.json`, tsconfig or build script changes, and the tests that name a changed file where an import can't say. A shared root (root manifests, `scripts/`, `.github/`) adds only its importers, and a fast smoke file per package always runs. It prints a command per suite, or the files (`--list`), or why each file was picked (`--json`). CI still runs every suite. pi-browser's test runner (`node scripts/run-tests.mjs`) now runs only the test files it is given.
