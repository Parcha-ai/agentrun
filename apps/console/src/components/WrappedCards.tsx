import { useState } from "react";
import { Button } from "@/components/ui";
import { type CardBody, type CardImage, renderCard, toPng } from "@/lib/cardImage";
import { drawnBody } from "@/lib/wrappedCardBodies";
import type { CardRenderer } from "@/lib/wrappedCards";

/** Saves `image` as the PNG toPng draws of it, under `file`: a download of a blob URL, revoked once clicked. */
async function savePng(image: CardImage, file: string): Promise<void> {
  const url = URL.createObjectURL(await toPng(image));
  Object.assign(document.createElement("a"), { href: url, download: file }).click();
  URL.revokeObjectURL(url);
}

/** A card body as the image renderCard draws: its data URL in an <img> (the console's CSP allows img-src data:), its words
 *  as the alt, at the card's own size and scaled down to its box. With `download` (the file's name and the card's), a
 *  button under it saves the card as a PNG, and says so beside it when this browser can't draw one. */
export function CardPicture({ body, download }: { body: CardBody; download?: { file: string; name: string } }) {
  const image = renderCard(body);
  const [failed, setFailed] = useState<string | null>(null);
  const picture = <img src={image.dataUrl} alt={image.alt} width={image.width} height={image.height} className="block h-auto w-full border" />;
  if (!download) return picture;
  const save = () => {
    setFailed(null);
    savePng(image, download.file).catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  };
  return (
    <figure className="m-0">
      {picture}
      <figcaption className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={save} aria-label={`Download the ${download.name} card as a PNG`}>Download PNG</Button>
        {failed && <span role="status" className="text-small text-warning-text">This card could not be saved as a PNG: {failed}.</span>}
      </figcaption>
    </figure>
  );
}

/** The Wrapped page's cards: each one whose waits are met and that the year has a body for, as its picture with its PNG
 *  download (`wrapped-<year>-<card>.png`); null else. */
export const wrappedCards: CardRenderer = (card, data) => {
  const body = drawnBody(card, data);
  return body ? <CardPicture body={body} download={{ file: `wrapped-${data.year}-${card.id}.png`, name: card.name }} /> : null;
};
