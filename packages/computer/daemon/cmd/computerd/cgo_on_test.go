//go:build cgo

package main

// cgoBuild: this test binary links cgo, where Go cannot make one call on every thread.
const cgoBuild = true
