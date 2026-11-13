package x11_test

import (
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// TestOnXvfb: the client against a real X server, with XTEST, GetImage, QueryPointer and the keyboard map.
func TestOnXvfb(t *testing.T) {
	display := xvfbtest.Start(t, 320, 240)
	t.Setenv("XAUTHORITY", "")
	c, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.InitXTest(); err != nil {
		t.Fatal(err)
	}
	if w, h, err := c.RootSize(); err != nil || w != 320 || h != 240 {
		t.Fatalf("RootSize = %d, %d, %v", w, h, err)
	}
	if err := c.FakeInput(x11.MotionNotify, 0, 17, 23); err != nil {
		t.Fatal(err)
	}
	if errs, err := c.Sync(); err != nil || len(errs) != 0 {
		t.Fatal(errs, err)
	}
	if x, y, err := c.QueryPointer(); err != nil || x != 17 || y != 23 {
		t.Fatalf("QueryPointer after a motion to (17, 23) = %d, %d, %v", x, y, err)
	}
	img, err := c.GetImage(0, 0, 320, 240)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 320 || b.Dy() != 240 {
		t.Fatalf("the root's image is %v", b)
	}
	km, err := c.KeyboardMapping()
	if err != nil {
		t.Fatal(err)
	}
	for _, sym := range []uint32{'a', 'A', '!', ' ', 0xff0d, 0xffe1} {
		if _, _, ok := km.Find(sym); !ok {
			t.Errorf("Xvfb's keyboard map has no keycode for %#x", sym)
		}
	}
	if len(km.Unused()) == 0 {
		t.Error("Xvfb's keyboard map has no unused keycode for the keysym remap")
	}
}
