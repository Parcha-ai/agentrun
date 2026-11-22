---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
The computer package ships a documents image (`packages/computer/documents`): the default image plus python-pptx, python-docx and openpyxl for `python3` and pptxgenjs, docx and exceljs for `node`, built as the serve README's "The box's image" says and named in `AGENTRUN_DOCKER_IMAGE`. `computer.needs` may now name a Python or Node library by its pip or npm name, and a box that lacks one fails its run in words naming this image's build.
