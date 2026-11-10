---
packages: repo
kind: feature
---
The release publishes the Python client, `parcha-agentrun`, to PyPI after the npm packages, from the same tag, by PyPI trusted publishing (the `pypi` job in `release.yml`, environment `npm-release`; no token or secret). It is on a version line of its own, `python/pyproject.toml`'s, from 0.3.0: plain `x.y.z` releases above the 0.2.x the old hosted SDK left under that name, never a pre-release, which pip would pass over. Before the upload, `node scripts/python-release.mjs --verify` checks the project, the sdist and wheel against this tree's `python/` file for file, `twine check --strict` and an offline smoke in a clean venv; a version already on PyPI is not uploaded again. `node scripts/changes.mjs --check` holds the version as it holds `@parcha/agentrun`'s: a pull request leaves it alone, and a release commit that changes what the client publishes moves it.
- Upgrading: `pip install parcha-agentrun` installs the self-hosted server's client from 0.3.0; code written for the old hosted SDK (0.2.x) pins `parcha-agentrun<0.3`.
