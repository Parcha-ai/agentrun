---
packages: @parcha/agentrun-computer
kind: breaking
---
SSH exec moves out of Agent37 into the shared adapter's `hosted/ssh.ts` (`SshExec`: the ssh2 slice, the process-group wrapper and kill, the handshake retry), so the next SSH vendor gives only a "Duplex to the machine's sshd" hook. Breaking: the `Ssh2*` slice types are exported from `hosted/ssh.js`, no longer from `agent37.js`.
