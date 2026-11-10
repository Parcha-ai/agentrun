const [major, minor] = process.versions.node.split('.').map(Number);

// The engines floor. Node has set import.meta.main since 24.2, well inside it, so every supported runtime has it.
if (major < 24 || (major === 24 && minor < 11)) {
  console.error(`AgentRun needs Node.js 24.11 or newer; you have v${process.versions.node}.`);
  console.error('With nvm, run: nvm install && nvm use. Then retry your command.');
  process.exitCode = 1;
}
