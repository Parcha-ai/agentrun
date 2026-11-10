// The client of a fake program (test/fake-program.mjs): a test's fake CLI, such as the fake docker, is this binary at
// the path the provider execs, and the program itself runs in the test's process behind a unix socket named by a hash
// of that path (socketOf in fake-program.mjs: abstract on Linux, a short file in /tmp elsewhere, so no TMPDIR's length
// matters). It forwards its argv, its pid and its stdin there, and writes back the program's stdout, stderr and exit
// code, so the provider still execs a real program and reads real pipes, and no test pays a Node start per call.
//
// The frames, each a type byte, a big-endian uint32 length and the bytes: to the program, 0 stdin and 1 stdin's end;
// from it, 1 stdout, 2 stderr and 3 the exit code (four bytes). The first thing sent is one JSON line: argv and pid.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"time"
)

// socketOf is where the program at path takes its calls, as fake-program.mjs's socketOf names it.
func socketOf(path string) string {
	sum := sha256.Sum256([]byte(path))
	name := "agentrun-fake-" + hex.EncodeToString(sum[:])[:32]
	if runtime.GOOS == "linux" {
		return "@" + name
	}
	return "/tmp/" + name + ".sock"
}

func main() {
	var conn net.Conn
	var err error
	at := socketOf(os.Args[0])
	// The program's server listens before the test hands the path to the provider; a short retry covers a busy host.
	for tries := 0; tries < 100; tries++ {
		if conn, err = net.Dial("unix", at); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake program: %s cannot reach its program at %s: %v\n", os.Args[0], at, err)
		os.Exit(2)
	}
	header, _ := json.Marshal(map[string]any{"argv": os.Args[1:], "pid": os.Getpid()})
	if _, err := conn.Write(append(header, '\n')); err != nil {
		os.Exit(2)
	}
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 && send(conn, 0, buf[:n]) != nil {
				return
			}
			if err != nil {
				_ = send(conn, 1, nil)
				return
			}
		}
	}()
	in := bufio.NewReader(conn)
	head := make([]byte, 5)
	for {
		if _, err := io.ReadFull(in, head); err != nil {
			fmt.Fprintln(os.Stderr, "fake program: the program ended with no exit code")
			os.Exit(2)
		}
		body := make([]byte, binary.BigEndian.Uint32(head[1:]))
		if _, err := io.ReadFull(in, body); err != nil {
			os.Exit(2)
		}
		switch head[0] {
		case 1:
			_, _ = os.Stdout.Write(body)
		case 2:
			_, _ = os.Stderr.Write(body)
		case 3:
			os.Exit(int(binary.BigEndian.Uint32(body)))
		}
	}
}

func send(conn net.Conn, kind byte, data []byte) error {
	frame := make([]byte, 5+len(data))
	frame[0] = kind
	binary.BigEndian.PutUint32(frame[1:], uint32(len(data)))
	copy(frame[5:], data)
	_, err := conn.Write(frame)
	return err
}
