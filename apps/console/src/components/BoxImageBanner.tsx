import type { BoxOffer } from "@/lib/place";

/** Mission Control's line while a box's image is still coming (capabilities' `places.boxes`, state `preparing`), in the
 *  server's words (its `reason`: "building the box image (…)", "pulling <image>"), as a run's page says it on its
 *  timeline when its first box waits. */
export function BoxImageBanner({ box }: { box: BoxOffer }) {
  const name = box.id === "docker" ? "Docker" : box.id;
  return (
    <p role="status" aria-label={`${name} box`} className="border-b bg-card px-5 py-3 text-body text-muted-foreground md:px-8">
      Preparing the {name} box{box.reason ? `: ${box.reason}` : ""}. A sandbox run waits for it before its first tool call.
    </p>
  );
}
