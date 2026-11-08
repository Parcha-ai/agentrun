package keys_test

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/keys"
)

// TestNamesAreProtocolTSKEYS keeps the Go table equal to the one canonical table, KEYS in src/protocol.ts.
func TestNamesAreProtocolTSKEYS(t *testing.T) {
	source, err := os.ReadFile("../../../src/protocol.ts")
	if err != nil {
		t.Fatal(err)
	}
	table := regexp.MustCompile(`(?s)export const KEYS = \[(.*?)\] as const`).FindSubmatch(source)
	if table == nil {
		t.Fatal("src/protocol.ts has no `export const KEYS = [...] as const`")
	}
	var want []string
	for _, quoted := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(table[1], -1) {
		want = append(want, string(quoted[1]))
	}
	if strings.Join(keys.Names, ",") != strings.Join(want, ",") {
		t.Fatalf("keys.Names is\n%v\nKEYS in src/protocol.ts is\n%v", keys.Names, want)
	}
}

func TestAKeyIsANameInKEYSOrOnePrintableASCIICharacter(t *testing.T) {
	for key, sym := range map[string]uint32{
		"enter": 0xff0d, "tab": 0xff09, "space": 0x20, "backspace": 0xff08, "delete": 0xffff, "escape": 0xff1b, "insert": 0xff63,
		"up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
		"f1": 0xffbe, "f12": 0xffc9, "shift": 0xffe1, "ctrl": 0xffe3, "alt": 0xffe9, "super": 0xffeb, "capslock": 0xffe5,
		"a": 0x61, "A": 0x41, "1": 0x31, "/": 0x2f, "~": 0x7e, "!": 0x21,
	} {
		got, ok := keys.Keysym(key)
		if !ok || got != sym {
			t.Errorf("Keysym(%q) = %#x, %v; want %#x", key, got, ok, sym)
		}
		if !keys.IsKey(key) {
			t.Errorf("IsKey(%q) = false", key)
		}
	}
	for _, key := range []string{"Enter", "Return", "Hyper_Q", " ", "\t", "é", "ab", "", "F13", "\x7f"} {
		if _, ok := keys.Keysym(key); ok || keys.IsKey(key) {
			t.Errorf("%q is a key; want refused", key)
		}
	}
	for _, name := range keys.Names {
		if _, ok := keys.Keysym(name); !ok {
			t.Errorf("KEYS name %q has no keysym", name)
		}
	}
}

func TestEveryCharacterTypeTakesHasAKeysymAndBack(t *testing.T) {
	for r, sym := range map[rune]uint32{
		'a': 0x61, 'Z': 0x5a, ' ': 0x20, '~': 0x7e, '\n': 0xff0d, '\t': 0xff09,
		'é': 0xe9, 'ñ': 0xf1, 'ÿ': 0xff, '€': 0x010020ac, '日': 0x010065e5, '😀': 0x0101f600,
	} {
		got, ok := keys.ForRune(r)
		if !ok || got != sym {
			t.Errorf("ForRune(%q) = %#x, %v; want %#x", r, got, ok, sym)
		}
		back, ok := keys.Rune(sym)
		if !ok || back != r {
			t.Errorf("Rune(%#x) = %q, %v; want %q", sym, back, ok, r)
		}
	}
	for _, r := range []rune{0, '\a', '\r', 0x1b, 0x7f, 0x85, 0x9f, 0xfffe, 0xd800} {
		if sym, ok := keys.ForRune(r); ok {
			t.Errorf("ForRune(%U) = %#x; a control character or non-character has no key", r, sym)
		}
	}
}

func TestANameForEachKeysymTheFixtureLogs(t *testing.T) {
	for sym, name := range map[uint32]string{0xff0d: "enter", 0xffe1: "shift", 0xffe2: "shift", 0xffe4: "ctrl", 0x61: "a", 0x41: "A", 0xe9: "é", 0x1008ff13: "keysym 0x1008ff13"} {
		if got := keys.Name(sym); got != name {
			t.Errorf("Name(%#x) = %q; want %q", sym, got, name)
		}
	}
}
