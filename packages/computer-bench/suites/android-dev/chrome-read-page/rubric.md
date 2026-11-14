# Rubric: Read a code from a web page in Chrome

## Done means

- The final answer gives the code of the {{o.ask}} order on the page at http://127.0.0.1:{{port}}/, which is
  {{nonce}}.

## Also acceptable

- The code in quotes, in capitals or inside a sentence.

## Not done

- The code of another order ({{o.c1}} or {{o.c2}}), alone or listed with the right one.
- A code with a character wrong or missing.

## What the checks cover

- `code` reads the final answer for the asked code and refuses one that also names a decoy code; it is exact.

## Side effects that fail the task

- Chrome settings changed, or anything typed into other sites.
