// The disk package's places are the harness's places: a check at compile time, by `tsc -p examples/tsconfig.json` (`npm run typecheck`), with nothing to run.
// What `localPlace` and `archilPlace` make is what `demo()` takes as its `place`, and a disk place with the two run-file reads (`readRunFile`, `listRunFiles`) is a
// harness Place with both, the shape whose labels the supervisor reads itself (the providers beside it are then accepted). `localPlace` always has both;
// `archilPlace` has them when its control lists. A drift in either read (its name, its argument, or `null` for a missing file) fails this file.
import type { DemoOptions, Place } from '@parcha/agentrun-harness';
import type { archilPlace, localPlace, Place as DiskPlace } from '@parcha/pi-durable-disk';

type Assignable<A extends B, B> = A;
type Reads<P extends { readRunFile?: unknown; listRunFiles?: unknown }> = Required<Pick<P, 'readRunFile' | 'listRunFiles'>>;
type PlaceOption = NonNullable<DemoOptions['place']>;

export type DiskPlacesAreHarnessPlaces = [
  // What each makes, given the harness's context, is a harness place.
  Assignable<ReturnType<typeof localPlace>, PlaceOption>,
  Assignable<ReturnType<typeof archilPlace>, PlaceOption>,
  // With both reads (localPlace always, archilPlace over a control that lists), a harness Place with both.
  Assignable<ReturnType<ReturnType<typeof localPlace>> & Reads<DiskPlace>, Place & Reads<Place>>,
  Assignable<ReturnType<ReturnType<typeof archilPlace>> & Reads<DiskPlace>, Place & Reads<Place>>,
];

// The check bites: a read that answers `undefined` for a missing file is not the harness's (the supervisor reads `null` as a label not landed yet).
// @ts-expect-error a read whose missing file is undefined, not null, is no harness read
export type DriftedRead = Assignable<Omit<DiskPlace, 'readRunFile'> & { readRunFile(path: string): Promise<Uint8Array | undefined>; listRunFiles(dir: string): Promise<string[]> }, Place & Reads<Place>>;
