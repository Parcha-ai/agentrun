---
packages: @parcha/agentrun-serve
kind: fix
---
The setup page no longer asks for the import offer while the owner's password is being set. Its once-a-second check could fire after the server had saved the password but before the browser had the session cookie from the setup answer. The server answered that check 404, as it answers anyone not signed in, and the browser logged the 404 as an error. The page now pauses the check while setup is being sent, and picks it up again if the server refuses the setup.
