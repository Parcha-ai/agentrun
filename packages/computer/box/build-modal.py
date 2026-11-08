# Build the box image (this folder's Dockerfile) on Modal, with Modal's Python client (`pip install 'modal>=1.2'`) and
# its token (MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or `modal token set`), and print the setting that names it: the
# image's id, `im-...`, which the Modal sandbox starts from. The build runs in the app the server's sandboxes live in
# (AGENTRUN_BOX_APP, default agentrun); an image id is the workspace's, whichever app built it. The same recipe is
# Modal's cached build, the same id.
#
#   python3 packages/serve/box/build-modal.py
import os
import sys

import modal

here = os.path.dirname(os.path.abspath(__file__))
app = modal.App.lookup(os.environ.get("AGENTRUN_BOX_APP") or "agentrun", create_if_missing=True)
image = modal.Image.from_dockerfile(os.path.join(here, "Dockerfile"), context_dir=here)
image.build(app)
print(f"build-modal: image {image.object_id}", file=sys.stderr)
print(f"AGENTRUN_VM_IMAGE={image.object_id}")
