#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/6f56bf42-85b8-4fbb-8e06-6c44960184ba's setup.sh, from its file cache. Changed for computer-bench: /home/user is the
# run's folder (made fresh here).
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" && cd "$d" || exit 1

# Remove existing directories and file if they exist
rm -rf dir1 dir2 dir3
rm -f file1

# Create a new file named 'file1'
echo "This is a test file named file1." > file1

# Create directories 'dir1', 'dir2', and 'dir3'
mkdir dir1 dir2 dir3

echo "Setup completed."
