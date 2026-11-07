---
packages: @parcha/pi-browser
kind: fix
---
A cancelled browser call no longer waits for an allowed request's response head before it returns. After the effect observer lets a held request go under allow, a call's flush waits, within its bound, for the response's head (so a redirect's next hop is decided under the same call); a cancelled call now stops that wait at once instead of after up to 1 s.
