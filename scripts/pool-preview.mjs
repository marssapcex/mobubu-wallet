import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// No APIs, chain connections, wallet injection, remote dependencies or server-side secrets.
const root = new URL('../', import.meta.url);
const paths = new Map([
  ['/', ['apps/pool/index.html', 'text/html']],
  ['/pool.css', ['apps/pool/pool.css', 'text/css']],
  ['/pool.mjs', ['apps/pool/pool.mjs', 'text/javascript']],
  ['/packages/pool/src/notes.mjs', ['packages/pool/src/notes.mjs', 'text/javascript']],
  ['/fhe-swap/src/network-catalog.mjs', ['fhe-swap/src/network-catalog.mjs', 'text/javascript']],
  ['/fhe-swap/src/asset-catalog.mjs', ['fhe-swap/src/asset-catalog.mjs', 'text/javascript']],
]);
const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'",
};
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid preview port');
createServer(async (req, res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end(); return; }
  const route = paths.get(req.url);
  if (!route) { res.writeHead(404, headers).end(); return; }
  try {
    const data = await readFile(new URL(route[0], root));
    res.writeHead(200, { ...headers, 'content-type': `${route[1]}; charset=utf-8`, 'content-length': data.length }).end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(500, headers).end(); }
}).listen(port, '0.0.0.0', () => console.log(`Mobubu Pool preview · port ${port} · no wallet or transactions`));
