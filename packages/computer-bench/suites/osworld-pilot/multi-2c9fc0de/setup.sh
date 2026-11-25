#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): the setup commands of
# task multi_apps/2c9fc0de-3ee7-45e1-a5df-c86206ad78b5, gathered into one script. Changed for computer-bench: /home/user
# is the run's folder (made fresh here, and HOME, so the global git config lands in it), and the box has no unzip, so
# binder is a few small files of ours instead of OSWorld's binder.zip.
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" || exit 1
export HOME="$d"

git config --global user.name "xlang" && git config --global user.email "xlang2024anonym@gmail.com" && mkdir -p "$d/projects/remote_project" && cd "$d/projects/remote_project" && git init -q --initial-branch=main && git config receive.denyCurrentBranch ignore || exit 1

mkdir -p "$d/projects/binder/notebooks" && cd "$d/projects/binder" || exit 1
printf '# binder\n\nNotes and notebooks for the reading group.\n' > README.md
printf 'name: binder\nchannels:\n  - conda-forge\ndependencies:\n  - python=3.11\n  - numpy\n  - matplotlib\n' > environment.yml
printf 'import numpy as np\n\nprint(np.arange(10).sum())\n' > notebooks/week1.py
git init -q --initial-branch main && git remote add origin "$d/projects/remote_project"
