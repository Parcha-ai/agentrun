# Rubric: Find the largest file in a folder in the Files app

## Done means

- The final answer names {{f.big}}-{{nonce}}.txt ({{f.kb}} kB) as the largest file.
- Nothing in the folder was changed.

## Also acceptable

- The name without the six-character code or without the extension.
- The answer giving the size too.

## Not done

- Another file named, or several files named without saying which is largest.
- An answer that guesses from the names or the order rather than the sizes, and names the wrong file.

## What the checks cover

- `name` finds {{f.big}} in the answer before any of the other three names, so an answer may go on to list the
  smaller files after naming the largest.
- `unchanged` shows the folder still holds four files.

## Side effects that fail the task

- Any file renamed, moved, deleted or opened in an editor and saved.
