/** A dollar figure rounded to the micro-dollar (6 places), as the server books and shows money. A leaf module. */
export const micro = (usd: number): number => Math.round(usd * 1e6) / 1e6;
