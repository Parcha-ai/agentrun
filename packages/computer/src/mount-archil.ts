// The Archil mount in a remote computer (Daytona, Modal, E2B): the run's folder on the owner's Archil disk at
// /workspace, exclusive, through the root helper the image ships (box/agentrun-archil). The provider runs the helper as
// root through its own exec, never through computerd; computerd runs every tool as the tool user, which has no way to
// root and never holds the disk's token.

/** Where the image has the root helper, root:root 0755. */
export const ARCHIL_HELPER = "/usr/local/sbin/agentrun-archil";
/** The user computerd runs every tool as in a computer with an Archil mount: no sudo, no capability, no token. */
export const ARCHIL_TOOL_USER = "agentrun-tool";
/** The tool user's uid, and its gid: the image makes both 2510. */
export const ARCHIL_TOOL_UID = 2510;
/** The resident serve's socket (dir 0750 root:2510, socket 0660): one fixed byte asks for a sync, coalesced. It is not
 *  in computerd's own socket folder, /run/agentrun, which is the tool user's alone. */
export const ARCHIL_SYNC_SOCKET = "/run/agentrun-archil/archil.sock";
