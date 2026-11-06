// Package rpc serves JSON-RPC 2.0, one UTF-8 JSON object per line, over any reader and writer.
package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
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
	KindExists      Kind = "exists"
	KindNotDir      Kind = "not_dir"
	KindIsDir       Kind = "is_dir"
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

// Server dispatches requests to handlers, each in a goroutine of its own: replies may leave out of order.
type Server struct {
	handlers map[string]Handler
	log      *log.Logger
}

func NewServer(handlers map[string]Handler, logger *log.Logger) *Server {
	return &Server{handlers: handlers, log: logger}
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type wireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Kind Kind `json:"kind"`
	} `json:"data"`
}

type resultReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type errorReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   wireError       `json:"error"`
}

var nullID = json.RawMessage("null")

type session struct {
	server   *Server
	ctx      context.Context
	out      io.Writer
	writeMu  sync.Mutex
	mu       sync.Mutex
	inFlight map[string]context.CancelFunc
	locals   map[any]io.Closer
	wg       sync.WaitGroup
}

// Serve reads requests from r and writes replies to w until r ends or ctx is done, then cancels what still runs and
// returns once every handler has. It returns nil at the end of r or on ctx; a read error otherwise. On ctx it closes r
// when r is an io.Closer, which ends the read; the read of an r that cannot be closed ends when its input does, and any
// line it reads after Serve returned is dropped.
func (s *Server) Serve(ctx context.Context, r io.Reader, w io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sess := &session{server: s, ctx: ctx, out: w, inFlight: map[string]context.CancelFunc{}}
	type line struct {
		data      []byte
		oversized bool
	}
	lines := make(chan line)
	readDone := make(chan error, 1)
	go func() {
		readDone <- readLines(r, MaxLine, func(data []byte, oversized bool) {
			select {
			case lines <- line{data, oversized}:
			case <-ctx.Done():
			}
		})
	}()
	var err error
loop:
	for {
		select {
		case l := <-lines:
			sess.handleLine(l.data, l.oversized)
		case err = <-readDone:
			break loop
		case <-ctx.Done():
			if closer, ok := r.(io.Closer); ok {
				_ = closer.Close()
			}
			break loop
		}
	}
	cancel()
	sess.wg.Wait()
	sess.closeLocals()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// readLines calls fn with each line, without its newline (or CRLF). A line over max bytes is cut to its first bytes and
// passed with oversized set; reading goes on at the next line.
func readLines(r io.Reader, max int, fn func(line []byte, oversized bool)) error {
	reader := bufio.NewReaderSize(r, 64<<10)
	var line []byte
	oversized := false
	for {
		chunk, err := reader.ReadSlice('\n')
		complete := len(chunk) > 0 && chunk[len(chunk)-1] == '\n'
		data := chunk
		if complete {
			data = chunk[:len(chunk)-1]
		}
		if !oversized && len(line)+len(data) > max {
			oversized = true
			if len(line) < idPrefix {
				line = append(line, data[:min(len(data), idPrefix-len(line))]...)
			}
		} else if !oversized {
			line = append(line, data...)
		}
		if complete || (err != nil && !errors.Is(err, bufio.ErrBufferFull) && len(line) > 0) {
			fn(bytes.TrimSuffix(line, []byte("\r")), oversized)
			line, oversized = nil, false
		}
		if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}

// idPrefix is how much of an oversized line is kept to find its id.
const idPrefix = 4096

// idOf reads the top-level "id" from the start of a line that may be cut short.
func idOf(prefix []byte) json.RawMessage {
	dec := json.NewDecoder(bytes.NewReader(prefix))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nullID
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nullID
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nullID
		}
		if key == "id" {
			return value
		}
	}
	return nullID
}

func (sess *session) handleLine(line []byte, oversized bool) {
	if oversized {
		sess.replyError(idOf(line), &Error{Code: CodeInvalidRequest, Kind: KindLimit, Message: fmt.Sprintf("the request is over the %d-byte line limit", MaxLine)})
		return
	}
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		sess.replyError(nullID, &Error{Code: CodeParse, Kind: KindInvalid, Message: "the line is not JSON: " + err.Error()})
		return
	}
	notification := req.ID == nil
	if req.JSONRPC != "2.0" || req.Method == "" {
		if !notification {
			sess.replyError(req.ID, &Error{Code: CodeInvalidRequest, Kind: KindInvalid, Message: `a request needs "jsonrpc": "2.0" and a method`})
		}
		return
	}
	if req.Method == CancelMethod {
		var params struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(req.Params, &params) == nil && params.ID != nil {
			sess.cancel(params.ID)
		}
		return
	}
	if notification {
		return
	}
	handler, ok := sess.server.handlers[req.Method]
	if !ok {
		sess.replyError(req.ID, &Error{Code: CodeMethodNotFound, Kind: KindUnsupported, Message: fmt.Sprintf("this daemon has no method %q", req.Method)})
		return
	}
	key := canonical(req.ID)
	ctx, cancel := context.WithCancel(context.WithValue(sess.ctx, callKey{}, &call{sess: sess, id: req.ID}))
	sess.mu.Lock()
	if _, busy := sess.inFlight[key]; busy {
		sess.mu.Unlock()
		cancel()
		sess.replyError(req.ID, &Error{Code: CodeInvalidRequest, Kind: KindInvalid, Message: fmt.Sprintf("request id %s is already in flight", req.ID)})
		return
	}
	sess.inFlight[key] = cancel
	sess.mu.Unlock()
	sess.wg.Add(1)
	go func() {
		defer sess.wg.Done()
		defer func() {
			sess.mu.Lock()
			delete(sess.inFlight, key)
			sess.mu.Unlock()
			cancel()
		}()
		result, err := sess.call(ctx, handler, req.Params)
		if err != nil {
			sess.replyError(req.ID, toError(ctx, err))
			return
		}
		sess.write(resultReply{JSONRPC: "2.0", ID: req.ID, Result: result}, req.ID)
	}()
}

func (sess *session) call(ctx context.Context, handler Handler, params json.RawMessage) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			sess.server.log.Printf("handler panic: %v", p)
			err = fmt.Errorf("the daemon failed: %v", p)
		}
	}()
	return handler(ctx, params)
}

func toError(ctx context.Context, err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	if ctx.Err() != nil {
		return Errorf(KindAborted, "the request was cancelled")
	}
	return &Error{Code: CodeServer, Kind: KindInvalid, Message: err.Error()}
}

func (sess *session) cancel(id json.RawMessage) {
	sess.mu.Lock()
	cancel := sess.inFlight[canonical(id)]
	sess.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func canonical(id json.RawMessage) string {
	var buf bytes.Buffer
	if json.Compact(&buf, id) != nil {
		return string(id)
	}
	return buf.String()
}

func (sess *session) replyError(id json.RawMessage, e *Error) {
	reply := errorReply{JSONRPC: "2.0", ID: id, Error: wireError{Code: e.Code, Message: e.Message}}
	reply.Error.Data.Kind = e.Kind
	sess.write(reply, id)
}

func (sess *session) write(reply any, id json.RawMessage) {
	data, err := json.Marshal(reply)
	if err == nil && len(data) > MaxLine {
		limit := wireError{Code: CodeServer, Message: fmt.Sprintf("the reply is %d bytes, over the %d-byte line limit", len(data), MaxLine)}
		limit.Data.Kind = KindLimit
		data, err = json.Marshal(errorReply{JSONRPC: "2.0", ID: id, Error: limit})
	}
	if err != nil {
		sess.server.log.Printf("cannot encode a reply: %v", err)
		return
	}
	if err := sess.writeLine(data); err != nil {
		sess.server.log.Printf("cannot write a reply: %v", err)
	}
}

func (sess *session) writeLine(data []byte) error {
	sess.writeMu.Lock()
	defer sess.writeMu.Unlock()
	_, err := sess.out.Write(append(data, '\n'))
	return err
}

type notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type callKey struct{}

// call is what a handler's context knows of its request.
type call struct {
	sess *session
	id   json.RawMessage
}

// Notify sends a notification on the connection of the request ctx belongs to. The handler's own goroutine writes it,
// so its notifications leave in order and before its reply. It waits while the client does not read.
func Notify(ctx context.Context, method string, params any) error {
	c, ok := ctx.Value(callKey{}).(*call)
	if !ok {
		return errors.New("rpc: Notify outside a request")
	}
	data, err := json.Marshal(notification{JSONRPC: "2.0", Method: method, Params: params})
	if err != nil {
		return err
	}
	if len(data) > MaxLine {
		return Errorf(KindLimit, "the %s notification is %d bytes, over the %d-byte line limit", method, len(data), MaxLine)
	}
	return c.sess.writeLine(data)
}

// RequestID is the id of the request ctx belongs to.
func RequestID(ctx context.Context) json.RawMessage {
	if c, ok := ctx.Value(callKey{}).(*call); ok {
		return c.id
	}
	return nullID
}

// Local returns the value the connection of ctx keeps under key, made by create on its first use. When the connection
// ends, once every handler has returned, each value is closed.
func Local(ctx context.Context, key any, create func() io.Closer) io.Closer {
	c := ctx.Value(callKey{}).(*call)
	c.sess.mu.Lock()
	defer c.sess.mu.Unlock()
	value, ok := c.sess.locals[key]
	if !ok {
		if c.sess.locals == nil {
			c.sess.locals = map[any]io.Closer{}
		}
		value = create()
		c.sess.locals[key] = value
	}
	return value
}

// closeLocals closes what the connection kept, once every handler has returned.
func (sess *session) closeLocals() {
	for _, value := range sess.locals {
		if err := value.Close(); err != nil {
			sess.server.log.Printf("cannot close what the connection kept: %v", err)
		}
	}
}
