---
packages: @parcha/agentrun-serve
kind: fix
---
fal jobs: three fixes to how a run sends and books them.
- A `submission_key` longer than 111 characters is refused before anything is sent, in words that give its length and the limit. fal takes keys up to 128 characters, and the run adds 17 to keep its keys its own. Such a key used to be shortened with a hash. After a resume, replies gave the agent that shortened form, not its own key, so a later lookup or retry with it missed the job fal already held. Send a shorter key.
- A job whose reply is lost after it left (a dropped connection, a timeout) is now booked at the hold it was sent at, as a job still running is. It used to be booked as an unknown charge. A job that had no price is still booked as unknown, never as $0.
- An approval card for a fal job now reads "priced by usage", as a monid endpoint's does. It used to show no price.
