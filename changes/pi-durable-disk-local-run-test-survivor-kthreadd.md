---
packages: repo
kind: ci
---
Two pi-durable-disk local-run tests that need a process the reap cannot kill (one refused open, one boxed open after an unboxed one) now use kthreadd on Linux. They borrowed the lowest-pid root process, which can end while the test runs. When it did, the reap found nothing left to wait for, the open went through, and the test failed with `Missing expected rejection`. kthreadd lives as long as the kernel and no unprivileged user can signal it. On macOS, or in a container where pid 2 is not a kernel thread, the tests still borrow the lowest-pid root process. Test-only: the reap and the open are unchanged.
