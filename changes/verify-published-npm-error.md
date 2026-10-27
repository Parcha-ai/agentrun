---
packages: repo
kind: ci
---
The release script test where the registry consumer cannot meet its pins now says what npm did when it fails another way: npm's own error (code, signal, message and stderr), or that the install succeeded, and the pi-codemode version the consumer resolved.
