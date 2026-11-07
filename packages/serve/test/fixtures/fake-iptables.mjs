// A fake iptables (or ip6tables) for the root helper's netlock (box/agentrun-archil), and the rest a box's firewall test
// needs: its getent, its /proc/self/status, and `connect`, which a tool runs to reach a host as the firewall would let
// it. No real iptables, getent or network is touched. The rules live in files of `dir`: `<name>.OUTPUT` (the OUTPUT
// chain's rules, after its policy) and `<name>.chain.<chain>` (a chain's own); `<name>.tamper`, when present, makes
// `-S <chain>` read back one rule fewer than was given (a read-back that differs); `<name>.probe`, when present, is run
// (with sh, its output appended to `<name>.probe.log`) right after a flush: what a tool meets in that moment.
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
  -F) [ -e "$(chain "$2")" ] || exit 1; : > "$(chain "$2")"; [ -e '${at}.probe' ] && sh '${at}.probe' >> '${at}.probe.log' 2>&1; true ;;
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

/** A /proc/net/if_inet6 with loopback's ::1 (the box has IPv6), or empty (it has none). */
export function fakeInet6(dir, on = true) {
  const path = join(dir, "if_inet6");
  writeFileSync(path, on ? "00000000000000000000000000000001 01 80 10 80       lo\n" : "");
  return path;
}

/** A /proc/self/status whose CapEff has CAP_NET_ADMIN (bit 12), or lacks it. */
export function fakeStatus(dir, netAdmin = true) {
  const path = join(dir, "status");
  writeFileSync(path, `Name:\tsh\nCapInh:\t0000000000000000\nCapEff:\t${netAdmin ? "000001ffffffffff" : "000001ffffffefff"}\n`);
  return path;
}

/**
 * `connect <host> <port>` as a tool runs it, a new connection of the tool user: its packet walks OUTPUT (the file beside
 * the chain file `v4`, or for an IPv6 host `v6`) in order, the jump into the box's chain walking that chain's rules,
 * and the first rule that matches it decides, as the kernel's would. Loopback (127.*, localhost, ::1) is the `-o lo`
 * interface. With no OUTPUT rules, it connects. It models the firewall the netlock applied, for a box whose programs
 * all run as one user here.
 */
export function fakeConnect(dir, v4, uid, v6 = v4) {
  const path = join(dir, "connect");
  writeFileSync(path, `#!/bin/sh
case "$1" in 127.*|localhost|::1) lo=1 ;; *) lo=0 ;; esac
case "$1" in *:*) rules='${v6}' ;; *) rules='${v4}' ;; esac
refused() { echo "connect: $1:$2 refused by the box's firewall" >&2; exit 1; }
out="\${rules%.chain.AGENTRUN-NET}.OUTPUT"
chain() {
  [ -e "$rules" ] || return 0
  while IFS= read -r rule; do
    case "$rule" in
      "-A AGENTRUN-NET -m owner --uid-owner ${uid} -j DROP") refused "$1" "$2" ;;
      "-A AGENTRUN-NET -o lo -j ACCEPT") [ "$lo" = 1 ] && { echo connected; exit 0; } ;;
    esac
  done < "$rules"
}
if [ -e "$out" ]; then
  while IFS= read -r rule; do
    case "$rule" in
      "-A OUTPUT -j AGENTRUN-NET") chain "$1" "$2" ;;
      "-A OUTPUT -m owner --uid-owner ${uid} -j DROP") refused "$1" "$2" ;;
    esac
  done < "$out"
fi
echo connected
`);
  chmodSync(path, 0o755);
  return path;
}
