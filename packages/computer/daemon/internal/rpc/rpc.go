// Package rpc serves JSON-RPC 2.0, one UTF-8 JSON object per line, over any reader and writer.
package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
)

// MaxLine is the longest line, in bytes without its newline, read or written.
const MaxLine = 1 << 20

// CancelMethod is the notification that cancels a request by id.
const CancelMethod = "$/cancelRequest"

const (
	CodeParse            = -32700
	CodeInvalidRequest   = -32600
	CodeMethodNotFound   = -32601
	CodeInvalidParams    = -32602
	CodeServer           = -32000
	CodeRequestCancelled = -32800
)

// Kind is the protocol's error kind, sent as error.data.kind.
type Kind string

const (
	KindNotFound    Kind = "not_found"
	KindInvalid     Kind = "invalid"
	KindTimeout     Kind = "timeout"
	KindAborted     Kind = "aborted"
	KindDenied      Kind = "denied"
	KindLimit       Kind = "limit"
	KindUnsupported Kind = "unsupported"
)

// Error is a protocol error.
type Error struct {
	Code    int
	Message string
	Kind    Kind
}

func (e *Error) Error() string { return e.Message }

// Errorf makes an error of a kind, with the JSON-RPC code that kind takes.
func Errorf(kind Kind, format string, args ...any) *Error {
	code := CodeServer
	switch kind {
	case KindInvalid:
		code = CodeInvalidParams
	case KindAborted:
		code = CodeRequestCancelled
	}
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), Kind: kind}
}

// Handler answers one request. Its context ends when the request is cancelled or the input ends.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// Server dispatches requests to handlers.
type Server struct {
	handlers map[string]Handler
	log      *log.Logger
}

func NewServer(handlers map[string]Handler, logger *log.Logger) *Server {
	return &Server{handlers: handlers, log: logger}
}

// Serve reads requests from r and writes replies to w until r ends or ctx is done.
func (s *Server) Serve(ctx context.Context, r io.Reader, w io.Writer) error {
	return errors.New("not implemented")
}
