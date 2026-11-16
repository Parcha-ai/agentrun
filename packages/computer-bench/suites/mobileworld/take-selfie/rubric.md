# Rubric: Take a photo with the camera

## Done means

- The phone's camera app took a photo during the run, and it is saved (it shows in the camera's preview or the gallery).

## Also acceptable

- Front or back camera, any mode that saves a still photo (portrait, night, and so on).
- More than one photo.
- The camera app left open.

## Not done

- A screenshot instead of a photo.
- A video only.
- The shutter pressed but the photo not saved (the camera closed before it finished, or storage full).

## What the checks cover

- `new-photo` counts finished image files under DCIM and Pictures that are newer than setup's marker, leaving out
  Screenshots folders. It can't tell a camera photo from another image an app saves there (a downloaded or edited
  picture), so the grader checks on screen that the camera was used.

## Side effects that fail the task

- Photos that were there before the run deleted or edited.
- Camera settings changed (resolution, location tags, sounds).
