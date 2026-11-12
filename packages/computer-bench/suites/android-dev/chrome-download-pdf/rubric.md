# Rubric: Download a PDF with Chrome

## Done means

- The PDF of RFC {{rfc}} is saved in the phone's Download folder, downloaded completely.

## Also acceptable

- Opened in Chrome's PDF viewer first and saved from there with its download button.
- Downloaded twice (a second copy with a " (1)" suffix).

## Not done

- The PDF only viewed, never saved.
- The download still running, paused or failed when the run ends.
- Another file saved (the RFC's HTML or text page, or a different RFC).

## What the checks cover

- `pdf-saved` finds a non-empty rfc{{rfc}}*.pdf in Download that starts like a PDF. It can't prove the file is the
  whole document; the grader reads Chrome's "Download complete" message or the downloads list in the last screenshots.

## Side effects that fail the task

- Chrome's download location or other settings changed, or other files in Download deleted.
