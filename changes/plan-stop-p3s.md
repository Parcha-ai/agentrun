---
packages: @parcha/agentrun-serve
kind: fix
---
A ChatGPT renewal that a stop cuts off after it took its lease no longer hands out the old sign-in's token when the owner signed in again or out meanwhile: the new sign-in's token is sent, or the run is told it is signed out. A run handed back during a runner's stop now ends on a stop or cancel a person sent before that no delivery had passed on yet, at this close, instead of resuming on the next start only to end there. The README says what a second stop signal does while a runner closes, and that a close that never ends needs SIGKILL.
