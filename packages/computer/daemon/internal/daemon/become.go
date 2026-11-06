package daemon

import "errors"

// Become is init's start on a vendor whose computers always run as root (Modal): not built yet.
func Become(uid, gid int, home, socket string) error {
	return errors.New("init --user is not built yet")
}

// prepareDir is not built yet.
func prepareDir(dir string, uid, gid int) error {
	return errors.New("prepareDir is not built yet")
}
