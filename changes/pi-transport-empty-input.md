---
packages: @parcha/pi-transport
kind: fix
---
An empty write, append or upload no longer waits on a stdin end that `docker exec -i` can lose. `boxEnv`'s `writeFile` and `appendFile` with no bytes, `uploadByExec` of an empty file and `moveFile` of a sealed file of no bytes now read their input from `/dev/null` in the box (`exec </dev/null;` in front of the script) and send nothing over the exec's stdin. Before, one empty call in about 2,700 on Docker never got its end of input, the box's `cat` waited for it, and the call ended at the operation timeout as an `unknown` file error. A non-empty write is unchanged. This sits in `boxEnv`, so it covers every provider with an exec stdin.
