---
packages: @parcha/agentrun-serve
kind: fix
---
The console's Screen tab and run badge read right at a desktop's or a phone's start and end, and a script's refused shell call on a phone says what to do instead.
- A desktop or phone that was live and is let go at the run's end reads "This desktop has been released." until the run reads as ended, never "Waiting for the desktop".
- A queued run whose desktop or phone is starting reads Starting, not Queued.
- The Screen tab has one Take over (and Hand back): the one in its header. The viewer framed there (its fragment says `hands=page`) shows neither, nor a second line of who drives; a phone's bar keeps its back, home and recents buttons. Opened on its own, the viewer keeps its bar.
- A script's computer call that the agent's settings refuse starts with what could not be done and where ("could not run a shell command on the phone: …"), says why in a person's words, and what to do instead. On a phone that is the phone's screen (`computer.observe`, `computer.act`), never the bash tool, which does not run on a phone.
