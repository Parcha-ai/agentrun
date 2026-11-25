#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/37887e8c-da15-4192-923c-08fa390a176d's setup.sh, from its file cache. Changed for computer-bench: the base folder
# is test_files in the run's folder, not /tmp/test_files (made fresh here).
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" || exit 1

# Define the base directory for our test
BASE_DIR="$d/test_files"

# Create the directory structure
mkdir -p "$BASE_DIR/old_files"
mkdir -p "$BASE_DIR/new_files"

# Create files with modification times 30 days ago and today
# Files to be compressed
touch "$BASE_DIR/old_files/old_file1.txt"
touch "$BASE_DIR/old_files/old_file2.txt"

# Files not to be compressed
touch "$BASE_DIR/new_files/new_file1.txt"
touch "$BASE_DIR/new_files/new_file2.txt"

# Set the modification and access times
# 30 days ago for old files
find "$BASE_DIR/old_files" -type f -exec touch -d "30 days ago" {} \;

# Current date for new files (to ensure they are not compressed)
find "$BASE_DIR/new_files" -type f -exec touch -d "now" {} \;
