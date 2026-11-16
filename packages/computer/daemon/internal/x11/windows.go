package x11

import "fmt"

// The requests below are the apps group's: which top-level windows there are, whose they are and which is in front,
// and bringing one to the front. Each is one round trip, or none for those that answer nothing.

const (
	opGetWindowAttributes = 3
	opQueryTree           = 15
	opInternAtom          = 16
	opChangeProperty      = 18
	opGetProperty         = 20
	opSendEvent           = 25
)

// Predefined atoms the apps group reads.
const (
	AtomCardinal = 6
	AtomString   = 31
	AtomWindow   = 33
	AtomWMClass  = 67
	AtomWMName   = 39
)

// MaxProperty is the most bytes one GetProperty reads of a property: a window's class, name or pid, or the window
// manager's list of windows, which is 4 bytes a window.
const MaxProperty = 1 << 16

// InternAtom is the atom of a name. With onlyIfExists, a name no client made yet is 0, and nothing is made.
func (c *Conn) InternAtom(name string, onlyIfExists bool) (uint32, error) {
	only := byte(0)
	if onlyIfExists {
		only = 1
	}
	body := le.AppendUint16(nil, uint16(len(name)))
	body = append(body, 0, 0)
	body = append(body, name...)
	r, err := c.call(opInternAtom, only, body, smallReply)
	if err != nil {
		return 0, err
	}
	return le.Uint32(r[8:]), nil
}

// Property is a window property's value: its type, its format (8, 16 or 32 bits an item), and its bytes. A window
// without the property has type 0 and no bytes.
type Property struct {
	Type   uint32
	Format byte
	Value  []byte
}

// GetProperty reads up to MaxProperty bytes of a window's property, of any type, leaving it in place.
func (c *Conn) GetProperty(window, property uint32) (Property, error) {
	body := le.AppendUint32(nil, window)
	body = le.AppendUint32(body, property)
	body = le.AppendUint32(body, 0) // AnyPropertyType
	body = le.AppendUint32(body, 0) // long-offset
	body = le.AppendUint32(body, MaxProperty/4)
	r, err := c.call(opGetProperty, 0, body, MaxProperty)
	if err != nil {
		return Property{}, err
	}
	format, typ, items := r[1], le.Uint32(r[8:]), int(le.Uint32(r[16:]))
	size := items
	switch format {
	case 16:
		size *= 2
	case 32:
		size *= 4
	}
	if len(r) < 32+size {
		return Property{}, fmt.Errorf("GetProperty gave %d bytes for %d items of %d bits", len(r)-32, items, format)
	}
	return Property{Type: typ, Format: format, Value: r[32 : 32+size]}, nil
}

// Cardinals is a format-32 property's items; nil for any other.
func (p Property) Cardinals() []uint32 {
	if p.Format != 32 {
		return nil
	}
	out := make([]uint32, len(p.Value)/4)
	for i := range out {
		out[i] = le.Uint32(p.Value[4*i:])
	}
	return out
}

// QueryTree is a window's children, bottom of the stack first.
func (c *Conn) QueryTree(window uint32) ([]uint32, error) {
	r, err := c.call(opQueryTree, 0, le.AppendUint32(nil, window), MaxProperty*4)
	if err != nil {
		return nil, err
	}
	n := int(le.Uint16(r[16:]))
	if len(r) < 32+4*n {
		return nil, fmt.Errorf("QueryTree gave %d bytes for %d children", len(r)-32, n)
	}
	out := make([]uint32, n)
	for i := range out {
		out[i] = le.Uint32(r[32+4*i:])
	}
	return out, nil
}

// Map states, as GetWindowAttributes gives them.
const (
	IsUnmapped   = 0
	IsUnviewable = 1
	IsViewable   = 2
)

// Attributes is what GetWindowAttributes says of a window that the apps group uses.
type Attributes struct {
	MapState         byte
	OverrideRedirect bool
}

// GetWindowAttributes reads whether a window is mapped and viewable, and whether it bypasses the window manager.
func (c *Conn) GetWindowAttributes(window uint32) (Attributes, error) {
	r, err := c.call(opGetWindowAttributes, 0, le.AppendUint32(nil, window), smallReply)
	if err != nil {
		return Attributes{}, err
	}
	return Attributes{MapState: r[26], OverrideRedirect: r[27] == 1}, nil
}

// ChangeProperty buffers replacing a window's property with value, of type and format (8 or 32).
func (c *Conn) ChangeProperty(window, property, typ uint32, format byte, value []byte) error {
	unit := int(format) / 8
	if unit == 0 || len(value)%unit != 0 {
		return fmt.Errorf("%d bytes are not items of %d bits", len(value), format)
	}
	body := le.AppendUint32(nil, window)
	body = le.AppendUint32(body, property)
	body = le.AppendUint32(body, typ)
	body = append(body, format, 0, 0, 0)
	body = le.AppendUint32(body, uint32(len(value)/unit))
	body = append(body, value...)
	_, err := c.buffer(opChangeProperty, 0, body, noReply) // mode Replace
	return err
}

// Raise buffers putting the window on top of its siblings. A window manager may take it as a request it decides.
func (c *Conn) Raise(window uint32) error {
	body := le.AppendUint32(nil, window)
	body = le.AppendUint16(body, 0x40) // stack-mode
	body = append(body, 0, 0)
	body = le.AppendUint32(body, 0) // Above
	_, err := c.buffer(opConfigureWindow, 0, body, noReply)
	return err
}

// Event masks SendEvent sends a window manager's client messages with.
const (
	SubstructureNotifyMask   = 0x80000
	SubstructureRedirectMask = 0x100000
)

// ClientMessageEvent is the ClientMessage event's type.
const ClientMessageEvent = 33

// SendClientMessage buffers a ClientMessage of type messageType about window, with five 32-bit items, to the root
// window, as a window manager hears them (EWMH: _NET_ACTIVE_WINDOW).
func (c *Conn) SendClientMessage(window, messageType uint32, data [5]uint32) error {
	event := []byte{ClientMessageEvent, 32, 0, 0}
	event = le.AppendUint32(event, window)
	event = le.AppendUint32(event, messageType)
	for _, item := range data {
		event = le.AppendUint32(event, item)
	}
	body := le.AppendUint32(nil, c.screen.Root)
	body = le.AppendUint32(body, SubstructureNotifyMask|SubstructureRedirectMask)
	body = append(body, event...)
	_, err := c.buffer(opSendEvent, 0, body, noReply) // propagate: false
	return err
}
