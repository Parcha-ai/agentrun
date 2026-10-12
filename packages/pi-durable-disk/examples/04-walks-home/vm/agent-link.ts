/** The agent's page address for a robot run: the run's link with the page's switches (`golive=1`: going offline and back) before the fragment, which stays last (it is the run's secret). */
export function agentLink(link: string, query: string): string {
  const url = new URL(link);
  if (url.search) return link;
  const hash = link.indexOf("#");
  return hash < 0 ? `${link}?${query}` : `${link.slice(0, hash)}?${query}${link.slice(hash)}`;
}
