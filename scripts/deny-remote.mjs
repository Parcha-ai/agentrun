// Preload for a run whose pages are served from this machine: loopback is admitted, every other address and every unix socket is refused.
import net from 'node:net';
import http from 'node:http'; import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const loopback = host => host === undefined || host === null || host === '' || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(String(host));
const refuse = what => { throw new Error('Networking beyond loopback prohibited during package smoke tests: ' + what); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  // Like node's own argument handling: a string that is not a number is a socket path, not a port.
  const pipe = typeof first === 'string' && (first.trim() === '' || Number.isNaN(Number(first)));
  const options = first !== null && typeof first === 'object' ? first : pipe ? { path: first } : { port: first, host: typeof second === 'string' ? second : undefined };
  if (options.path != null) refuse('unix socket ' + options.path);
  if (!loopback(options.host)) refuse(String(options.host));
  return connect.apply(this, args);
};
globalThis.fetch = () => refuse('fetch');
for (const [module, name] of [[https, 'request'], [https, 'get']]) module[name] = () => refuse(name);
const check = original => (...args) => { const first = args[0]; const host = typeof first === 'string' || first instanceof URL ? new URL(first).hostname : first?.hostname ?? first?.host; if (!loopback(host)) refuse(String(host)); return original(...args); };
http.request = check(http.request); http.get = check(http.get);
syncBuiltinESMExports();
