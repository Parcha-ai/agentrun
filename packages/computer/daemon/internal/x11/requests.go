package x11

import (
	"fmt"
	"image"
	"unicode"
)

// Core request opcodes, from the protocol's encoding section.
const (
	opCreateWindow           = 1
	opChangeWindowAttributes = 2
	opMapWindow              = 8
	opConfigureWindow        = 12
	opGetGeometry            = 14
	opQueryPointer           = 38
	opSetInputFocus          = 42
	opCreateGC               = 55
	opChangeGC               = 56
	opPolyFillRectangle      = 70
	opGetImage               = 73
	opQueryExtension         = 98
	opChangeKeyboardMapping  = 100
	opGetKeyboardMapping     = 101

	// XTEST's minor opcodes.
	xtestGetVersion = 0
	xtestFakeInput  = 2
)

// Extension is QueryExtension's answer.
type Extension struct {
	Present bool
	Major   byte
}

// QueryExtension asks whether the server has an extension, and its major opcode.
func (c *Conn) QueryExtension(name string) (Extension, error) {
	body := le.AppendUint16(nil, uint16(len(name)))
	body = append(body, 0, 0)
	body = append(body, name...)
	r, err := c.call(opQueryExtension, 0, body)
	if err != nil {
		return Extension{}, err
	}
	return Extension{Present: r[8] == 1, Major: r[9]}, nil
}

// InitXTest finds the XTEST extension, which FakeInput needs, and asks for version 2.2 of it.
func (c *Conn) InitXTest() error {
	ext, err := c.QueryExtension("XTEST")
	if err != nil {
		return err
	}
	if !ext.Present {
		return fmt.Errorf("the X server has no XTEST extension, which input needs")
	}
	body := []byte{2, 0}
	body = le.AppendUint16(body, 2)
	r, err := c.call(ext.Major, xtestGetVersion, body)
	if err != nil {
		return fmt.Errorf("XTEST's GetVersion: %w", err)
	}
	if r[1] < 2 {
		return fmt.Errorf("the X server's XTEST is version %d.%d; input needs 2.x", r[1], le.Uint16(r[8:]))
	}
	c.xtest = ext.Major
	return nil
}

// FakeInput buffers one XTEST event: a key (detail is its keycode) or button (detail is its number) press or release,
// or a motion to (x, y) on the screen's root. It is written at the next Flush, Sync, or request with a reply.
func (c *Conn) FakeInput(kind, detail byte, x, y int) error {
	if c.xtest == 0 {
		return fmt.Errorf("FakeInput before InitXTest")
	}
	body := []byte{kind, detail, 0, 0}
	body = le.AppendUint32(body, 0) // time: CurrentTime, no delay
	root := uint32(0)
	if kind == MotionNotify {
		root = c.screen.Root
	}
	body = le.AppendUint32(body, root)
	body = append(body, make([]byte, 8)...)
	body = le.AppendUint16(body, uint16(int16(x)))
	body = le.AppendUint16(body, uint16(int16(y)))
	body = append(body, make([]byte, 7)...)
	body = append(body, 0) // deviceid: the core devices
	_, err := c.buffer(c.xtest, xtestFakeInput, body, false)
	return err
}

// RootSize is the root window's size now, which a RandR change may have moved since the setup.
func (c *Conn) RootSize() (width, height int, err error) {
	r, err := c.call(opGetGeometry, 0, le.AppendUint32(nil, c.screen.Root))
	if err != nil {
		return 0, 0, err
	}
	return int(le.Uint16(r[16:])), int(le.Uint16(r[18:])), nil
}

// QueryPointer is where the pointer is on the root window.
func (c *Conn) QueryPointer() (x, y int, err error) {
	r, err := c.call(opQueryPointer, 0, le.AppendUint32(nil, c.screen.Root))
	if err != nil {
		return 0, 0, err
	}
	return int(int16(le.Uint16(r[16:]))), int(int16(le.Uint16(r[18:]))), nil
}

// LockMask is the Lock modifier's bit in State: Caps Lock, on.
const LockMask = 0x2

// State is the core keyboard and pointer state now: which modifiers are on, and which buttons are down (QueryPointer's
// mask).
func (c *Conn) State() (uint16, error) {
	r, err := c.call(opQueryPointer, 0, le.AppendUint32(nil, c.screen.Root))
	if err != nil {
		return 0, err
	}
	return le.Uint16(r[24:]), nil
}

// GetImage reads a rectangle of the root window as ZPixmap and converts it to RGBA through the visual's masks.
func (c *Conn) GetImage(x, y, width, height int) (*image.RGBA, error) {
	if width*height > MaxImagePixels {
		return nil, fmt.Errorf("a %dx%d image is over the %d pixels one GetImage reads", width, height, MaxImagePixels)
	}
	body := le.AppendUint32(nil, c.screen.Root)
	body = le.AppendUint16(body, uint16(int16(x)))
	body = le.AppendUint16(body, uint16(int16(y)))
	body = le.AppendUint16(body, uint16(width))
	body = le.AppendUint16(body, uint16(height))
	body = le.AppendUint32(body, 0xffffffff)
	r, err := c.call(opGetImage, 2, body)
	if err != nil {
		return nil, err
	}
	depth, id := r[1], le.Uint32(r[8:])
	if id == 0 {
		id = c.screen.Visual
	}
	v, ok := c.visuals[id]
	if !ok || (v.class != 4 && v.class != 5) {
		return nil, fmt.Errorf("the screen's visual %#x is not TrueColor or DirectColor; only those are read", id)
	}
	f, ok := c.formats[depth]
	if !ok || (f.bpp != 16 && f.bpp != 24 && f.bpp != 32) {
		return nil, fmt.Errorf("the screen's depth %d is %d bits a pixel; only 16, 24 and 32 are read", depth, f.bpp)
	}
	stride := (width*f.bpp + f.pad - 1) / f.pad * f.pad / 8
	data := r[32:]
	if len(data) < stride*height {
		return nil, fmt.Errorf("GetImage gave %d bytes for %dx%d at %d bits a pixel", len(data), width, height, f.bpp)
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	bytes := f.bpp / 8
	for row := 0; row < height; row++ {
		line := data[row*stride:]
		out := img.Pix[row*img.Stride:]
		for col := 0; col < width; col++ {
			p := line[col*bytes : col*bytes+bytes]
			var pixel uint32
			for i := 0; i < bytes; i++ {
				if c.imageMSB {
					pixel = pixel<<8 | uint32(p[i])
				} else {
					pixel |= uint32(p[i]) << (8 * i)
				}
			}
			for ch := 0; ch < 3; ch++ {
				out[col*4+ch] = v.channels[ch].level(pixel)
			}
			out[col*4+3] = 0xff
		}
	}
	return img, nil
}

// level is the channel's value in pixel, scaled to 8 bits.
func (ch channel) level(pixel uint32) byte {
	if ch.bits == 0 {
		return 0
	}
	value := (pixel & ch.mask) >> ch.shift
	if ch.bits >= 8 {
		return byte(value >> (ch.bits - 8))
	}
	return byte(value * 255 / (1<<ch.bits - 1))
}

// Pixel is the pixel value of an RGB color in the screen's visual, for drawing.
func (c *Conn) Pixel(r, g, b byte) uint32 {
	v := c.visuals[c.screen.Visual]
	var pixel uint32
	for i, level := range []byte{r, g, b} {
		ch := v.channels[i]
		value := uint32(level)
		if ch.bits < 8 {
			value >>= 8 - ch.bits
		} else {
			value <<= ch.bits - 8
		}
		pixel |= value << ch.shift & ch.mask
	}
	return pixel
}

// Keymap is the server's keyboard map: PerCode keysyms for each keycode from Min, 0 for NoSymbol.
type Keymap struct {
	Min     byte
	PerCode int
	Syms    []uint32
}

// KeyboardMapping reads the keyboard map of every keycode.
func (c *Conn) KeyboardMapping() (*Keymap, error) {
	count := int(c.maxKey) - int(c.minKey) + 1
	r, err := c.call(opGetKeyboardMapping, 0, []byte{c.minKey, byte(count), 0, 0})
	if err != nil {
		return nil, err
	}
	per := int(r[1])
	if per == 0 || len(r) < 32+4*count*per {
		return nil, fmt.Errorf("GetKeyboardMapping gave %d bytes for %d keycodes of %d keysyms", len(r)-32, count, per)
	}
	k := &Keymap{Min: c.minKey, PerCode: per, Syms: make([]uint32, count*per)}
	for i := range k.Syms {
		k.Syms[i] = le.Uint32(r[32+4*i:])
	}
	return k, nil
}

// pair is a keycode's first group, as the core protocol reads it: with no shifted keysym, a letter's shifted one is
// its capital, and anything else's is itself.
func (k *Keymap) pair(code byte) (plain, shifted uint32) {
	i := (int(code) - int(k.Min)) * k.PerCode
	if i < 0 || i >= len(k.Syms) {
		return 0, 0
	}
	plain = k.Syms[i]
	if k.PerCode > 1 {
		shifted = k.Syms[i+1]
	}
	if shifted == 0 {
		lower, upper := caseOf(plain)
		plain, shifted = lower, upper
	}
	return plain, shifted
}

// Sym is the keysym a keycode gives, with shift or without.
func (k *Keymap) Sym(code byte, shift bool) uint32 {
	plain, shifted := k.pair(code)
	if shift {
		return shifted
	}
	return plain
}

// Find is a keycode that gives sym, and whether it takes shift: one that gives it unshifted first.
func (k *Keymap) Find(sym uint32) (code byte, shift bool, ok bool) {
	count := len(k.Syms) / k.PerCode
	for _, shifted := range []bool{false, true} {
		for i := 0; i < count; i++ {
			code := k.Min + byte(i)
			if sym != 0 && k.Sym(code, shifted) == sym {
				return code, shifted, true
			}
		}
	}
	return 0, false, false
}

// Unused is every keycode with no keysym at all, which the keysym remap may take.
func (k *Keymap) Unused() []byte {
	var out []byte
	for i := 0; i < len(k.Syms)/k.PerCode; i++ {
		empty := true
		for _, sym := range k.Syms[i*k.PerCode : (i+1)*k.PerCode] {
			empty = empty && sym == 0
		}
		if empty {
			out = append(out, k.Min+byte(i))
		}
	}
	return out
}

// caseOf is a keysym's lower and upper case, for the letters of Latin-1 and Unicode; anything else is both.
func caseOf(sym uint32) (lower, upper uint32) {
	switch {
	case sym >= 'a' && sym <= 'z', sym >= 0xe0 && sym <= 0xfe && sym != 0xf7:
		return sym, sym - 0x20
	case sym >= 'A' && sym <= 'Z', sym >= 0xc0 && sym <= 0xde && sym != 0xd7:
		return sym + 0x20, sym
	case sym >= 0x01000100 && sym <= 0x0110ffff:
		r := rune(sym - 0x01000000)
		return 0x01000000 + uint32(unicode.ToLower(r)), 0x01000000 + uint32(unicode.ToUpper(r))
	}
	return sym, sym
}

// ChangeKeyboardMapping buffers a new map for count keycodes from first: perCode keysyms each.
func (c *Conn) ChangeKeyboardMapping(first byte, perCode int, syms []uint32) error {
	if perCode <= 0 || len(syms)%perCode != 0 {
		return fmt.Errorf("%d keysyms are not %d a keycode", len(syms), perCode)
	}
	body := []byte{first, byte(perCode), 0, 0}
	for _, sym := range syms {
		body = le.AppendUint32(body, sym)
	}
	_, err := c.buffer(opChangeKeyboardMapping, byte(len(syms)/perCode), body, false)
	return err
}

// The requests below are the desktop fixture's: a window, its colors, and its focus.

// NewID is a fresh resource id for a window or graphics context.
func (c *Conn) NewID() uint32 {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	step := c.idMask & -c.idMask
	id := c.idBase | (c.nextID & c.idMask)
	c.nextID += step
	return id
}

// Window attribute and event mask bits.
const (
	CWBackPixel        = 0x2
	CWOverrideRedirect = 0x200
	CWEventMask        = 0x800

	KeyPressMask        = 0x1
	KeyReleaseMask      = 0x2
	ButtonPressMask     = 0x4
	ButtonReleaseMask   = 0x8
	ExposureMask        = 0x8000
	StructureNotifyMask = 0x20000
	FocusChangeMask     = 0x200000
)

// CreateWindow buffers a child of the root at (x, y), width x height, of the root's depth and visual. values are the
// attributes mask names, in its bits' order.
func (c *Conn) CreateWindow(id uint32, x, y, width, height int, mask uint32, values ...uint32) error {
	body := le.AppendUint32(nil, id)
	body = le.AppendUint32(body, c.screen.Root)
	body = le.AppendUint16(body, uint16(int16(x)))
	body = le.AppendUint16(body, uint16(int16(y)))
	body = le.AppendUint16(body, uint16(width))
	body = le.AppendUint16(body, uint16(height))
	body = le.AppendUint16(body, 0) // border
	body = le.AppendUint16(body, 1) // InputOutput
	body = le.AppendUint32(body, 0) // CopyFromParent visual
	body = le.AppendUint32(body, mask)
	for _, v := range values {
		body = le.AppendUint32(body, v)
	}
	_, err := c.buffer(opCreateWindow, 0, body, false)
	return err
}

// MapWindow buffers mapping the window, and raising it to the top of the stack.
func (c *Conn) MapWindow(id uint32) error {
	if _, err := c.buffer(opMapWindow, 0, le.AppendUint32(nil, id), false); err != nil {
		return err
	}
	body := le.AppendUint32(nil, id)
	body = le.AppendUint16(body, 0x40) // stack-mode
	body = append(body, 0, 0)
	body = le.AppendUint32(body, 0) // Above
	_, err := c.buffer(opConfigureWindow, 0, body, false)
	return err
}

// CreateGC buffers a graphics context on the window.
func (c *Conn) CreateGC(id, drawable uint32) error {
	body := le.AppendUint32(nil, id)
	body = le.AppendUint32(body, drawable)
	body = le.AppendUint32(body, 0)
	_, err := c.buffer(opCreateGC, 0, body, false)
	return err
}

// FillRectangle buffers filling a rectangle of the drawable with a pixel value.
func (c *Conn) FillRectangle(drawable, gc, pixel uint32, x, y, width, height int) error {
	body := le.AppendUint32(nil, gc)
	body = le.AppendUint32(body, 0x4) // foreground
	body = le.AppendUint32(body, pixel)
	if _, err := c.buffer(opChangeGC, 0, body, false); err != nil {
		return err
	}
	body = le.AppendUint32(nil, drawable)
	body = le.AppendUint32(body, gc)
	body = le.AppendUint16(body, uint16(int16(x)))
	body = le.AppendUint16(body, uint16(int16(y)))
	body = le.AppendUint16(body, uint16(width))
	body = le.AppendUint16(body, uint16(height))
	_, err := c.buffer(opPolyFillRectangle, 0, body, false)
	return err
}

// SetInputFocus buffers giving the window the keyboard focus, reverting to the root.
func (c *Conn) SetInputFocus(id uint32) error {
	body := le.AppendUint32(nil, id)
	body = le.AppendUint32(body, 0) // CurrentTime
	_, err := c.buffer(opSetInputFocus, 1, body, false)
	return err
}

// EnableEvents keeps the events the server sends from now on, for NextEvent. Without it they are dropped.
func (c *Conn) EnableEvents() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.keep = true
}

// NextEvent waits for the next event: its 32 bytes, the type in the first byte (the sent-event bit cleared).
func (c *Conn) NextEvent() ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.events) == 0 && c.err == nil {
		c.cond.Wait()
	}
	if len(c.events) == 0 {
		return nil, c.err
	}
	e := c.events[0]
	c.events = c.events[1:]
	e[0] &= 0x7f
	return e, nil
}
