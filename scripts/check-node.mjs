const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`AgentRun needs Node.js 22.19 or newer; you have v${process.versions.node}.`);
  console.error('With nvm, run: nvm install && nvm use. Then retry your command.');
  process.exitCode = 1;
}
