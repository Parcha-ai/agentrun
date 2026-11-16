package egress

// The address rule of a hosted computer's egress proxy: which addresses a computer's programs may reach through it.
// Everything public; nothing private or local. It is the rule of the Docker computer's egress proxy, written again in Go
// for the proxy computerd runs (src/docker/egress-table.ts is the other one): the same ranges, in the same order, with
// the same classes, and a test in the package's TypeScript suite (test/egress-table-go.test.mjs) holds this table to
// that one. It judges the address a socket would connect to, never the text a client wrote. An IPv6 address that
// carries an IPv4 one (mapped, NAT64, 6to4) is judged by the IPv4 inside. The machine's own interface addresses are
// refused too: the caller passes them in, so the table itself stays pure.

import (
	"errors"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

// rule is one refused range and why, or (last32, 6to4) where the IPv4 an IPv6 range carries sits.
type rule struct {
	cidr  string
	class string
}

// table is the refused ranges, specific ones first (the first match decides): a single metadata address before the
// range it sits in, the broadcast address before the reserved block. Past the table, an IPv6 address outside global
// unicast (2000::/3) is refused as reserved, in code.
var table = []rule{
	{"0.0.0.0/8", "unspecified"},
	{"127.0.0.0/8", "loopback"},
	{"10.0.0.0/8", "private"},
	{"172.16.0.0/12", "private"},
	{"192.168.0.0/16", "private"},
	{"192.0.0.0/24", "private"},
	{"100.100.100.200/32", "metadata"},
	{"100.64.0.0/10", "cgnat"},
	{"168.63.129.16/32", "metadata"},
	{"169.254.0.0/16", "link-local"},
	{"198.18.0.0/15", "benchmarking"},
	{"192.0.2.0/24", "reserved"},
	{"198.51.100.0/24", "reserved"},
	{"203.0.113.0/24", "reserved"},
	{"192.88.99.0/24", "reserved"},
	{"224.0.0.0/4", "multicast"},
	{"255.255.255.255/32", "broadcast"},
	{"240.0.0.0/4", "reserved"},
	{"::1/128", "loopback"},
	{"::/128", "unspecified"},
	{"::ffff:0:0/96", "last32"},
	{"64:ff9b::/96", "last32"},
	{"64:ff9b:1::/48", "private"},
	{"2002::/16", "6to4"},
	{"2001::/32", "reserved"},
	{"2001:db8::/32", "reserved"},
	{"fd00:ec2::/32", "metadata"},
	{"fc00::/7", "private"},
	{"fe80::/10", "link-local"},
	{"ff00::/8", "multicast"},
}

// ranges is the table parsed: each range's prefix, in IPv6 form for an IPv6 range.
var ranges = func() []struct {
	prefix netip.Prefix
	rule
} {
	out := make([]struct {
		prefix netip.Prefix
		rule
	}, len(table))
	for i, r := range table {
		out[i].prefix = netip.MustParsePrefix(r.cidr)
		out[i].rule = r
	}
	return out
}()

var globalUnicast = netip.MustParsePrefix("2000::/3")

// Check is whether a computer may reach address: "" when it may, else the class it is refused as. local is the
// machine's own addresses, refused as "this-host". An IPv4 address is judged as IPv4 and an IPv6 address as IPv6
// (netip keeps an IPv4-mapped one in its IPv6 form, judged by the IPv4 inside).
func Check(address netip.Addr, local []netip.Addr) string {
	address = address.WithZone("")
	if !address.IsValid() {
		return "invalid"
	}
	for _, r := range ranges {
		if r.prefix.Addr().Is4() != address.Is4() || !r.prefix.Contains(address) {
			continue
		}
		if r.class == "last32" || r.class == "6to4" {
			bytes := address.As16()
			var inner [4]byte
			if r.class == "last32" {
				copy(inner[:], bytes[12:16])
			} else {
				copy(inner[:], bytes[2:6])
			}
			if class := Check(netip.AddrFrom4(inner), local); class != "" {
				return class
			}
			return ownAddress(address, local)
		}
		return r.class
	}
	if address.Is6() && !globalUnicast.Contains(address) {
		return "reserved"
	}
	return ownAddress(address, local)
}

// ownAddress is "this-host" when address is one of local, as it is written there, else "".
func ownAddress(address netip.Addr, local []netip.Addr) string {
	for _, own := range local {
		if own.WithZone("") == address {
			return "this-host"
		}
	}
	return ""
}

// literal is the address host names when it is an IP literal (bracketed or not, a zone dropped), else not ok: a name.
// Only the plain forms are literals here; any other text is a name, which the allow rule checks by name and the resolver
// answers, and every address it answers meets Check before any dial.
func literal(host string) (netip.Addr, bool) {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	address, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return address.WithZone(""), true
}

// entry is a list's name entry: a name of two labels or more, or `*.` and such a name.
var entry = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// v4Cidr is a CIDR's IPv4 base as a list may write it: four decimal parts, no leading zero.
var v4Cidr = regexp.MustCompile(`^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}/(0|[1-9][0-9]?)$`)

// Allow is a host list: its names (exact, or `*.suffix`) and its CIDRs.
type Allow struct {
	Names []string
	CIDRs []netip.Prefix
	// read is every entry as it was read, in its order: what Entries gives.
	read []string
}

// Entries is the list as it was read: each entry lowercased, a name's trailing dot dropped, in the order given, the
// repeats gone; as the TypeScript parseAllow gives it, so a list written by one reads back the same through the other.
func (a Allow) Entries() []string {
	return append([]string{}, a.read...)
}

// ParseAllow reads a list: entries split by commas or spaces, each lowercased, a name's trailing dot dropped, the repeats
// gone. An entry is a name of two labels or more, `*.` and one, or a CIDR whose host bits are zero, which overlaps no
// range the table refuses and, for IPv6, lies in global unicast. Anything else is refused in words naming it, as the
// TypeScript parseAllow refuses it. An empty list is refused: a proxy with none would reach every public host.
func ParseAllow(text string) (Allow, error) {
	var out Allow
	seen := map[string]bool{}
	for _, raw := range strings.FieldsFunc(text, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		lower := strings.ToLower(raw)
		if strings.Contains(lower, "/") {
			prefix, why := cidrOf(lower)
			if why != "" {
				return Allow{}, errors.New("the network list's entry " + quote(raw) + " " + why)
			}
			if !seen[lower] {
				seen[lower] = true
				out.CIDRs = append(out.CIDRs, prefix)
				out.read = append(out.read, lower)
			}
			continue
		}
		name := strings.TrimSuffix(lower, ".")
		if _, isAddress := literal(strings.TrimPrefix(name, "*.")); isAddress || !entry.MatchString(name) {
			return Allow{}, errors.New("the network list's entry " + quote(raw) + " " + neither)
		}
		if !seen[name] {
			seen[name] = true
			out.Names = append(out.Names, name)
			out.read = append(out.read, name)
		}
	}
	if len(out.Names)+len(out.CIDRs) == 0 {
		return Allow{}, errors.New("the network list holds no entry: a proxy with none would reach every public host")
	}
	return out, nil
}

const neither = "is not a name with at least two labels, or *. and one, and not a CIDR (an IPv4 address in four decimal parts or an IPv6 address, then / and a prefix length its family holds)"

func quote(text string) string {
	if len(text) > 255 {
		text = text[:255]
	}
	return `"` + strings.ReplaceAll(text, `"`, `\"`) + `"`
}

// cidrOf reads a CIDR entry, or why it is none (never a prefix that the table would refuse a part of).
func cidrOf(text string) (netip.Prefix, string) {
	base, _, _ := strings.Cut(text, "/")
	if !strings.Contains(base, ":") && !v4Cidr.MatchString(text) {
		return netip.Prefix{}, neither
	}
	prefix, err := netip.ParsePrefix(text)
	if err != nil || prefix.Addr().Zone() != "" {
		return netip.Prefix{}, neither
	}
	if prefix.Masked() != prefix {
		return netip.Prefix{}, "has host bits set past its /" + strconv.Itoa(prefix.Bits()) + ": write its network address"
	}
	for _, r := range ranges {
		if r.prefix.Addr().Is4() != prefix.Addr().Is4() {
			continue
		}
		if r.prefix.Overlaps(prefix) {
			return netip.Prefix{}, "covers addresses the egress proxy refuses (the refused range " + r.cidr + ")"
		}
	}
	if prefix.Addr().Is6() && (prefix.Bits() < 3 || !globalUnicast.Contains(prefix.Addr())) {
		return netip.Prefix{}, "is outside global unicast (2000::/3), which the egress proxy refuses"
	}
	return prefix, ""
}

// listed is whether the name host is on the list's names: an exact name, or one below a `*.suffix`; in any case, and
// without a trailing dot.
func (a Allow) listed(host string) bool {
	name := strings.TrimSuffix(strings.ToLower(host), ".")
	for _, entry := range a.Names {
		if suffix, wild := strings.CutPrefix(entry, "*."); wild {
			if strings.HasSuffix(name, "."+suffix) {
				return true
			}
		} else if name == entry {
			return true
		}
	}
	return false
}

// inCIDRs is whether address lies in one of the list's CIDRs, of its own family.
func (a Allow) inCIDRs(address netip.Addr) bool {
	for _, cidr := range a.CIDRs {
		if cidr.Addr().Is4() == address.Is4() && cidr.Contains(address) {
			return true
		}
	}
	return false
}
