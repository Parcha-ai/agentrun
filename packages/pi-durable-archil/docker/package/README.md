# docker/package

The image takes this package from a tarball here: `npm pack --pack-destination docker/package`, run in
`packages/pi-durable-archil` after the workspace's `npm ci`, writes `parcha-pi-durable-archil-<version>.tgz`
(`examples/docker-quickstart.sh` does it). With no tarball here, `docker/Dockerfile` fetches the release of this
checkout's `package.json` version from npm; `--build-arg PDA_VERSION=<version or dist-tag>` names another, and only then
does a dist-tag such as `beta` apply. A tarball here must be that same version, and there must be one. Tarballs are not
committed.

Between releases a checkout's `package.json` names the last published version, which lacks whatever the branch added
since. On `main` (or any branch ahead of a release), build from the checkout with `npm pack` as above, which is what the
quickstart does. The build refuses a package without the Docker path (`dist/hosts/docker.js`), such as a release from
before it, with one line.
