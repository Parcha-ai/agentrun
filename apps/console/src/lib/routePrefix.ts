/** `id` without the routing prefix the server names (capabilities' `models.route_prefix`, a gateway's; null without
 *  one), else `id` as it is: also when nothing follows the prefix. The prefix is always the server's, never one read off
 *  an id. The one strip, for modelLabel (what a person reads) and planRuns and the first screen's card (whether a
 *  gateway's default, `agent-model/chatgpt/<id>`, is a plan model). Its own module: lib/models.ts imports lib/chatgpt.ts. */
export function withoutRoutePrefix(id: string, routePrefix: string | null | undefined): string;
export function withoutRoutePrefix(id: string | null | undefined, routePrefix: string | null | undefined): string | null | undefined;
export function withoutRoutePrefix(id: string | null | undefined, routePrefix: string | null | undefined): string | null | undefined {
  return routePrefix && id?.startsWith(`${routePrefix}/`) && id.length > routePrefix.length + 1 ? id.slice(routePrefix.length + 1) : id;
}
