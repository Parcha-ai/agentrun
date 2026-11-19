package attach

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ErrNoToken is a token file that is not there: the machine is not paired here.
var ErrNoToken = errors.New("no token file")

// TokenPath is where `computerd pair` keeps a paired machine's token and `computerd attach` reads it, on a box with no
// keychain: root's in /etc/agentrun/computer.token, any other user's in $XDG_CONFIG_HOME/agentrun/computer.token
// (~/.config by default).
func TokenPath() (string, error) {
	if os.Geteuid() == 0 {
		return "/etc/agentrun/computer.token", nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("no place for this machine's token file: %w", err)
	}
	return filepath.Join(dir, "agentrun", "computer.token"), nil
}

// lockTokenDir holds an exclusive lock on path's directory, which it makes 0700 when it is not there, until unlock: one
// pairing at a time checks for the token file and writes it. A directory it made and nothing was written to is removed
// at unlock.
func lockTokenDir(path string) (unlock func(), err error) {
	dir := filepath.Dir(path)
	_, statErr := os.Lstat(dir)
	made := errors.Is(statErr, fs.ErrNotExist)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("cannot make the token file's directory: %w", err)
	}
	d, err := os.OpenFile(dir, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err == nil {
		if err = syscall.Flock(int(d.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			_ = d.Close()
		}
	}
	unmake := func() {
		if made {
			_ = os.Remove(dir) // only an empty directory goes
		}
	}
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return nil, fmt.Errorf("another computerd pair is pairing this machine as this user now (it holds %s): let it finish", dir)
	}
	if err != nil {
		unmake()
		return nil, fmt.Errorf("cannot lock the token file's directory %s: %w", dir, err)
	}
	return func() {
		unmake()
		_ = d.Close()
	}, nil
}

// WriteToken keeps token at path, its user's alone from the start: a file in the same directory made with O_EXCL and
// O_NOFOLLOW, mode 0600, then renamed over path, so no reader ever sees a part of it or a wider mode. A directory it
// makes is 0700. The token is in no error it gives.
func WriteToken(path, token string) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("cannot make the token file's directory: %w", err)
	}
	var file *os.File
	var temp string
	for try := 0; ; try++ {
		suffix := make([]byte, 8)
		_, _ = rand.Read(suffix)
		temp = filepath.Join(dir, "."+filepath.Base(path)+"."+hex.EncodeToString(suffix))
		file, err = os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
		if !errors.Is(err, fs.ErrExist) || try == 3 {
			break
		}
	}
	if err != nil {
		return fmt.Errorf("cannot make the token file in %s: %w", dir, err)
	}
	defer func() {
		if err != nil {
			_ = os.Remove(temp)
		}
	}()
	_, err = io.WriteString(file, token+"\n")
	if err == nil {
		err = file.Sync()
	}
	if closed := file.Close(); err == nil {
		err = closed
	}
	if err != nil {
		return fmt.Errorf("cannot write the token file in %s: %w", dir, err)
	}
	if err = os.Rename(temp, path); err != nil {
		return fmt.Errorf("cannot put the token file at %s: %w", path, err)
	}
	if d, opened := os.Open(dir); opened == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// ReadToken reads the token at path as attach takes it, from a file that is no link, its running user's, and readable
// by no group or other user: lstat first, then the file opened with O_NOFOLLOW and its open descriptor checked, so what
// is read is what was checked. A refusal says why and what to do, and never holds the token.
func ReadToken(path string) (string, error) {
	return readToken(path, os.Geteuid())
}

func readToken(path string, uid int) (string, error) {
	link := fmt.Errorf("the token file %s is a symbolic link: attach reads only the file itself, its user's alone; delete %s and pair again", path, path)
	info, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", fmt.Errorf("%w at %s: pair this machine first (computerd pair <server URL>), or set %s", ErrNoToken, path, TokenEnv)
	case err != nil:
		return "", fmt.Errorf("cannot read the token file %s: %w", path, err)
	case info.Mode()&fs.ModeSymlink != 0:
		return "", link
	}
	// O_NONBLOCK: a FIFO put there never holds the open; it is refused below as no regular file.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ELOOP) {
		return "", link
	}
	if err != nil {
		return "", fmt.Errorf("cannot read the token file %s: %w", path, err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("cannot read the token file %s: %w", path, err)
	}
	st, ok := opened.Sys().(*syscall.Stat_t)
	switch {
	case !opened.Mode().IsRegular() || !ok:
		return "", fmt.Errorf("the token file %s is not a regular file: delete it and pair again", path)
	case int(st.Uid) != uid:
		return "", fmt.Errorf("the token file %s belongs to uid %d, and attach runs as uid %d: attach reads only its own user's token; pair again as uid %d", path, st.Uid, uid, uid)
	case opened.Mode().Perm()&0o077 != 0:
		return "", fmt.Errorf("the token file %s may be read by its group or other users (mode %04o): attach reads a token file only its user can read; chmod 600 %s, and if another user may have read it, remove the computer on the console's Computers page, delete it and pair again", path, opened.Mode().Perm(), path)
	}
	data, err := io.ReadAll(io.LimitReader(file, 256))
	if err != nil {
		return "", fmt.Errorf("cannot read the token file %s: %w", path, err)
	}
	token := strings.TrimSuffix(string(data), "\n")
	if !tokenPattern.MatchString(token) {
		return "", fmt.Errorf("the token file %s holds no machine token (art_ and 64 lowercase hex): delete it and pair again", path)
	}
	return token, nil
}
