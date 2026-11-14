# Rubric: Share a page's link from Chrome onto a contact

## Done means

- The contact "{{who.first}} {{who.last}} {{nonce}}" has a website that is the page's address,
  `http://127.0.0.1:{{port}}/` (with or without `http://` and the closing slash).
- Its phone number, 303 555 0142, is still on it, and it is still one contact.

## Not done

- The link pasted into a new contact, or into a field other than the website (a note, the company, the phone).
- The address typed in from memory with a different port, or the page's title pasted in place of its address.
- The website field filled but the edit left without saving.

## What the checks cover

- `website-and-phone` reads the contact's website and phone rows by exact display name in one read. It shows the link
  is on this contact and the phone survived.
- It can't see how the link got there. The instruction asks for Chrome's Share menu, and the grader checks the steps
  for it; typing the address in by hand is a lesser route, not a failure, when the result is exact.

## Side effects that fail the task

- Any other contact edited, merged or deleted.
- The link sent anywhere outside the phone (a message, an email, a post) from the share sheet.
