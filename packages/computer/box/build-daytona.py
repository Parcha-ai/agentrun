# Build the Archil image (this folder's Dockerfile) as a Daytona snapshot, with Daytona's Python SDK (`pip install
# daytona`) and its key in DAYTONA_API_KEY, and print the snapshot's name: a Daytona computer with an Archil mount names
# it as its spec's image. The name is the recipe's hash (the Dockerfile and the files it copies), so a changed recipe is
# a new snapshot, and the same recipe is the one built before: Daytona then refuses the name, and the printed name is
# the one to use. Its size is 2 CPUs, 4 GB of memory and a 10 GB disk.
#
# With --gpu H100, the same image as a GPU snapshot: a snapshot carries its own resources, the GPU among them, so its
# sandboxes have one H100 (and daytona-gpu's 16 CPUs, 100 GB of memory and a 400 GB disk), in region earth, Daytona's
# GPU region. Its name is agentrun-archil-gpu-h100-<the recipe's hash>: the provider's gpuSnapshot option takes it, and
# reads the GPU from it. Another type is another snapshot.
#
#   python3 packages/computer/box/build-daytona.py [--gpu H100]
import hashlib
import os
import sys

from daytona import CreateSnapshotParams, Daytona, GpuType, Image, Resources

GPUS = {"H100": GpuType.H100}

args = sys.argv[1:]
gpu = None
if args:
    if len(args) != 2 or args[0] != "--gpu" or args[1] not in GPUS:
        sys.exit(f"usage: build-daytona.py [--gpu {'|'.join(GPUS)}]")
    gpu = args[1]

here = os.path.dirname(os.path.abspath(__file__))
recipe = b"".join(open(os.path.join(here, name), "rb").read() for name in ("Dockerfile", "agentrun-archil"))
digest = hashlib.sha256(recipe).hexdigest()[:12]
name = f"agentrun-archil-gpu-{gpu.lower()}-{digest}" if gpu else f"agentrun-archil-{digest}"
print(f"build-daytona: snapshot {name}", file=sys.stderr)
Daytona().snapshot.create(
    CreateSnapshotParams(
        name=name,
        image=Image.from_dockerfile(os.path.join(here, "Dockerfile")),
        resources=Resources(cpu=16, memory=100, disk=400, gpu=1, gpu_type=GPUS[gpu]) if gpu else Resources(cpu=2, memory=4, disk=10),
        **({"region_id": "earth"} if gpu else {}),
    ),
    on_logs=lambda line: print(line, file=sys.stderr),
)
print(f"snapshot={name}")
