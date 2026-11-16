# Rubric: Make a folder and move the files of one kind into it

## Done means

- Documents › computer-bench-{{nonce}} › {{folder}} holds exactly {{kind.moved}}.
- Documents › computer-bench-{{nonce}} holds the folder {{folder}} and exactly {{kind.rest}}.

## Not done

- The files copied (Option-drag) instead of moved, so they are in both places.
- The folder named differently ("untitled folder", a typo, other capitalisation).
- A file of another kind moved in too, or one of the asked kind left out.
- The folder made somewhere else, such as directly in Documents.

## What the checks cover

- `inside` lists the new folder; `left` lists the top folder without it. Together they are exact for both folders'
  visible files, so a copy, a miss or an extra fails. Hidden files (.DS_Store) are not listed.

## Side effects that fail the task

- Any file outside the folder moved or deleted.
