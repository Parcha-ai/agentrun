package apps

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// Entry is one app a desktop file describes (the freedesktop.org Desktop Entry Specification 1.5): its desktop file id,
// its name, the command line that opens it, and the window class its windows have when it says so.
type Entry struct {
	ID      string
	Name    string
	Exec    string
	WMClass string
}

// ApplicationDirs is where desktop files are, first first (XDG Base Directory Specification): $XDG_DATA_HOME, else
// ~/.local/share, then each of $XDG_DATA_DIRS, else /usr/local/share and /usr/share; each with applications/.
func ApplicationDirs() []string {
	home := os.Getenv("XDG_DATA_HOME")
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(h, ".local", "share")
		}
	}
	data := os.Getenv("XDG_DATA_DIRS")
	if data == "" {
		data = "/usr/local/share:/usr/share"
	}
	var out []string
	for _, dir := range append([]string{home}, filepath.SplitList(data)...) {
		if dir != "" && filepath.IsAbs(dir) {
			out = append(out, filepath.Join(dir, "applications"))
		}
	}
	return out
}

// Entries is every app in dirs, by id: a file in an earlier folder hides one of the same id in a later one, whether or
// not it is an app. An app is a desktop file of type Application with a name and an Exec, not hidden (deleted), not
// NoDisplay (not for a menu), and whose TryExec, when it has one, is a program there is.
func Entries(dirs []string) []Entry {
	seen := map[string]bool{}
	var out []Entry
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".desktop") {
				return nil
			}
			rel, err := filepath.Rel(dir, path)
			if err != nil {
				return nil
			}
			id := strings.ReplaceAll(strings.TrimSuffix(rel, ".desktop"), string(filepath.Separator), "-")
			if seen[id] {
				return nil
			}
			seen[id] = true
			if e, ok := readEntry(path); ok {
				e.ID = id
				out = append(out, e)
			}
			return nil
		})
	}
	slices.SortFunc(out, func(a, b Entry) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// readEntry reads a desktop file's [Desktop Entry] group, and whether it is an app.
func readEntry(path string) (Entry, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Entry{}, false
	}
	defer f.Close()
	keys := map[string]string{}
	group := ""
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := strings.TrimSpace(scan.Text())
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			group = line[1 : len(line)-1]
		case group == "Desktop Entry":
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			if _, have := keys[key]; !have {
				keys[key] = strings.TrimSpace(value)
			}
		}
	}
	if keys["Type"] != "Application" || keys["Name"] == "" || keys["Exec"] == "" || keys["Hidden"] == "true" || keys["NoDisplay"] == "true" {
		return Entry{}, false
	}
	if try := unescape(keys["TryExec"]); try != "" {
		if _, err := exec.LookPath(try); err != nil {
			return Entry{}, false
		}
	}
	return Entry{Name: unescape(keys["Name"]), Exec: unescape(keys["Exec"]), WMClass: unescape(keys["StartupWMClass"])}, true
}

// unescape reads a string value's escapes: \s, \n, \t, \r and \\.
func unescape(value string) string {
	if !strings.Contains(value, `\`) {
		return value
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] != '\\' || i+1 == len(value) {
			b.WriteByte(value[i])
			continue
		}
		i++
		switch value[i] {
		case 's':
			b.WriteByte(' ')
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		default:
			b.WriteByte(value[i])
		}
	}
	return b.String()
}

// Argv is the program and arguments that open the app (the Exec key's rules), with url in place of its %u, %U, %f or
// %F. A url for an app whose Exec has none of those is refused: the app would open without it.
func (e Entry) Argv(url string) ([]string, error) {
	words, err := split(e.Exec)
	if err != nil {
		return nil, fmt.Errorf("%s's Exec %q: %v", e.ID, e.Exec, err)
	}
	if len(words) == 0 {
		return nil, fmt.Errorf("%s's Exec is empty", e.ID)
	}
	var argv []string
	took := false
	for _, word := range words {
		switch word {
		case "%f", "%F", "%u", "%U":
			took = true
			if url != "" {
				argv = append(argv, url)
			}
			continue
		case "%i", "%c", "%k", "%d", "%D", "%n", "%N", "%v", "%m":
			continue
		}
		argv = append(argv, strings.ReplaceAll(word, "%%", "%"))
	}
	if url != "" && !took {
		return nil, fmt.Errorf("%s opens no url or file: its Exec %q has no %%u or %%f", e.ID, e.Exec)
	}
	return argv, nil
}

// split is an Exec value's words: separated by spaces, a word in double quotes with \", \`, \$ and \\ inside it.
func split(line string) ([]string, error) {
	var words []string
	var word strings.Builder
	in, quoted := false, false
	for i := 0; i < len(line); i++ {
		ch := line[i]
		switch {
		case quoted && ch == '\\' && i+1 < len(line):
			i++
			word.WriteByte(line[i])
		case ch == '"':
			quoted = !quoted
			in = true
		case !quoted && (ch == ' ' || ch == '\t'):
			if in {
				words = append(words, word.String())
				word.Reset()
				in = false
			}
		default:
			word.WriteByte(ch)
			in = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("a quote is not closed")
	}
	if in {
		words = append(words, word.String())
	}
	return words, nil
}

// program is the base name of the program an Exec runs: "/usr/bin/mousepad %F" is mousepad.
func (e Entry) program() string {
	words, err := split(e.Exec)
	if err != nil || len(words) == 0 {
		return ""
	}
	return filepath.Base(words[0])
}

// Find is the app asked for: by its id, else by its name (any case), else by the program it runs.
func Find(entries []Entry, asked string) (Entry, bool) {
	for _, match := range []func(Entry) bool{
		func(e Entry) bool { return e.ID == asked },
		func(e Entry) bool { return strings.EqualFold(e.Name, asked) },
		func(e Entry) bool { return e.program() == asked },
	} {
		for _, e := range entries {
			if match(e) {
				return e, true
			}
		}
	}
	return Entry{}, false
}

// ownerByClass is the id of the app a window of WM_CLASS (instance, class) is, or "": the one whose StartupWMClass is
// either, else whose id's last part (org.xfce.mousepad's mousepad) or program is either, in any case.
func ownerByClass(entries []Entry, class [2]string) string {
	is := func(name string) bool {
		return name != "" && (strings.EqualFold(name, class[0]) || strings.EqualFold(name, class[1]))
	}
	for _, match := range []func(Entry) bool{
		func(e Entry) bool { return is(e.WMClass) },
		func(e Entry) bool { return is(e.ID[strings.LastIndex(e.ID, ".")+1:]) },
		func(e Entry) bool { return is(e.program()) },
	} {
		for _, e := range entries {
			if match(e) {
				return e.ID
			}
		}
	}
	return ""
}
