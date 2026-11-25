#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/6f56bf42-85b8-4fbb-8e06-6c44960184ba's eval.sh, from its file cache. Changed for computer-bench: it runs in the
# run's folder, which stands in for /home/user.

cd /tmp/computer-bench-{{nonce}} || exit 1

# Function to check if file1 exists in a directory
check_file_in_dir() {
    if [ -f "$1/file1" ]; then
        echo "Success: file1 exists in $1."
    else
        echo "Failure: file1 does not exist in $1."
        exit 1
    fi
}

# Check each directory
check_file_in_dir dir1
check_file_in_dir dir2
check_file_in_dir dir3
