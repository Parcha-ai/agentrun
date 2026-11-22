# Build the Archil image (this folder's Dockerfile) as a Daytona snapshot, with Daytona's Python SDK (`pip install
# daytona`) and its key in DAYTONA_API_KEY, and print the snapshot's name, which a Daytona computer's spec names as its
# image: a Daytona computer with an Archil mount, on a self-hosted target with an Archil egress relay (archilEgress),
# starts from it (on Daytona's hosted cloud Archil's client hangs, so no computer there takes the mount). The name is
# the recipe's hash (the Dockerfile and the files it copies, install.sh among them), so a changed recipe is
# a new snapshot, and the same recipe is the one built before: Daytona then refuses the name, and the printed name is
# the one to use. Its name is agentrun-box-<the recipe's hash>, and its size is 2 CPUs, 4 GB of memory and a 10 GB disk.
#
# With --gpu H100, the same image as a GPU snapshot: a snapshot carries its own resources, the GPU among them, so its
# sandboxes have one H100 (and daytona-gpu's 16 CPUs, 100 GB of memory and a 400 GB disk), in region earth, Daytona's
# GPU region. Its name is agentrun-archil-gpu-h100-<the recipe's hash>: the provider's gpuSnapshot option takes it, and
# reads the GPU from it. Another type is another snapshot.
#
# The snapshot's entrypoint is the Dockerfile's CMD, named: Daytona's toolbox runs a snapshot's entrypoint as its first
# command, and a snapshot built from a Dockerfile with no ENTRYPOINT gets `sleep infinity` instead, never the CMD
# (daytonaio/daytona@b5a5d9e7 apps/api/src/sandbox/services/snapshot.service.ts:883-901). That CMD starts agentrun-dial
# when AGENTRUN_ATTACH_URL is in the sandbox's env, and sleeps otherwise. The provider no longer needs it: on connect
# "dial" its create leaves AGENTRUN_ATTACH_URL out of the env and starts agentrun-dial in a toolbox session itself, so a
# box snapshot registered without this entrypoint dials too, and this one sleeps instead of dialing twice. The name is
# agentrun-box-<hash>, the recipe's hash alone (this file is not in it).
#
# With --documents, the box image with the documents layer run on top (../documents/documents.sh, the libraries that
# write decks, documents and sheets, which the Docker box's documents image runs too), as its own snapshot:
# agentrun-documents-<hash>, the hash covering the box recipe and documents.sh, so agentrun-box-<hash> stays what it
# was. AGENTRUN_DAYTONA_SNAPSHOT names it for a server whose agents need those libraries (computer.needs).
#
# --documents takes no --gpu: the GPU snapshot is the box image's alone.
#
#   python3 packages/computer/box/build-daytona.py [--gpu H100 | --documents]
import hashlib
import json
import os
import sys

from daytona import CreateSnapshotParams, Daytona, GpuType, Image, Resources

GPUS = {"H100": GpuType.H100}

args = sys.argv[1:]
usage = f"usage: build-daytona.py [--gpu {'|'.join(GPUS)} | --documents]"
documents = "--documents" in args
if documents:
    args.remove("--documents")
    # The documents layer is for a CPU box: no GPU snapshot of it, whose name daytonaGpuSnapshot() would not take.
    if args:
        sys.exit("build-daytona.py: --documents builds the CPU box's documents snapshot alone; drop --gpu")
gpu = None
if args:
    if len(args) != 2 or args[0] != "--gpu" or args[1] not in GPUS:
        sys.exit(usage)
    gpu = args[1]

here = os.path.dirname(os.path.abspath(__file__))
recipe = b"".join(open(os.path.join(here, name), "rb").read() for name in ("Dockerfile", "install.sh", "agentrun-archil"))
# The documents layer's folder, with a trailing separator: Daytona's SDK then files documents.sh at the top of the
# build's context as documents.sh, beside the box's install.sh, never over it.
layer = os.path.join(os.path.dirname(here), "documents", "")
if documents:
    recipe += open(os.path.join(layer, "documents.sh"), "rb").read()
digest = hashlib.sha256(recipe).hexdigest()[:12]
name = f"agentrun-archil-gpu-{gpu.lower()}-{digest}" if gpu else f"agentrun-documents-{digest}" if documents else f"agentrun-box-{digest}"
image = Image.from_dockerfile(os.path.join(here, "Dockerfile"))
if documents:
    image = image.dockerfile_commands(["COPY documents.sh /tmp/agentrun-documents/documents.sh", "RUN sh /tmp/agentrun-documents/documents.sh && rm -rf /tmp/agentrun-documents"], context_dir=layer)
cmd = [json.loads(line[4:]) for line in open(os.path.join(here, "Dockerfile")).read().splitlines() if line.startswith("CMD ")][-1]
print(f"build-daytona: snapshot {name}", file=sys.stderr)
Daytona().snapshot.create(
    CreateSnapshotParams(
        name=name,
        image=image,
        entrypoint=cmd,
        resources=Resources(cpu=16, memory=100, disk=400, gpu=1, gpu_type=GPUS[gpu]) if gpu else Resources(cpu=2, memory=4, disk=10),
        **({"region_id": "earth"} if gpu else {}),
    ),
    on_logs=lambda line: print(line, file=sys.stderr),
)
print(f"snapshot={name}")
