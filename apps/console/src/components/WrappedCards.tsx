import { type CardBody, renderCard } from "@/lib/cardImage";
import { drawnBody } from "@/lib/wrappedCardBodies";
import type { CardRenderer } from "@/lib/wrappedCards";

/** A card body as the image renderCard draws: its data URL in an <img> (the console's CSP allows img-src data:), its words
 *  as the alt, at the card's own size and scaled down to its box. */
export function CardPicture({ body }: { body: CardBody }) {
  const image = renderCard(body);
  return <img src={image.dataUrl} alt={image.alt} width={image.width} height={image.height} className="block h-auto w-full border" />;
}

/** The Wrapped page's cards: each one whose waits are met and that the year has a body for, as its picture; null else. */
export const wrappedCards: CardRenderer = (card, data) => {
  const body = drawnBody(card, data);
  return body ? <CardPicture body={body} /> : null;
};
