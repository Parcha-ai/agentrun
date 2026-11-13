#ifndef CCOMPUTERD_H
#define CCOMPUTERD_H

#include <stdint.h>

/// Who is on the other end of a unix socket, from the kernel's audit token (macOS only).
typedef struct {
	/// The audit token itself, for SecCodeCopyGuestWithAttributes.
	uint8_t audit_token[32];
	uint32_t euid;
	int32_t pid;
} computerd_peer;

/// Reads the peer of a connected unix socket. Answers 0, or -1 with errno set (ENOTSUP off macOS).
int computerd_peer_of(int fd, computerd_peer *out);

#endif
