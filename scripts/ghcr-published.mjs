// Whether an image on GHCR can be pulled with no credentials, as Render, E2B and a stranger's `docker pull` pull it: the
// release's box job (release.yml, before E2B pulls the box image) and the Render walk (deploy/render/walk.mjs) ask here.
//   node scripts/ghcr-published.mjs ghcr.io/<repo>:<tag>    exit 0 when an anonymous pull finds it, else 1; says what
//                                                            GHCR answered on stderr
// Builtins and fetch only, so it runs before a job's npm ci.
import { isMain } from './is-main.mjs';

// A multi-platform image, or one with provenance, is an index; a single-platform one a manifest. Either is the image.
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];

/** What an anonymous pull of `ghcr.io/<repo>:<tag>` gets: `{ status }`, GHCR's HTTP status for the tag's manifest, or
 *  `{ reason }` when it could not ask (another registry, a digest, the token grant refused, or the network). */
export async function anonymousPull(ref, http = fetch) {
  const m = /^ghcr\.io\/([a-z0-9._/-]+):([\w][\w.-]{0,127})$/.exec(ref ?? '');
  if (!m) return { reason: `${ref} is not a ghcr.io/<repo>:<tag> reference` };
  const [, repo, tag] = m;
  try {
    const grant = await http(`https://ghcr.io/token?scope=repository:${repo}:pull`, { signal: AbortSignal.timeout(15_000) });
    if (!grant.ok) return { reason: `GHCR's anonymous token grant answered ${grant.status}` };
    const { token } = await grant.json();
    const r = await http(`https://ghcr.io/v2/${repo}/manifests/${tag}`, { method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: ACCEPT.join(', ') }, signal: AbortSignal.timeout(15_000) });
    return { status: r.status };
  } catch (error) {
    return { reason: `GHCR could not be asked: ${error.message}` };
  }
}

/** true when an anonymous pull finds the image, false when GHCR answers that it has no such tag (404), undefined when it
 *  can't tell. */
export async function imagePublished(ref, http = fetch) {
  const { status } = await anonymousPull(ref, http);
  return status === 200 ? true : status === 404 ? false : undefined;
}

if (isMain(import.meta)) {
  const ref = process.argv[2];
  const got = await anonymousPull(ref);
  console.error(`ghcr-published: ${got.status ? `${ref}: HTTP ${got.status} to an anonymous pull` : got.reason}`);
  process.exitCode = got.status === 200 ? 0 : 1;
}
