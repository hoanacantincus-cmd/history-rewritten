import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { configureProviders } from './providers.ts';
import type { Providers } from './providers.ts';
import { research } from './research.ts';
import { requestSchema } from './schema.ts';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon',
};
const limit = 180_000;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readInput(request: IncomingMessage) {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    bytes += part.length;
    if (bytes > limit) {
      // Stop accumulating data but drain the request to send a structured response.
      if (parts.length) parts.length = 0;
    } else {
      parts.push(part);
    }
  }
  if (bytes > limit) throw new Error('请求正文过大。');
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export function createApp(providers: Providers = configureProviders(), buildDirectory = resolve('dist')) {
  let running = false;
  const root = resolve(buildDirectory);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!/^((127\.0\.0\.1|localhost)(:\d+)?|\[::1\](:\d+)?)$/i.test(request.headers.host ?? '')) {
        return json(response, 403, { error: 'This application accepts local hosts only' });
      }
      if (url.pathname === '/api/status' && request.method === 'GET') return json(response, 200, { mode: 'self-hosted' });
      if (url.pathname === '/api/research' && request.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
          return json(response, 415, { error: 'Expected application/json' });
        }
        if (running) return json(response, 409, { error: '已有分析正在运行，请稍后重试。' });
        let data: ReturnType<typeof requestSchema.parse>;
        try { data = requestSchema.parse(await readInput(request)); }
        catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : '请求无效。' }); }
        if (running) return json(response, 409, { error: '已有分析正在运行，请稍后重试。' });
        running = true;
        try { return json(response, 200, await research(data, providers)); }
        catch (error) { return json(response, 502, { error: error instanceof Error ? error.message : '分析失败。' }); }
        finally { running = false; }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      const type = mime[extname(file)];
      if (!type || !file.startsWith(root + sep)) return json(response, 404, { error: 'Not found' });
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return json(response, 404, { error: '页面未构建，请先运行 npm run build。' });
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) json(response, 400, { error: 'Invalid request' });
      else response.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const port = Number(process.env.PORT ?? 4173);
  createApp().listen(port, '127.0.0.1', () => console.log('History Rewritten → http://127.0.0.1:' + port));
}
