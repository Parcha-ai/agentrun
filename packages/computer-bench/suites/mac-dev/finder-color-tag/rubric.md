# Rubric: Give one file a colour tag

## Done means

- "{{target}}" in Documents › computer-bench-{{nonce}} has the {{color}} tag and no other tag.
- The folder's other two files have no tags.

## Not done

- Another colour, or the right colour on another file.
- The {{color}} tag added together with a second tag.
- The file renamed or moved while tagging it.

## What the checks cover

- `target-tag` and `others-clean` read the files' tag names through NSURL, the store Finder's tags live in; they are
  exact. They read names, so a custom tag named "{{color}}" with another colour would pass; the screenshots show the
  colour if that matters.

## Side effects that fail the task

- Tags added to or removed from files outside the folder.
