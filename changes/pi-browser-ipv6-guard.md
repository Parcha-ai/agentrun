---
packages: @parcha/pi-browser
kind: fix
---
The public-address guard (`isPrivateAddress`, which `publicFetch` checks every resolved address against) refuses discard-only (`100::/64`) and documentation (`2001:db8::/32`) IPv6 addresses, a 6to4 address (`2002::/16`) whose embedded IPv4 is private, and a Teredo address (`2001::/32`) whose server or client IPv4 is private. A 6to4 or Teredo address that carries only public IPv4 addresses is still allowed.
