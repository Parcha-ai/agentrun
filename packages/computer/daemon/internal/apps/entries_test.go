package apps

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEntriesReadsApplicationsAsXDGSays(t *testing.T) {
	home, system := t.TempDir(), t.TempDir()
	write(t, filepath.Join(system, "org.xfce.mousepad.desktop"), "[Desktop Entry]\nType=Application\nName=Mousepad\nName[de]=Mausblock\nExec=mousepad %F\nStartupWMClass=Mousepad\n")
	// A program in a sub-folder: its id joins the folders with dashes.
	write(t, filepath.Join(system, "kde", "konsole.desktop"), "[Desktop Entry]\nType=Application\nName=Konsole\nExec=konsole\n")
	// Not shown in a menu, deleted, a link, a missing TryExec, an action group's Exec: none is an app.
	write(t, filepath.Join(system, "helper.desktop"), "[Desktop Entry]\nType=Application\nName=Helper\nExec=helper\nNoDisplay=true\n")
	write(t, filepath.Join(system, "gone.desktop"), "[Desktop Entry]\nType=Application\nName=Gone\nExec=gone\nHidden=true\n")
	write(t, filepath.Join(system, "site.desktop"), "[Desktop Entry]\nType=Link\nName=Site\nURL=https://example.com\n")
	write(t, filepath.Join(system, "absent.desktop"), "[Desktop Entry]\nType=Application\nName=Absent\nExec=absent\nTryExec=/no/such/program\n")
	write(t, filepath.Join(system, "actions.desktop"), "[Desktop Entry]\nType=Application\nName=Actions\nExec=actions --main\n\n[Desktop Action new]\nName=New\nExec=actions --new\n")
	// The user's own copy of an app comes first: its folder is earlier.
	write(t, filepath.Join(home, "org.xfce.mousepad.desktop"), "[Desktop Entry]\nType=Application\nName=My Mousepad\nExec=mousepad --mine %U\n")
	write(t, filepath.Join(system, "notes.txt"), "not a desktop file")

	got := Entries([]string{home, system})
	ids := []string{}
	for _, e := range got {
		ids = append(ids, e.ID)
	}
	if want := []string{"actions", "kde-konsole", "org.xfce.mousepad"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids %v, want %v", ids, want)
	}
	mousepad := got[2]
	if mousepad.Name != "My Mousepad" || mousepad.Exec != "mousepad --mine %U" {
		t.Fatalf("the user's mousepad is not the one listed: %+v", mousepad)
	}
	if got[0].Exec != "actions --main" {
		t.Fatalf("an action's Exec replaced the app's: %+v", got[0])
	}
}

func TestArgvFollowsTheExecKey(t *testing.T) {
	cases := []struct {
		exec, url string
		want      []string
		fails     bool
	}{
		{exec: "mousepad %F", want: []string{"mousepad"}},
		{exec: "mousepad %F", url: "/tmp/a b.txt", want: []string{"mousepad", "/tmp/a b.txt"}},
		{exec: "firefox-esr %u", url: "https://example.com/?q=1", want: []string{"firefox-esr", "https://example.com/?q=1"}},
		{exec: `"/opt/My App/run" --title "a \"b\"" %U`, want: []string{"/opt/My App/run", "--title", `a "b"`}},
		{exec: "xterm -T 100%% %i %c %k", want: []string{"xterm", "-T", "100%"}},
		// A url for an app that opens none is refused, not dropped.
		{exec: "xfce4-terminal", url: "https://example.com", fails: true},
		{exec: `"unclosed`, fails: true},
		{exec: "", fails: true},
	}
	for _, c := range cases {
		got, err := Entry{ID: "x", Exec: c.exec}.Argv(c.url)
		if c.fails {
			if err == nil {
				t.Errorf("%q with url %q: %v, want an error", c.exec, c.url, got)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q with url %q: %q, %v; want %q", c.exec, c.url, got, err, c.want)
		}
	}
}

func TestFindTakesAnIdThenANameThenAProgram(t *testing.T) {
	entries := []Entry{
		{ID: "org.xfce.mousepad", Name: "Mousepad", Exec: "mousepad %F"},
		{ID: "xfce4-terminal", Name: "Xfce Terminal", Exec: "xfce4-terminal"},
		{ID: "firefox-esr", Name: "Firefox ESR", Exec: "/usr/lib/firefox-esr/firefox-esr %u"},
	}
	for asked, want := range map[string]string{
		"org.xfce.mousepad": "org.xfce.mousepad",
		"mousepad":          "org.xfce.mousepad",
		"Xfce Terminal":     "xfce4-terminal",
		"xfce terminal":     "xfce4-terminal",
		"firefox-esr":       "firefox-esr",
	} {
		got, ok := Find(entries, asked)
		if !ok || got.ID != want {
			t.Errorf("Find(%q) = %q, %v; want %q", asked, got.ID, ok, want)
		}
	}
	if got, ok := Find(entries, "gimp"); ok {
		t.Errorf("Find(gimp) = %q, want none", got.ID)
	}
}

func TestOwnerOfAWindowByItsClass(t *testing.T) {
	entries := []Entry{
		{ID: "org.xfce.mousepad", Name: "Mousepad", Exec: "mousepad %F"},
		{ID: "xfce4-terminal", Name: "Xfce Terminal", Exec: "xfce4-terminal"},
		{ID: "firefox-esr", Name: "Firefox ESR", Exec: "/usr/lib/firefox-esr/firefox-esr %u", WMClass: "firefox-esr"},
		{ID: "test.window", Name: "Test Window", Exec: "/bin/true", WMClass: "TestWindow"},
	}
	for _, c := range []struct {
		class [2]string
		want  string
	}{
		{[2]string{"mousepad", "Mousepad"}, "org.xfce.mousepad"},
		{[2]string{"xfce4-terminal", "Xfce4-terminal"}, "xfce4-terminal"},
		{[2]string{"Navigator", "firefox-esr"}, "firefox-esr"},
		{[2]string{"test", "TestWindow"}, "test.window"},
		{[2]string{"xclock", "XClock"}, ""},
	} {
		if got := ownerByClass(entries, c.class); got != c.want {
			t.Errorf("ownerByClass(%q) = %q, want %q", c.class, got, c.want)
		}
	}
}
