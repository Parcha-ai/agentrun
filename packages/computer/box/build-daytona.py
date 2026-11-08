# Build the Archil image (this folder's Dockerfile) as a Daytona snapshot, with Daytona's Python SDK (`pip install
# daytona`) and its key in DAYTONA_API_KEY, and print the snapshot's name: a Daytona computer with an Archil mount names
# it as its spec's image. The name is the recipe's hash (the Dockerfile and the files it copies), so a changed recipe is
# a new snapshot, and the same recipe is the one built before: Daytona then refuses the name, and the printed name is
# the one to use. Its size is 2 CPUs, 4 GB of memory and a 10 GB disk.
#
#   python3 packages/computer/box/build-daytona.py
import hashlib
import os
import sys

from daytona import CreateSnapshotParams, Daytona, Image, Resources

here = os.path.dirname(os.path.abspath(__file__))
recipe = b"".join(open(os.path.join(here, name), "rb").read() for name in ("Dockerfile", "agentrun-archil"))
name = "agentrun-archil-" + hashlib.sha256(recipe).hexdigest()[:12]
print(f"build-daytona: snapshot {name}", file=sys.stderr)
Daytona().snapshot.create(
    CreateSnapshotParams(
        name=name,
        image=Image.from_dockerfile(os.path.join(here, "Dockerfile")),
        resources=Resources(cpu=2, memory=4, disk=10),
    ),
    on_logs=lambda line: print(line, file=sys.stderr),
)
print(f"snapshot={name}")
