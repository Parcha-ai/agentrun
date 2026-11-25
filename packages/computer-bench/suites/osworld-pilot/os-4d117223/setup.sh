#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/4d117223-a354-47fb-8b45-62ab1390a95f's setup.sh, from its file cache. Changed for computer-bench: /home/user is the
# run's folder (made fresh here).
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" && cd "$d" || exit 1

# Create the test directory structure
mkdir -p testDir/subDir1 testDir/subDir2

# Create test files with different permissions
touch testDir/file1.txt testDir/subDir1/file2.txt testDir/subDir2/file3.txt
chmod 755 testDir/file1.txt
chmod 644 testDir/subDir1/file2.txt
chmod 777 testDir/subDir2/file3.txt

# Display the initial permissions for verification
echo "Initial permissions:"
find testDir -type f -exec ls -l {} \;
