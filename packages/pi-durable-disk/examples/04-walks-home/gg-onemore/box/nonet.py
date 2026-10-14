# Run a command with no network: a seccomp filter (libseccomp, through ctypes) makes socket() fail with EPERM for every
# family but AF_UNIX, for the command and everything it starts. The box's sandbox refuses network namespaces, and the
# agent's code needs one unix socket (the lab's) and nothing else.
#   python3 nonet.py CMD [ARGS...]
import ctypes
import errno
import os
import socket
import sys

SCMP_ACT_ALLOW = 0x7FFF0000
SCMP_CMP_NE = 1


def scmp_act_errno(e):
    return 0x00050000 | (e & 0xFFFF)


class ArgCmp(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int), ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]


def no_network():
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(ArgCmp)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(SCMP_ACT_ALLOW)
    if not ctx:
        raise OSError("seccomp_init failed")
    try:
        nr = lib.seccomp_syscall_resolve_name(b"socket")
        cmp = (ArgCmp * 1)(ArgCmp(0, SCMP_CMP_NE, socket.AF_UNIX, 0))
        rc = lib.seccomp_rule_add_array(ctx, scmp_act_errno(errno.EPERM), nr, 1, cmp)
        if rc < 0:
            raise OSError(-rc, "seccomp_rule_add_array")
        rc = lib.seccomp_load(ctx)
        if rc < 0:
            raise OSError(-rc, "seccomp_load")
    finally:
        lib.seccomp_release(ctx)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: nonet.py CMD [ARGS...]")
    no_network()
    os.execvp(sys.argv[1], sys.argv[1:])
