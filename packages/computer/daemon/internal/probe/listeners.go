package probe

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ListenerTables are the tables of /proc/net read for listeners, each named as a listener's protocol: the probe's own
// network namespace's TCP and UDP sockets, on IPv4 and IPv6.
var ListenerTables = []string{"tcp", "tcp6", "udp", "udp6"}

// Listener is one socket that listens in the probe's own network namespace: a TCP socket in LISTEN, or a UDP socket
// bound to a port and connected to no peer. Owner names the process that holds it, "pid N (command)", where /proc lets
// the probe read that process's descriptors (one of its own user that is dumpable), else "". Computerd says that
// process runs computerd's own program, the probe's executable.
type Listener struct {
	Protocol  string `json:"protocol"`
	Address   string `json:"address"`
	Port      int    `json:"port"`
	UID       int    `json:"uid"`
	Owner     string `json:"owner"`
	Computerd bool   `json:"computerd"`
}

// ListenerSearch is what Listeners found: the listeners, and, for each table it could not read, why, in words. A search
// with any Incomplete is no proof that nothing else listens.
type ListenerSearch struct {
	Listeners  []Listener `json:"listeners"`
	Incomplete []string   `json:"incomplete"`
}

// TCP's LISTEN, and the state a UDP socket connected to no peer reads (TCP_CLOSE), in /proc/net's hex.
const (
	tcpListen   = "0A"
	udpUnpeered = "07"
)

// Listeners lists the sockets that listen in the network namespace whose /proc is proc ("/proc" for the probe's own),
// read from its net tables (ListenerTables; one the kernel lacks, as tcp6 on a kernel with no IPv6, holds none), each
// tied to the process that holds it by its inode among the descriptors of proc's processes the caller may read, sorted by
// protocol and port.
func Listeners(proc string) ListenerSearch {
	search := ListenerSearch{Listeners: []Listener{}, Incomplete: []string{}}
	owners := socketOwners(proc)
	for _, table := range ListenerTables {
		path := filepath.Join(proc, "net", table)
		text, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			search.Incomplete = append(search.Incomplete, fmt.Sprintf("%s: %v", path, err))
			continue
		}
		for _, line := range strings.Split(string(text), "\n")[1:] {
			listener, inode, ok := listening(table, line)
			if !ok {
				continue
			}
			if owner, found := owners[inode]; found {
				listener.Owner, listener.Computerd = owner.name, owner.computerd
			}
			search.Listeners = append(search.Listeners, listener)
		}
	}
	sort.SliceStable(search.Listeners, func(i, j int) bool {
		a, b := search.Listeners[i], search.Listeners[j]
		return a.Protocol < b.Protocol || (a.Protocol == b.Protocol && a.Port < b.Port)
	})
	return search
}

// listening reads one line of a /proc/net table ("sl local rem st tx:rx tr:when retrnsmt uid timeout inode ..."): the
// listener it is, with its socket's inode, and true; false for a socket that does not listen or a line that is not one.
func listening(table, line string) (Listener, string, bool) {
	fields := strings.Fields(line)
	if len(fields) < 10 {
		return Listener{}, "", false
	}
	state := fields[3]
	if (strings.HasPrefix(table, "tcp") && state != tcpListen) || (strings.HasPrefix(table, "udp") && state != udpUnpeered) {
		return Listener{}, "", false
	}
	ip, port, ok := hexAddress(fields[1])
	if !ok || port == 0 {
		return Listener{}, "", false
	}
	uid, err := strconv.Atoi(fields[7])
	if err != nil {
		return Listener{}, "", false
	}
	return Listener{Protocol: table, Address: ip.String(), Port: port, UID: uid}, fields[9], true
}

// hexAddress reads /proc/net's "ADDR:PORT": the address as the kernel prints it, each 32-bit word in the host's order,
// and the port in hex.
func hexAddress(text string) (net.IP, int, bool) {
	addr, portText, found := strings.Cut(text, ":")
	if !found {
		return nil, 0, false
	}
	port, err := strconv.ParseUint(portText, 16, 16)
	if err != nil || (len(addr) != 8 && len(addr) != 32) {
		return nil, 0, false
	}
	words, err := hex.DecodeString(addr)
	if err != nil {
		return nil, 0, false
	}
	ip := make(net.IP, 0, len(words))
	for i := 0; i < len(words); i += 4 {
		ip = binary.NativeEndian.AppendUint32(ip, binary.BigEndian.Uint32(words[i:i+4]))
	}
	return ip, int(port), true
}

// owner is the process that holds a socket: "pid N (command)", and whether it runs computerd's own program.
type owner struct {
	name      string
	computerd bool
}

// socketOwners maps each socket inode among the descriptors of proc's processes that the caller may read to the process
// that holds it. A process whose descriptors it may not read (another user's, or one of its own that is not dumpable,
// as init is once it drops) holds none here.
func socketOwners(proc string) map[string]owner {
	owners := map[string]owner{}
	self, selfErr := os.Stat(filepath.Join(proc, "self", "exe"))
	entries, _ := os.ReadDir(proc)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		dir := filepath.Join(proc, entry.Name())
		fds, err := os.ReadDir(filepath.Join(dir, "fd"))
		if err != nil {
			continue
		}
		var held owner
		named := false
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(dir, "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
				continue
			}
			if !named {
				named = true
				command, _ := os.ReadFile(filepath.Join(dir, "comm"))
				held.name = fmt.Sprintf("pid %d (%s)", pid, strings.TrimSpace(string(command)))
				exe, err := os.Stat(filepath.Join(dir, "exe"))
				held.computerd = selfErr == nil && err == nil && os.SameFile(self, exe)
			}
			owners[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = held
		}
	}
	return owners
}
