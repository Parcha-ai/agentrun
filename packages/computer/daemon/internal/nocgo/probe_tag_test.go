//go:build nocgo_probe

package nocgo_test

// Built only with the tag TestRunRebuildsATestBinaryWithCgoWithoutIt gives its build, so the child shows it kept it.
func init() { taggedProbe = true }
