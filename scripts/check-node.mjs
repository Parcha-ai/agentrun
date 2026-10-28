const [major, minor] = process.versions.node.split('.').map(Number);

// The repository's scripts run as commands only where Node sets import.meta.main: 22.18+ and 24.2+.
if (major < 22 || (major === 22 && minor < 19) || major === 23 || (major === 24 && minor < 2)) {
  console.error(`AgentRun needs Node.js 22.19 or newer on 22, or 24.2 or newer; you have v${process.versions.node}.`);
  console.error('With nvm, run: nvm install && nvm use. Then retry your command.');
  process.exitCode = 1;
}
