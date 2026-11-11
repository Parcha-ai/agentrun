---
packages: repo
kind: ci
---
CI's step that installs poppler, Ghostscript and ffmpeg retries when the package mirror can't be reached for a moment. apt-get retries each download three times (`Acquire::Retries=3`), and the update and install are tried three times in all, 10 s then 30 s apart, failing only after the third try. Before, one "Network is unreachable" failed the job in setup.
