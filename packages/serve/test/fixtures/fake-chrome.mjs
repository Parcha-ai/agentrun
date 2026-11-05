#!/usr/bin/env node
// A stand-in for a Chrome binary in the tests that start no real one: it answers the server's start-time sandbox check
// (`--dump-dom about:blank`) as a Chrome that starts with its sandbox on does, with a blank page and exit 0; with
// FAKE_CHROME_NO_SANDBOX=1, as one that cannot start its sandbox, in Chrome's own words, then aborting.
if (process.env.FAKE_CHROME_NO_SANDBOX === "1") {
  process.stderr.write("[1:1:1105/000000.000000:FATAL:zygote_host_impl_linux.cc(130)] No usable sandbox! If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.\n");
  process.kill(process.pid, "SIGABRT");
} else {
  process.stdout.write("<html><head></head><body></body></html>\n");
}
