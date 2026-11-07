package process

import (
	"fmt"
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

// openPty opens a terminal: the master, which the daemon keeps (non-blocking, so reads and writes have deadlines and
// end on Close), and the slave, for the program. See pty(7).
func openPty(size Size) (master, slave *os.File, err error) {
	fd, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("cannot open /dev/ptmx: %w", err)
	}
	master = os.NewFile(uintptr(fd), "/dev/ptmx")
	var unlock int32
	var n uint32
	if err := ioctl(uintptr(fd), syscall.TIOCSPTLCK, unsafe.Pointer(&unlock)); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("cannot unlock a terminal: %w", err)
	}
	if err := ioctl(uintptr(fd), syscall.TIOCGPTN, unsafe.Pointer(&n)); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("cannot name a terminal: %w", err)
	}
	name := "/dev/pts/" + strconv.FormatUint(uint64(n), 10)
	sfd, err := syscall.Open(name, syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("cannot open %s: %w", name, err)
	}
	slave = os.NewFile(uintptr(sfd), name)
	if err := setSize(master, size); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, nil, err
	}
	return master, slave, nil
}

// setSize sets a terminal's size; the kernel sends SIGWINCH to its foreground process group.
func setSize(master *os.File, size Size) error {
	ws := struct{ rows, cols, x, y uint16 }{uint16(size.Rows), uint16(size.Cols), 0, 0}
	conn, err := master.SyscallConn()
	if err != nil {
		return err
	}
	var ioErr error
	if err := conn.Control(func(fd uintptr) { ioErr = ioctl(fd, syscall.TIOCSWINSZ, unsafe.Pointer(&ws)) }); err != nil {
		return err
	}
	if ioErr != nil {
		return fmt.Errorf("cannot resize the terminal: %w", ioErr)
	}
	return nil
}

func ioctl(fd, request uintptr, arg unsafe.Pointer) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, uintptr(arg)); errno != 0 {
		return errno
	}
	return nil
}
