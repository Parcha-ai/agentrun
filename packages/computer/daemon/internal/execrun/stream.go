// Copyright 2026 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/server/process.go (executionStream) and
// execution_policy.go (resolveByteLimit). Changed for the open platform: the limit is always set, the reader is
// closed by its owner, and limits are checked against one maximum with the protocol's error kinds.

package execrun

import (
	"bytes"
	"io"
	"os"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// outputStream reads the whole of one stream and keeps only its first limit bytes, so the program never blocks on a
// full pipe.
type outputStream struct {
	buffer         bytes.Buffer
	limit          int
	truncated      bool
	reader, writer *os.File
	done           chan struct{}
}

func (b *outputStream) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := b.limit - b.buffer.Len(); n > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	b.buffer.Write(p)
	return n, nil
}

func newOutputStream(limit int) (*outputStream, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	return &outputStream{limit: limit, reader: r, writer: w, done: make(chan struct{})}, nil
}

// collect closes this process's copy of the write end and reads until every writer has closed its own.
func (b *outputStream) collect() {
	_ = b.writer.Close()
	go func() {
		_, _ = io.Copy(b, b.reader)
		close(b.done)
	}()
}

// bytes is the kept output, never nil, so it marshals as "" and not null.
func (b *outputStream) bytes() []byte {
	return append([]byte{}, b.buffer.Bytes()...)
}

// resolveByteLimit is the requested limit, or the default; zero and negative values, and values over the maximum,
// are refused.
func resolveByteLimit(name string, requested *int, def, maxLimit int) (int, error) {
	if requested == nil {
		return def, nil
	}
	if *requested <= 0 {
		return 0, rpc.Errorf(rpc.KindInvalid, "%s must be positive", name)
	}
	if *requested > maxLimit {
		return 0, rpc.Errorf(rpc.KindInvalid, "%s %d is over the most a reply line holds, %d", name, *requested, maxLimit)
	}
	return *requested, nil
}
