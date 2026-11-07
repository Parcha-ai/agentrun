package x11

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/netip"
	"os"
	"strconv"
	"syscall"
)

// Auth is what the connection setup sends: an authorization protocol's name and its data.
type Auth struct {
	Name string
	Data []byte
}

const (
	familyLocal = 256
	familyWild  = 65535
	cookieName  = "MIT-MAGIC-COOKIE-1"

	// maxAuthority is the most bytes of an Xauthority file this client reads: 64 KiB. An entry is its family and four
	// counted fields, under 100 bytes for a hostname and a 16-byte cookie, so this holds hundreds of entries, more than a
	// computer's file has. A longer file is refused rather than read in part, which could miss this display's entry.
	maxAuthority = 64 << 10
)

// ReadAuthority finds the MIT-MAGIC-COOKIE-1 for a local display in an Xauthority file: an entry of this host (family
// Local) or any host (family Wild), for this display number or any. A missing file, or none for the display, is no
// cookie and no error.
//
// Only a display in this computer has one: addr.Host is "" or "unix" (the unix socket) or a loopback address, as Dial
// gives it once it has resolved the host. For any other host this is no cookie, so a local cookie is never sent to
// another server.
//
// The file is in the home of the computer's user, where any program may put something else at its path, so only a
// regular file of at most 64 KiB is read, and anything else is refused in words without reading it: a symbolic link is
// not followed, a FIFO never makes the read wait for a writer, and a device never makes it read without end.
func ReadAuthority(path string, addr Address, hostname string) (Auth, bool, error) {
	if !addr.local() {
		return Auth{}, false, nil
	}
	data, err := readAuthority(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Auth{}, false, nil
	}
	if err != nil {
		return Auth{}, false, fmt.Errorf("cannot read the Xauthority file %s: %w", path, err)
	}
	number := strconv.Itoa(addr.Number)
	for len(data) > 0 {
		if len(data) < 2 {
			return Auth{}, false, fmt.Errorf("the Xauthority file %s is cut short", path)
		}
		family := binary.BigEndian.Uint16(data)
		data = data[2:]
		var fields [4][]byte
		for i := range fields {
			if len(data) < 2 || len(data) < 2+int(binary.BigEndian.Uint16(data)) {
				return Auth{}, false, fmt.Errorf("the Xauthority file %s is cut short", path)
			}
			n := int(binary.BigEndian.Uint16(data))
			fields[i] = data[2 : 2+n]
			data = data[2+n:]
		}
		host := (family == familyLocal && string(fields[0]) == hostname) || family == familyWild
		if host && (len(fields[1]) == 0 || string(fields[1]) == number) && string(fields[2]) == cookieName {
			return Auth{Name: cookieName, Data: append([]byte(nil), fields[3]...)}, true, nil
		}
	}
	return Auth{}, false, nil
}

// readAuthority reads path when it is a regular file of at most maxAuthority bytes. It opens it without following a
// symbolic link and without waiting (O_NONBLOCK: the open of a FIFO or a device never blocks), then checks what it
// opened, as files.openRegular does, so a file swapped between a check and the open cannot slip by.
func readAuthority(path string) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	switch {
	case errors.Is(err, syscall.ELOOP):
		return nil, errors.New("it is a symbolic link, which is not followed")
	case err != nil:
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return nil, errors.New("it is not a regular file")
	}
	if st.Size > maxAuthority {
		return nil, fmt.Errorf("it is %d bytes, over the %d an Xauthority file is read up to", st.Size, maxAuthority)
	}
	if err := syscall.SetNonblock(fd, false); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxAuthority+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxAuthority {
		return nil, fmt.Errorf("it grew past the %d bytes an Xauthority file is read up to", maxAuthority)
	}
	return data, nil
}

// local is whether the address is a display in this computer: the unix socket, or a loopback address.
func (a Address) local() bool {
	if a.Host == "" || a.Host == "unix" {
		return true
	}
	ip, err := netip.ParseAddr(a.Host)
	return err == nil && ip.Unmap().IsLoopback()
}
