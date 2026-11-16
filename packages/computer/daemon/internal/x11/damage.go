package x11

import (
	"errors"
	"fmt"
	"image"
)

// The DAMAGE extension (Damage Extension Protocol 1.1): the server tells a client where a drawable's pixels changed, so
// the live view reads the screen only when, and only where, it changed. One damage object on the root, at the raw
// rectangles level, reports each rectangle drawn on the screen, in its own windows' too, as an event; nothing is
// accumulated in the server, so no request re-arms it.

// DAMAGE's minor opcodes, and the level the live view asks for.
const (
	damageQueryVersion = 0
	damageCreate       = 1

	// DamageReportRawRectangles: an event for each rectangle drawn, as it is drawn.
	DamageReportRawRectangles = 0
)

// ErrNoDamage is InitDamage's error on an X server without the DAMAGE extension.
var ErrNoDamage = errors.New("this X server has no DAMAGE extension")

// InitDamage finds the DAMAGE extension and asks for version 1.1 of it. A server without it answers ErrNoDamage.
func (c *Conn) InitDamage() error {
	ext, err := c.QueryExtension("DAMAGE")
	if err != nil {
		return err
	}
	if !ext.Present {
		return ErrNoDamage
	}
	body := le.AppendUint32(nil, 1)
	body = le.AppendUint32(body, 1)
	r, err := c.call(ext.Major, damageQueryVersion, body, smallReply)
	if err != nil {
		return fmt.Errorf("DAMAGE's QueryVersion: %w", err)
	}
	if le.Uint32(r[8:]) < 1 {
		return fmt.Errorf("the X server's DAMAGE is version %d.%d; the live view needs 1.x", le.Uint32(r[8:]), le.Uint32(r[12:]))
	}
	c.damage, c.damageEvent = ext.Major, ext.FirstEvent
	return nil
}

// CreateDamage makes a damage object on drawable at level, and syncs: the server refusing it is its error. Its events
// are kept only once EnableEvents asked for them; read them with NextEvent and DamageArea.
func (c *Conn) CreateDamage(drawable uint32, level byte) (uint32, error) {
	if c.damage == 0 {
		return 0, fmt.Errorf("CreateDamage before InitDamage")
	}
	id := c.NewID()
	body := le.AppendUint32(nil, id)
	body = le.AppendUint32(body, drawable)
	body = append(body, level, 0, 0, 0)
	if _, err := c.buffer(c.damage, damageCreate, body, noReply); err != nil {
		return 0, err
	}
	errs, err := c.Sync()
	if err != nil {
		return 0, err
	}
	if len(errs) > 0 {
		return 0, fmt.Errorf("DAMAGE's Create: %w", errs[0])
	}
	return id, nil
}

// DamageArea is the rectangle a DamageNotify event says was drawn, in the drawable's coordinates, and whether e is one.
func (c *Conn) DamageArea(e []byte) (image.Rectangle, bool) {
	if c.damage == 0 || len(e) < 32 || e[0]&0x7f != c.damageEvent {
		return image.Rectangle{}, false
	}
	x, y := int(int16(le.Uint16(e[16:]))), int(int16(le.Uint16(e[18:])))
	w, h := int(le.Uint16(e[20:])), int(le.Uint16(e[22:]))
	return image.Rect(x, y, x+w, y+h), true
}
