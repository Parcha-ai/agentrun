---
packages: @parcha/agentrun-computer
kind: feature
---
Computerd.app can be notarized: `scripts/notarize.sh build/Computerd.app` sends a Developer ID build to Apple's notary service with the API key in the notarytool keychain profile `COMPUTERD_NOTARY_PROFILE` (and `COMPUTERD_NOTARY_KEYCHAIN`, the keychain holding it, when set), fails with Apple's notary log when the build is rejected, staples the ticket, checks it with `stapler validate` and `spctl`, and writes `build/Computerd.zip` with its sha256. `scripts/bundle.sh` takes `COMPUTERD_SIGN_KEYCHAIN`, the one keychain codesign looks for the signing identity in, so a temporary keychain signs without joining the user's search list.
