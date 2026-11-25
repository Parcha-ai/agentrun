#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/5c1075ca-bb34-46a3-a7a0-029bd7463e79's setup.sh, from its file cache. Changed for computer-bench: /home/user is
# the run's folder (made fresh here), and the closing echo is gone.
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" && cd "$d" || exit 1

# Create a sample directory structure
mkdir -p test_environment/dir1
mkdir -p test_environment/dir2/subdir1
mkdir -p test_environment/dir3

# Navigate into the test environment
cd test_environment || exit 1

# Create .ipynb files, including those that match the pattern *failed.ipynb
touch dir1/a_failed.ipynb
touch dir1/b.ipynb
touch dir2/subdir1/c_failed.ipynb
touch dir2/d.ipynb
touch dir3/e_failed.ipynb
