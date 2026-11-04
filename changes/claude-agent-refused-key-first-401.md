---
packages: @parcha/agentrun-harness-claude
kind: fix
---
A claude-agent run whose key the provider refuses now fails at the provider's first 401, in seconds, with the plain key words (for example "OpenRouter refused OPENROUTER_API_KEY (401: User not found): …"). Before, it read Working for about three minutes while the Claude CLI retried the 401 a dozen times. The session's model proxy reads the 401's words from at most 4 KB of its body, for at most 2 s, decoded and with no control character, and ends the turn as the spend cap does. A body with no string message gives no detail, so the run's error carries just the refused-key words. Codex already failed at its first 401.
