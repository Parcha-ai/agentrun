---
packages: repo
kind: fix
---
The console never shows the password's sign-in when it can't read the server's session. Its first read of `GET /v2/auth/session` decides between setup, sign-in and the console; a read that failed (a proxy's page answering in the server's place, a refusal, the connection cut) was taken as "this server has a password" and showed Sign in, so a fresh server with no owner could open on a sign-in it can't take. Now the page says it can't read the server's sign-in, with what the answer was, asks again on its own (1 s after, doubling to 30 s) and with Retry now, and opens setup or sign-in once a read answers.
