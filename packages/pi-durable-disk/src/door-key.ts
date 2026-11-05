// The submission keys the door records a request under in a run's store (door.ts): its admission's, its outcome's and
// an UNKNOWN's late outcome. A requestId has no space, so no key collides. Exported so a host can find a request the door
// took without a door: a message a run already holds is not sent again.
export const doorKey = (requestId: string, n: 0 | 1 | 2 = 0): string => (n === 0 ? `door ${requestId}` : `door ${requestId} ${n}`);
