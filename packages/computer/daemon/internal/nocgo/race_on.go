//go:build race

package nocgo

// Race says whether this binary was built with -race, which needs cgo.
const Race = true
