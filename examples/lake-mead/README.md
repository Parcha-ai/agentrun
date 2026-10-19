# Lake Mead from Space, 40 Years

The question in [question.md](question.md), asked of thirteen Landsat images of the same frame over Lake Mead, from Hoover Dam to the Overton Arm, 1984 to 2024 ([inputs.json](inputs.json), committed in [images/](images/)): when the water fell the most and where, every shoreline the water has left against 1984 boxed, and the first image each is dry in. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code. The images are cropped, true-colour renders of USGS Landsat Collection 2 scenes (Landsat 5, 8 and 9), one frame and one stretch for all thirteen; inputs.json names each scene, the mirror it was read from, the crop and the stretch, and ASSETS.md names each image's scene and what was done to it.

```sh
npm run demo:vision -- examples/lake-mead --live
```

The agent runs shell commands with your user's rights on your machine: run it in a container or a VM.

The run is also given [map-key.md](map-key.md): the named arms, basins, bays, washes and rivers inside the frame, as the National Park Service's map names them, with where each lies, in thirds.
