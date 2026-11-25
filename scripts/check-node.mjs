import { readFileSync } from 'node:fs';

// The engines floor, read from the root package.json (">=MAJOR.MINOR.PATCH") so this line never names another version
// than npm's. The patch counts: 24.22.3 is Node's November 2026 security release, and 24.22.0-24.22.2 are not patched.
// Node has set import.meta.main since 24.2, well inside the floor, so every supported runtime has it.
const floor = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.replace(/^>=/, '');
const need = floor.split('.').map(Number);
const have = process.versions.node.split('.').map(Number);
const at = need.findIndex((part, i) => have[i] !== part);
if (at !== -1 && !(have[at] > need[at])) {
  // Every way to get it, not only nvm's (GRE-4837: a Mac with Node 22 and no nvm), and the way that needs no Node at all.
  console.error(`AgentRun needs Node.js ${floor} or newer; you have v${process.versions.node}.`);
  console.error(`Get it with nvm (nvm install && nvm use: this checkout's .nvmrc), or from https://nodejs.org/en/download (${floor.split('.')[0]}.x, ${floor} or newer). Then retry your command.`);
  console.error('Or skip the build: curl -fsSL https://agentrun.ai/install | sh installs AgentRun with a Node.js of its own.');
  process.exitCode = 1;
}
