// What the source export (export-source.mjs) reviews instead of blocking. A URL's password is an explicit fake when it
// is not-a-secret, alone or after one word and a hyphen; nothing else is.
export const fakeUrlPassword = password => /^(?:[a-z0-9]+-)?not-a-secret$/i.test(password);
