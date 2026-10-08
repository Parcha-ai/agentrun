# docker/package

The image takes this package from a tarball here: `npm pack --pack-destination docker/package`, run in
`packages/pi-durable-archil` after the workspace's `npm ci`, writes `parcha-pi-durable-archil-<version>.tgz`
(`examples/docker-quickstart.sh` does it). With no tarball here, `docker/Dockerfile` fetches the release of this
checkout's `package.json` version from npm; `--build-arg PDA_VERSION=<version or dist-tag>` names another, and only then
does a dist-tag such as `beta` apply. A tarball here must be that same version, and there must be one. Tarballs are not
committed.
