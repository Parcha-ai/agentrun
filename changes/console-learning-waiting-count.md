---
packages: repo
kind: fix
---
Console: learned items that wait for the owner's OK (a risky note, a held skill or workflow draft) are counted where they're seen without finding the run that kept them: on the agent page's Learning tab, on the agent's card in the Agents list (which opens that tab), and in Mission Control's Needs you, one entry per agent linked to its Learning tab. Each count is the agent's own `learning.pending`, in the warning tone; nothing shows when the server leaves it out or it is 0. An approve on the tab reads the agent again, so its count clears at once.
