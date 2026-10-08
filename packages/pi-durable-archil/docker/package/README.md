# docker/package

The image takes this package from a tarball here: `npm pack --pack-destination docker/package`, run in
`packages/pi-durable-archil` after the workspace's `npm ci`, writes `parcha-pi-durable-archil-<version>.tgz`
(`examples/docker-quickstart.sh` does it). With no tarball here, `docker/Dockerfile` fetches the release from npm
(`--build-arg PDA_VERSION=<version or dist-tag>`, default `beta`). Tarballs are not committed.
