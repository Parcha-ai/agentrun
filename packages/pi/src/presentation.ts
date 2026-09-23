import type { ExtensionRunReport } from './extension-service.js';

export const cleanText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

export const modelJson = (value: unknown): string => JSON.stringify(value).replace(/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

function lines(value: unknown, depth = 0): string[] {
  if (value === null || typeof value !== 'object') return [String(value)];
  if (depth > 5) return ['…'];
  if (Array.isArray(value)) return value.slice(0, 30).flatMap(item => {
    const [first = '', ...rest] = lines(item, depth + 1);
    return [`• ${first}`, ...rest.map(line => `  ${line}`)];
  }).concat(value.length > 30 ? [`… ${value.length - 30} more items in the structured result`] : []);
  const entries = Object.entries(value);
  return entries.slice(0, 30).flatMap(([key, item]) => {
    const label = key.replace(/([a-z])([A-Z])/g, (_, first: string, upper: string) => `${first} ${upper.toLowerCase()}`).replace(/_/g, ' ');
    const children = lines(item, depth + 1);
    return children.length === 1 ? [`${label}: ${children[0]}`] : [`${label}:`, ...children.map(line => `  ${line}`)];
  }).concat(entries.length > 30 ? [`… ${entries.length - 30} more fields in the structured result`] : []);
}

export function formatRunReport(report: ExtensionRunReport, scripted = false): string {
  const body = report.output === undefined ? report.escalation?.summary ?? [
    report.error?.stage ? `Step: ${report.error.stage}` : undefined,
    report.error?.path ? `State path: ${report.error.path}` : undefined,
    report.error?.reason ? `Reason: ${report.error.reason}` : undefined,
    Number.isInteger(report.error?.status) && report.error!.status! >= 100 && report.error!.status! <= 599 ? `HTTP status: ${report.error!.status}` : undefined,
    report.error?.message, ...(report.error?.problems ?? []),
  ].filter(Boolean).join('\n') : lines(report.output).join('\n');
  const recovery = report.error ? '\nInspect the failed step with /agentrun. Use /agentrun status to check configuration before retrying.' : '';
  const uncertain = report.uncertainEffects?.length ? '\nSome tool effects have an unknown outcome. Check their actual state before retrying.' : '';
  const trace = report.traceTruncated ? `\nTrace retention is partial${report.trace ? ` (${report.trace.droppedEvents} valid events omitted, ${report.trace.rejectedEvents} rejected)` : ''}; this does not mean the output is truncated.` : '';
  const clipped = body.length > 12_000 ? `${body.slice(0, 12_000)}\n… Full output is in the structured result.` : body;
  const status = report.status === 'escalated' ? 'stopped — needs attention (escalated)' : report.status;
  return cleanText(`${scripted ? 'Scripted demo' : 'Workflow'}: ${status}${report.error ? ` (${report.error.code})` : ''}\n\n${clipped}${recovery}${uncertain}${trace}\n\nWorkflow calls: ${report.calls.tool} direct tool call${report.calls.tool === 1 ? '' : 's'}, ${report.calls.judge} system one decision${report.calls.judge === 1 ? '' : 's'}, ${report.calls.agent} model step${report.calls.agent === 1 ? '' : 's'}.${scripted ? '\nScripted responses; no model calls. Replay: /agentrun run. Example modes: /agentrun help.' : ''}`);
}
