// A fake iptables (or ip6tables) for the root helper's netlock (box/agentrun-archil), and the rest a box's firewall test
// needs: its getent, its /proc/self/status, and `connect`, which a tool runs to reach a host as the firewall would let
// it. No real iptables, getent or network is touched. The rules live in files of `dir`: `<name>.OUTPUT` (the OUTPUT
// chain's rules, after its policy) and `<name>.chain.<chain>` (a chain's own); `<name>.tamper`, when present, makes
// `-S <chain>` read back one rule fewer than was given (a read-back that differs).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes `name` (iptables or ip6tables) in `dir`, keeping its rules there; its path. */
export function fakeIptables(dir, name) {
  const path = join(dir, name);
  const at = join(dir, name);
  writeFileSync(path, `#!/bin/sh
# ${name}, as the netlock calls it: -w, then -N, -F, -C, -D, -I or -A, or -S.
[ "$1" = -w ] && shift
out='${at}.OUTPUT'
chain() { printf '%s' '${at}.chain.'"$1"; }
case "$1" in
  -N) [ -e "$(chain "$2")" ] && { echo "chain exists" >&2; exit 1; }; : > "$(chain "$2")" ;;
  -F) [ -e "$(chain "$2")" ] || exit 1; : > "$(chain "$2")" ;;
  -C) shift; grep -qxF -- "-A $*" "$out" 2>/dev/null ;;
  -D) shift; [ -e "$out" ] && grep -vxF -- "-A $*" "$out" > "$out.next"; mv "$out.next" "$out" 2>/dev/null; true ;;
  -I) shift; c=$1; shift 2; { printf '%s\\n' "-A $c $*"; cat "$out" 2>/dev/null; } > "$out.next"; mv "$out.next" "$out" ;;
  -A) shift; f=$(chain "$1"); [ -e "$f" ] || exit 1; printf '%s\\n' "-A $*" >> "$f" ;;
  -S) if [ "$2" = OUTPUT ]; then echo "-P OUTPUT ACCEPT"; cat "$out" 2>/dev/null; else f=$(chain "$2"); [ -e "$f" ] || exit 1; echo "-N $2"; if [ -e '${at}.tamper' ]; then sed '$d' "$f"; else cat "$f"; fi; fi ;;
  *) echo "the fake takes no $1" >&2; exit 2 ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

/** A getent that answers `ahostsv4` and `ahostsv6` for the region's mount endpoint, as glibc's does. */
export function fakeGetent(dir, v4 = ["203.0.113.10"], v6 = ["2001:db8::10"]) {
  const path = join(dir, "getent");
  const lines = (kind, addresses) => addresses.map((a) => `${a}      STREAM mount.green.us-east-1.aws.prod.archil.com\\n${a}      DGRAM\\n`).join("");
  writeFileSync(path, `#!/bin/sh\ncase "$1" in ahostsv4) printf '${lines("v4", v4)}' ;; ahostsv6) printf '${lines("v6", v6)}' ;; esac\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A /proc/self/status whose CapEff has CAP_NET_ADMIN (bit 12), or lacks it. */
export function fakeStatus(dir, netAdmin = true) {
  const path = join(dir, "status");
  writeFileSync(path, `Name:\tsh\nCapInh:\t0000000000000000\nCapEff:\t${netAdmin ? "000001ffffffffff" : "000001ffffffefff"}\n`);
  return path;
}

/**
 * `connect <host> <port>` as a tool runs it: refused when the box's IPv4 firewall (`rules`, its chain file) drops the
 * tool user's packets, which is every destination but loopback; else it connects. It models the firewall the netlock
 * applied, for a box whose programs all run as one user here.
 */
export function fakeConnect(dir, rules, uid) {
  const path = join(dir, "connect");
  writeFileSync(path, `#!/bin/sh
case "$1" in 127.*|localhost|::1) echo connected; exit 0 ;; esac
if grep -qxF -- '-A AGENTRUN-NET -m owner --uid-owner ${uid} -j DROP' '${rules}' 2>/dev/null; then echo "connect: $1:$2 refused by the box's firewall" >&2; exit 1; fi
echo connected
`);
  chmodSync(path, 0o755);
  return path;
}
