# Lake Mead from Space, 40 Years

The question in [question.md](question.md), asked of thirteen Landsat images of the same frame over Lake Mead, from Hoover Dam to the Overton Arm, 1984 to 2024 ([inputs.json](inputs.json), committed in [images/](images/)): when the water fell the most and where, every shoreline the water has left against 1984 boxed, and the first image each is dry in. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code. The images are cropped, true-colour renders of USGS Landsat Collection 2 scenes (Landsat 5, 8 and 9), one frame and one stretch for all thirteen; inputs.json names each scene, the mirror it was read from, the crop and the stretch, and ASSETS.md names each image's scene and what was done to it.

```sh
npm run demo:vision -- examples/lake-mead --live
```

The agent runs shell commands with your user's rights on your machine: run it in a container or a VM.

## Map key

The named arms, basins, bays, washes and rivers inside the frame, as the National Park Service's map of Lake Mead National Recreation Area names them, with where each lies in the frame, in thirds (left, middle, right; top, middle, lower):

| Name | Where in the frame |
| --- | --- |
| Muddy River | right third, top third, at the top of the Overton Arm |
| Virgin River | right third, top third, at the top of the Overton Arm, east of the Muddy River |
| Overton Arm | the long arm in the right third, from the top third down into the lower third |
| Salt Bay | right third, top third, on the east side of the Overton Arm |
| Echo Bay | right third, middle third, on the west side of the Overton Arm |
| Echo Wash | middle third, middle third |
| Quail Springs Wash | right third, middle third, east of the Overton Arm |
| Catclaw Wash | right third, middle third, east of the Overton Arm |
| Boulder Wash | middle third, middle third, near its lower edge |
| Callville Bay | left third, lower third |
| Las Vegas Bay | its east end, at the left edge, lower third; the rest lies west of the frame |
| Boulder Basin | left third, lower third |
| Kingman Wash | left third, lower third, on the south side |
| Virgin Basin | middle third, lower third |
| Petroglyph Wash | middle third, lower third, on the south side |
| Bonelli Bay | middle third, lower third, toward the right |
| Temple Basin | right third, lower third |
| Hoover Dam | left third, at the bottom edge |

Names from "Park Map - Lake Mead National Recreation Area", National Park Service, Harpers Ferry Center (PDF: https://www.nps.gov/npgallery/GetAsset/b74cc29c-79a5-4ab4-ac69-54982c8a4a3a); only names are taken, no image. Its page in the National Park Service's map gallery says: "The National Park Service maps are government produced and are in the public domain. Anyone may, without restriction under U.S. copyright laws: Reproduce the work in print or digital form; Create derivative works; Perform the work publicly; Display the work; Distribute copies or digitally transfer the work to the public by sale or other transfer of ownership, or by rental, lease, or lending."
