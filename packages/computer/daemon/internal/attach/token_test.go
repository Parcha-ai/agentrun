package attach

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// A paired computer's token as serve makes it: art_ and 32 bytes in hex.
var pairedToken = "art_" + strings.Repeat("0f", 32)

// pair writes the token 0600 from its first byte, in a directory it makes 0700, by a rename that leaves nothing else
// behind; the umask cannot widen either.
func TestWriteTokenMakesTheFileItsUsersAloneFromTheStart(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	path := filepath.Join(t.TempDir(), "config", "agentrun", "computer.token")
	if err := WriteToken(path, pairedToken); err != nil {
		t.Fatal(err)
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil || dir.Mode().Perm() != 0o700 {
		t.Fatalf("the directory pair made: %v, %v; want 0700", dir.Mode(), err)
	}
	file, err := os.Lstat(path)
	if err != nil || !file.Mode().IsRegular() || file.Mode().Perm() != 0o600 {
		t.Fatalf("the token file: %v, %v; want a regular file, 0600", file.Mode(), err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("the directory holds %d entries, want the token file alone", len(entries))
	}
	if token, err := ReadToken(path); err != nil || token != pairedToken {
		t.Fatalf("ReadToken: %v", err)
	}
}

// attach refuses, in words that never hold the token, a token file that is a link, another user's, or readable by its
// group or other users.
func TestReadTokenRefusesALinkAnotherUsersFileAndOneOthersMayRead(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "computer.token")
	if err := WriteToken(good, pairedToken); err != nil {
		t.Fatal(err)
	}
	refused := func(name string, err error, want string) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), pairedToken) {
			t.Fatalf("%s: %v; want a refusal saying %q, without the token", name, err, want)
		}
	}
	link := filepath.Join(dir, "link.token")
	if err := os.Symlink(good, link); err != nil {
		t.Fatal(err)
	}
	_, err := ReadToken(link)
	refused("a link to a good token file", err, "is a symbolic link")
	_, err = readToken(good, os.Geteuid()+1)
	refused("another user's file", err, "attach reads only its own user's token")
	for _, mode := range []os.FileMode{0o640, 0o604, 0o620, 0o602} {
		if err := os.Chmod(good, mode); err != nil {
			t.Fatal(err)
		}
		_, err = ReadToken(good)
		refused("mode "+mode.String(), err, "chmod 600 "+good)
	}
	if err := os.Chmod(good, 0o400); err != nil {
		t.Fatal(err)
	}
	if token, err := ReadToken(good); err != nil || token != pairedToken {
		t.Fatalf("a 0400 file of its own: %v", err)
	}
	_, err = ReadToken(filepath.Join(dir, "none.token"))
	if !errors.Is(err, ErrNoToken) || !strings.Contains(err.Error(), "computerd pair") {
		t.Fatalf("no file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "junk.token"), []byte("not a token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ReadToken(filepath.Join(dir, "junk.token"))
	refused("a file with no token", err, "holds no machine token")
	fifo := filepath.Join(dir, "fifo.token")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ReadToken(fifo)
	refused("a FIFO", err, "is not a regular file")
}

// AGENTRUN_ATTACH_TOKEN wins over the file, a refused file included; with it empty, attach reads pair's file, and
// says where it came from.
func TestFromEnvTakesTheEnvironmentsTokenElsePairsFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs as root: root's token file is /etc/agentrun/computer.token, which a test must not write")
	}
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv(URLEnv, "wss://agentrun.example.com/v2/computers/attach")
	t.Setenv(TokenEnv, "")
	if _, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20); !errors.Is(err, ErrNoToken) || !strings.Contains(err.Error(), TokenEnv) {
		t.Fatalf("no env and no file: %v", err)
	}
	path := filepath.Join(config, "agentrun", "computer.token")
	if err := WriteToken(path, pairedToken); err != nil {
		t.Fatal(err)
	}
	cfg, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
	if err != nil || cfg.Token != pairedToken || cfg.Options.Token != pairedToken || cfg.TokenFile != path {
		t.Fatalf("pair's file: token from file %v, TokenFile %q, %v", cfg.Token == pairedToken, cfg.TokenFile, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("a file others may read: %v", err)
	}
	t.Setenv(TokenEnv, testToken)
	cfg, err = FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
	if err != nil || cfg.Token != testToken || cfg.TokenFile != "" {
		t.Fatalf("the environment's token: %v, TokenFile %q", err, cfg.TokenFile)
	}
}
