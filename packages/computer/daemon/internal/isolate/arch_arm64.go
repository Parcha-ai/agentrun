package isolate

// The calls and the audit architecture of linux/arm64 (include/uapi/asm-generic/unistd.h, uapi/linux/audit.h).
const (
	sysSetns        = 268
	sysSeccomp      = 277
	sysSocket       = 198
	sysIOURingSetup = 425
	auditArch       = 0xc00000b7
	// x32: arm64 has no second table of calls in the same architecture.
	x32 = false
)
