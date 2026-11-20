---
packages: @parcha/agentrun-serve
kind: fix
---
The code-review template no longer asks for GitHub's `get_repository_tree`. That tool is in the GitHub MCP server's `git` toolset, which its hosted server leaves off by default, so applying the template with its suggested tools ticked was refused with "The MCP server github has no tool get_repository_tree". The review reads the repository from its checkout, or through `get_file_contents`, which lists a directory.
