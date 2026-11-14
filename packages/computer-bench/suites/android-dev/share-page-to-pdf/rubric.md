# Rubric: Save a page from Chrome as a PDF through the share sheet

## Done means

- A PDF of the {{shop}} receipt is saved on the phone, in Download or Documents, under the suggested name (it holds
  {{nonce}}).
- The PDF shows the receipt: {{shop}}, {{item}}, {{price}}.

## Not done

- The print dialog left open, or sent to a printer instead of Save as PDF.
- A screenshot of the page saved instead of a PDF.
- The file renamed so that it no longer holds {{nonce}}; the instruction asks to keep the suggested name.
- The PDF saved to a cloud drive only, with no copy on the phone.

## What the checks cover

- `pdf-saved` finds a non-empty file named `*{{nonce}}*.pdf` in Download or Documents (two folders deep) and reads its
  first four bytes. It shows a PDF was written under the suggested name. It can't read what the PDF shows; the grader
  checks the last screens for the receipt in the print preview.
- Chrome's print preview is reached through Share > Print on recent Chrome, or the menu's Share... > Print on older
  builds. Either route counts.

## Side effects that fail the task

- The page shared to an app that sends it off the phone (a message, an email, a post).
- Other files in Download or Documents deleted or renamed.
