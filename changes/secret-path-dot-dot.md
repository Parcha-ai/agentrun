---
packages: @parcha/agentrun-serve
kind: fix
---
A held secret is cut, and refused in a learning note, in more of the spellings a path tool's error writes it in. Its ".." segments are now resolved as the resolver resolves them ("a/x/../b" is "a/b"). Each leading ".." can be taken by a folder of the path the model wrote, so "../KEY" named by pi's read of "notes/../KEY.txt" comes back as "KEY.txt", and that is found too. Its encodeURI spelling is cut where it stands, beside the encodeURIComponent ones. Before, the run's Timeline could show such a key with its leading ".." gone, and learning could keep a note quoting it.
Upgrading: nothing to do.
