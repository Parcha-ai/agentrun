package daemon

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ToolUserName is the name a desktop's user gets when its uid has none: the box image's (box/Dockerfile) agentrun-tool.
const ToolUserName = "agentrun-tool"

// NameUser gives uid a passwd entry, and gid a group entry, in etc (the system's /etc) when the system has none, before
// init becomes uid: a desktop's programs look their user up, and fail without one. D-Bus's session bus closes every
// connection of a uid it cannot look up ("Could not get password database information for UID of current process"),
// so a window manager that reads its settings over it (xfwm4, through xfconf) exits; a terminal finds its user's shell
// there. Some vendors' images have no entry for the uid computerd's programs run as (E2B Desktop has none for 2510).
//
// The entry is ToolUserName, or agentrun-<uid> when that name is another uid's, with home the computer's HOME and shell
// /bin/sh, and no password ("x", none in shadow); the group is named the same way. A uid or gid that has an entry
// already is left as it is. It runs as root; a file it cannot write is an error, and init refuses to start.
func NameUser(etc string, uid, gid int, home string) error {
	passwd := filepath.Join(etc, "passwd")
	name, err := entryName(passwd, uid)
	if err != nil {
		return err
	}
	if name != "" {
		if err := addEntry(passwd, fmt.Sprintf("%s:x:%d:%d:agentrun tool user:%s:/bin/sh", name, uid, gid, home)); err != nil {
			return err
		}
	}
	group := filepath.Join(etc, "group")
	name, err = entryName(group, gid)
	if err != nil {
		return err
	}
	if name != "" {
		return addEntry(group, fmt.Sprintf("%s:x:%d:", name, gid))
	}
	return nil
}

// entryName reads a passwd or group file: "" when id has an entry already, else the name a new entry for id takes.
func entryName(file string, id int) (string, error) {
	text, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("cannot read %s to name the computer's user: %w", file, err)
	}
	names := map[string]bool{}
	scan := bufio.NewScanner(bytes.NewReader(text))
	for scan.Scan() {
		fields := strings.Split(scan.Text(), ":")
		if len(fields) < 3 {
			continue
		}
		if fields[2] == strconv.Itoa(id) {
			return "", nil
		}
		names[fields[0]] = true
	}
	if !names[ToolUserName] {
		return ToolUserName, nil
	}
	if alt := fmt.Sprintf("agentrun-%d", id); !names[alt] {
		return alt, nil
	}
	return "", fmt.Errorf("%s names %s and agentrun-%d already, each another id's, so id %d gets no name", file, ToolUserName, id, id)
}

// addEntry appends line to file, on a line of its own.
func addEntry(file, line string) error {
	f, err := os.OpenFile(file, os.O_RDWR|os.O_APPEND, 0)
	if err != nil {
		return fmt.Errorf("cannot open %s to name the computer's user: %w", file, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("cannot read %s: %w", file, err)
	}
	prefix := ""
	if info.Size() > 0 {
		last := make([]byte, 1)
		if _, err := f.ReadAt(last, info.Size()-1); err != nil {
			return fmt.Errorf("cannot read %s: %w", file, err)
		}
		if last[0] != '\n' {
			prefix = "\n"
		}
	}
	if _, err := f.WriteString(prefix + line + "\n"); err != nil {
		return fmt.Errorf("cannot add %q to %s: %w", line, file, err)
	}
	return nil
}
