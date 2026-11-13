#include "CComputerd.h"

#include <errno.h>
#include <string.h>

#ifdef __APPLE__
#include <bsm/libbsm.h>
#include <sys/socket.h>
#include <sys/un.h>

_Static_assert(sizeof(audit_token_t) == 32, "an audit token is 32 bytes");

int computerd_peer_of(int fd, computerd_peer *out) {
	audit_token_t token;
	socklen_t size = sizeof(token);
	memset(&token, 0, sizeof(token));
	if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) != 0) return -1;
	if (size != sizeof(token)) {
		errno = EINVAL;
		return -1;
	}
	memcpy(out->audit_token, &token, sizeof(token));
	out->euid = audit_token_to_euid(token);
	out->pid = audit_token_to_pid(token);
	return 0;
}
#else
int computerd_peer_of(int fd, computerd_peer *out) {
	(void)fd;
	(void)out;
	errno = ENOTSUP;
	return -1;
}
#endif
