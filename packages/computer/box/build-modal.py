# Build the Archil image (this folder's Dockerfile) on Modal, with Modal's Python client (`pip install 'modal>=1.2'`)
# and its token (MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or `modal token set`), in the app named as the first argument
# (default agentrun-computer), and print the image's id, `im-...`: a Modal computer with an Archil mount names it as its
# spec's image. The same recipe is Modal's cached build, the same id.
#
#   python3 packages/computer/box/build-modal.py [app]
import os
import sys

import modal

here = os.path.dirname(os.path.abspath(__file__))
app = modal.App.lookup(sys.argv[1] if len(sys.argv) > 1 else "agentrun-computer", create_if_missing=True)
image = modal.Image.from_dockerfile(os.path.join(here, "Dockerfile"), context_dir=here)
image.build(app)
print(f"build-modal: image {image.object_id}", file=sys.stderr)
print(f"image={image.object_id}")
