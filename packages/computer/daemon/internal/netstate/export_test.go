package netstate

// AddAddress4 is addAddress4, for the test of the RTM_NEWADDR LoopbackUp sends where the kernel gave lo no 127.0.0.1
// (gVisor's netstack may not; Linux always does, so the test adds another loopback address the same way).
var AddAddress4 = addAddress4
