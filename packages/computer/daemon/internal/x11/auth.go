package x11

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
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
)

// ReadAuthority finds the MIT-MAGIC-COOKIE-1 for a local display in an Xauthority file: an entry of this host (family
// Local) or any host (family Wild), for this display number or any. A missing file, or none for the display, is no
// cookie and no error.
func ReadAuthority(path string, addr Address, hostname string) (Auth, bool, error) {
	data, err := os.ReadFile(path)
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
