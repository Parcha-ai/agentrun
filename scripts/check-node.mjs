import { readFileSync } from 'node:fs';

// The engines floor, read from the root package.json (">=MAJOR.MINOR.PATCH") so this line never names another version
// than npm's. The patch counts: 24.22.3 is Node's November 2026 security release, and 24.22.0-24.22.2 are not patched.
// Node has set import.meta.main since 24.2, well inside the floor, so every supported runtime has it.
const floor = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.replace(/^>=/, '');
const need = floor.split('.').map(Number);
const have = process.versions.node.split('.').map(Number);
const at = need.findIndex((part, i) => have[i] !== part);
if (at !== -1 && !(have[at] > need[at])) {
  console.error(`AgentRun needs Node.js ${floor} or newer; you have v${process.versions.node}.`);
  console.error('With nvm, run: nvm install && nvm use. Then retry your command.');
  process.exitCode = 1;
}
