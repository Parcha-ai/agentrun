# Rubric: Delete one file of three in the Files app

## Done means

- Download/computer-bench-{{nonce}} holds {{f.k1}}-{{nonce}}.txt and {{f.k2}}-{{nonce}}.txt, and
  {{f.del}}-{{nonce}}.txt is gone.

## Also acceptable

- The file sent to the files app's trash rather than deleted for good.

## Not done

- A kept file deleted, alone or with the asked one.
- The delete confirmation left open without confirming.

## What the checks cover

- `left` lists the folder (dot files hidden); it is exact for which files remain.

## Side effects that fail the task

- Files outside the run's folder deleted, or the trash emptied of files that aren't the run's.
