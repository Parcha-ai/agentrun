---
packages: repo
kind: ci
---
serve's box tests plant the four keys a tester runs everything with (OpenRouter's, Monid's, Parallel's and Browserbase's), as well as an unnamed key and OpenAI's, each as its own sentinel value, and search the box's environment and `/proc` for every value. A key handed to a harness under another name, such as the OpenRouter key passed on as a model key, now fails the tests if it reaches a box. The faux-box, fake-Docker and real-Docker tests all change. Test-only: the server is unchanged.
