#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/4d117223-a354-47fb-8b45-62ab1390a95f's eval.sh, from its file cache. Changed for computer-bench: it runs in the
# run's folder, which stands in for /home/user, and fails when testDir no longer holds its three files (the original
# passed an empty or missing testDir).
cd /tmp/computer-bench-{{nonce}} || exit 1
[ "$(find testDir -type f | wc -l)" -eq 3 ] || { echo "testDir does not hold its three files."; exit 1; }

# Evaluation script to verify that all regular files have permissions set to 644
allFilesCorrect=1
while IFS= read -r line; do
    # Extract the permission and file path
    perm=$(echo "$line" | awk '{print $1}')
    file=$(echo "$line" | awk '{print $9}')

    # Check if the permission is not 644
    if [[ "$perm" != "-rw-r--r--" ]]; then
        echo "Incorrect permission for $file: $perm"
        allFilesCorrect=0
    fi
done < <(find testDir -type f -exec ls -l {} \;)

if [ "$allFilesCorrect" -eq 1 ]; then
    echo "All files have the correct permissions."
else
    echo "Some files do not have the correct permissions."
fi
