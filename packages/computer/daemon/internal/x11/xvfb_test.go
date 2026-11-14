package x11_test

import (
	"image"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// TestOnXvfbDamageOnTheRootReportsWhatAnotherClientDrewInItsWindow: the live view's damage object is on the root, and a
// program draws in a window of its own, on its own connection; the rectangle it filled comes back as a DamageNotify.
func TestOnXvfbDamageOnTheRootReportsWhatAnotherClientDrewInItsWindow(t *testing.T) {
	display := xvfbtest.Start(t, 320, 240)
	t.Setenv("XAUTHORITY", "")
	watcher, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	if err := watcher.InitDamage(); err != nil {
		t.Fatal(err)
	}
	watcher.EnableEvents()
	if _, err := watcher.CreateDamage(watcher.Screen().Root, x11.DamageReportRawRectangles); err != nil {
		t.Fatal(err)
	}
	painter, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	defer painter.Close()
	window, gc := painter.NewID(), painter.NewID()
	if err := painter.CreateWindow(window, 40, 30, 100, 80, x11.CWBackPixel|x11.CWOverrideRedirect, painter.Pixel(0, 0, 0), 1); err != nil {
		t.Fatal(err)
	}
	if err := painter.MapWindow(window); err != nil {
		t.Fatal(err)
	}
	if err := painter.CreateGC(gc, window); err != nil {
		t.Fatal(err)
	}
	if _, err := painter.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := painter.FillRectangle(window, gc, painter.Pixel(255, 0, 0), 10, 20, 7, 5); err != nil {
		t.Fatal(err)
	}
	if errs, err := painter.Sync(); err != nil || len(errs) > 0 {
		t.Fatal(errs, err)
	}
	// The window's map damages its whole area first; the fill's own rectangle, on the screen, comes after it.
	want := image.Rect(50, 50, 57, 55)
	events := make(chan []byte, 64)
	go func() {
		for {
			e, err := watcher.NextEvent()
			if err != nil {
				close(events)
				return
			}
			events <- e
		}
	}()
	deadline := time.After(10 * time.Second)
	var seen []image.Rectangle
	for {
		select {
		case e, ok := <-events:
			if !ok {
				t.Fatalf("the connection ended; damage seen: %v", seen)
			}
			if area, ok := watcher.DamageArea(e); ok {
				seen = append(seen, area)
				if area == want {
					return
				}
			}
		case <-deadline:
			t.Fatalf("no DamageNotify of %v within 10 s; seen: %v", want, seen)
		}
	}
}

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
