// Package keys is the protocol's key table on the Go side: KEYS of src/protocol.ts (a test keeps the two equal), and
// the X keysym of each key and of each character input.actions' type takes. Keysym values are from the X Window System
// Protocol's appendix A and X11/keysymdef.h: Latin-1 characters are their own code point, any other Unicode character
// is 0x01000000 plus its code point.
package keys

import (
	"fmt"
	"unicode"
)

// Names is KEYS of src/protocol.ts, in its order.
var Names = []string{
	"enter", "tab", "space", "backspace", "delete", "escape", "insert",
	"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
	"shift", "ctrl", "alt", "super", "capslock",
}

// named is each name's keysym; a modifier is its left key.
var named = map[string]uint32{
	"enter": 0xff0d, "tab": 0xff09, "space": 0x20, "backspace": 0xff08, "delete": 0xffff, "escape": 0xff1b, "insert": 0xff63,
	"up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
	"f1": 0xffbe, "f2": 0xffbf, "f3": 0xffc0, "f4": 0xffc1, "f5": 0xffc2, "f6": 0xffc3, "f7": 0xffc4, "f8": 0xffc5, "f9": 0xffc6,
	"f10": 0xffc7, "f11": 0xffc8, "f12": 0xffc9,
	"shift": 0xffe1, "ctrl": 0xffe3, "alt": 0xffe9, "super": 0xffeb, "capslock": 0xffe5,
}

// names is the name of each keysym a key of the table can give, for the fixture's log: both sides of a modifier.
var names = map[uint32]string{0xffe2: "shift", 0xffe4: "ctrl", 0xffea: "alt", 0xffec: "super"}

func init() {
	for name, sym := range named {
		if name != "space" {
			names[sym] = name
		}
	}
}

const (
	// Return and Tab: type's newline and tab.
	returnSym = 0xff0d
	tabSym    = 0xff09
	// unicodeBase plus a code point is that character's keysym, for any character outside Latin-1.
	unicodeBase = 0x01000000
)

// IsKey is whether key is a name in KEYS or one printable ASCII character (0x21-0x7e).
func IsKey(key string) bool {
	_, ok := Keysym(key)
	return ok
}

// Keysym is a key's keysym: a name in KEYS, or one printable ASCII character, which is its own.
func Keysym(key string) (uint32, bool) {
	if sym, ok := named[key]; ok {
		return sym, true
	}
	if len(key) == 1 && key[0] >= 0x21 && key[0] <= 0x7e {
		return uint32(key[0]), true
	}
	return 0, false
}

// ForRune is the keysym that types r: a newline is Return and a tab is Tab; any other control character, and a
// surrogate or non-character, has none.
func ForRune(r rune) (uint32, bool) {
	switch {
	case r == '\n':
		return returnSym, true
	case r == '\t':
		return tabSym, true
	case unicode.IsControl(r), r > unicode.MaxRune, r >= 0xd800 && r <= 0xdfff, r&0xfffe == 0xfffe, r >= 0xfdd0 && r <= 0xfdef:
		return 0, false
	case r >= 0x20 && r <= 0xff:
		return uint32(r), true
	default:
		return unicodeBase + uint32(r), true
	}
}

// Rune is the character a keysym types, for those ForRune gives (and the Latin-1 ones of a keyboard map).
func Rune(sym uint32) (rune, bool) {
	switch {
	case sym == returnSym:
		return '\n', true
	case sym == tabSym:
		return '\t', true
	case sym >= 0x20 && sym <= 0x7e, sym >= 0xa0 && sym <= 0xff:
		return rune(sym), true
	case sym >= unicodeBase+0x100 && sym <= unicodeBase+unicode.MaxRune:
		r := rune(sym - unicodeBase)
		if back, ok := ForRune(r); ok && back == sym {
			return r, true
		}
	}
	return 0, false
}

// Name is how the fixture logs a keysym: its name in KEYS, else the character it types, else its number.
func Name(sym uint32) string {
	if name, ok := names[sym]; ok {
		return name
	}
	if r, ok := Rune(sym); ok && r != '\n' && r != '\t' {
		return string(r)
	}
	return fmt.Sprintf("keysym %#x", sym)
}
