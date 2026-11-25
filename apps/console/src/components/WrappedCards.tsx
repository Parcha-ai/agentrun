import { type CardBody, renderCard } from "@/lib/cardImage";
import { drawnBody, SATISFIED_WAITS } from "@/lib/wrappedCardBodies";
import type { CardRenderer, CardWait } from "@/lib/wrappedCards";

/** A card body as the image renderCard draws: its data URL in an <img> (the console's CSP allows img-src data:), its words
 *  as the alt, at the card's own size and scaled down to its box. */
export function CardPicture({ body }: { body: CardBody }) {
  const image = renderCard(body);
  return <img src={image.dataUrl} alt={image.alt} width={image.width} height={image.height} className="block h-auto w-full border" />;
}

/** The waits met once the person turns the opt-in cards on. */
const WITH_OPT_IN: ReadonlySet<CardWait> = new Set<CardWait>([...SATISFIED_WAITS, "opt-in"]);

/** The Wrapped page's cards: each one whose waits are met (an opt-in card's only once the person turned it on) and that
 *  the year has a body for, as its picture; null else. */
export const wrappedCards: CardRenderer = (card, data, optIn) => {
  const body = drawnBody(card, data, optIn ? WITH_OPT_IN : SATISFIED_WAITS);
  return body ? <CardPicture body={body} /> : null;
};
