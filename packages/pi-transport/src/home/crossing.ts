/**
 * A crossing is a named moment that this package announces, awaited, so that whoever drives a session can act exactly
 * there (a supervisor kills a box or a process, and writes down why first). The package never kills anything itself.
 */
export type CrossingPoint = "transport.checkpoint.taken" | "transport.tool.started";

export type CrossingInfo = {
	readonly session: string;
	/** The epoch of the home that announced it. */
	readonly epoch: number;
	readonly box: string;
	/** `transport.tool.started` only: the tool, by name. Never its arguments. */
	readonly tool?: string;
	/** How many times this point was announced for this session, from 1. */
	readonly n: number;
	/**
	 * `transport.tool.started` only: let the tool run now. A handler that wants the tool to run before it kills calls
	 * this first; otherwise the tool runs once the handler returns.
	 */
	readonly release?: () => void;
};

export type Crossing = (point: CrossingPoint, info: CrossingInfo) => void | Promise<void>;

/**
 * Counts the announcements of each point, from 1. The place makes one and gives it to everything that announces for it, so
 * that `n` counts across a restart; what is not given one counts for itself.
 */
export type CrossingCounter = (point: CrossingPoint) => number;

export function crossingCounter(): CrossingCounter {
	const counts = new Map<CrossingPoint, number>();
	return (point) => {
		const n = (counts.get(point) ?? 0) + 1;
		counts.set(point, n);
		return n;
	};
}
