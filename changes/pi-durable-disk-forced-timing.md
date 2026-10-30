---
packages: @parcha/pi-durable-disk
kind: ci
---
Two of pi-durable-disk's tests that failed only on a loaded machine now force their order instead of racing the clock. The park test bounded the wake by the test's own clock read after parking, so a park slower than the 1.5 s retry wait failed it; it now bounds the wake by pi's own deadline, between the error's time plus the backoff and the park's time plus the backoff. The lease-lapse test needed its first commit within the 800 ms before the self-fence; its fixture now holds the self-fence's clock until that commit has landed, then moves it past the limit.
