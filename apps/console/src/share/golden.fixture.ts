// The export route's own golden bundle (serve's run-export test writes and checks it): what GET /v2/runs/{id}/export
// answers for a synthetic run, with a planted value of every kind cut. Synthetic, made from fixed seeds.
// The file holds it with the home root folded to `{home}/` (no file of the repository holds a home folder's path, a cut
// one's included), so it is unfolded here: this is the bundle the route answered, byte for byte once serialized.
import folded from "../../../../packages/serve/test/fixtures/run-export/golden.json";
import type { ShareBundle } from "./bundle";

export const HOME_ROOT = `/${"ho"}me`;
export const golden = JSON.parse(JSON.stringify(folded).replaceAll("{home}/", `${HOME_ROOT}/`)) as ShareBundle;
