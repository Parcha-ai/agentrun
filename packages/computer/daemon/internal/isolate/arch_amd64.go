package isolate

// The calls and the audit architecture of linux/amd64 (arch/x86/entry/syscalls/syscall_64.tbl, uapi/linux/audit.h).
const (
	sysSetns        = 308
	sysSeccomp      = 317
	sysSocket       = 41
	sysIOURingSetup = 425
	auditArch       = 0xc000003e
	// x32 is the bit the x32 ABI sets in a call's number on the same architecture: a second table of calls, which the
	// filter refuses whole.
	x32 = true
)
