// A lesson that names a site the tools refuse (an EDGAR or filing mirror, a SIC listing site, any EDGAR-named host) would
// send a later run into a refusal or toward an unsanctioned lookup, so curate refuses it, for every lesson, by structure:
// the hostname-shaped words of its text, each judged by the tools' own refusedHost. The sanctioned lookup's own hosts,
// sec.gov (its paths, inside a Wayback copy) and archive.org (the Wayback Machine), are not counted.
import { refusedHost } from './tools.mjs';

const SANCTIONED = ['sec.gov', 'archive.org'];
const HOSTNAME = /(?<![@\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** The refused hosts a text names, in the order it names them. */
export function namedRefusedHosts(text) {
  const out = [];
  for (const [, word] of String(text ?? '').matchAll(HOSTNAME)) {
    const host = word.toLowerCase();
    if (!/^[a-z]{2,}$/.test(host.split('.').pop())) continue;
    if (SANCTIONED.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    if (refusedHost(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * A curate judge port that answers the rules question for a learning naming a refused host itself: yes, it contradicts the
 * job's rule that those sites are refused (noul 1, no model asked). Curate then refuses the learning ("contradicts or
 * narrows a rule (1.00)"). `hits` collects each one, `{ hosts, text }`, as the host's log of why. Everything else goes to
 * `judge` as it was asked.
 */
export function refusedHostsJudge(judge, hits = []) {
  return async (params) => {
    const [question] = Object.keys(params?.questions ?? {});
    const text = params?.state?.learning?.text;
    const hosts = question === 'narrowsRules' ? namedRefusedHosts(text) : [];
    if (!hosts.length) return judge(params);
    hits.push({ hosts, text: String(text).slice(0, 300) });
    return { answers: { [question]: { type: 'noul', noul: 1 } }, model: 'host:refused-hosts', usage: null, cost_usd: 0, request_sha256: '' };
  };
}
