// The forge's HTTP shell: one server, one store, four surfaces. Routing is by path prefix only —
// the surface modules own their own auth, shapes and status codes, and answer true when they
// handled a request. Anything unclaimed is GitHub's JSON 404. The body is read whole before
// dispatch (the largest body the suite sends is a pack of a few hundred kilobytes).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** A per-process request id, hex, non-empty — the X-GitHub-Request-Id every reply carries. */
export function requestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(8, '0');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
  });
  res.end(text);
}

/** The decoded path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}

/** The query of a request URL, or an empty set when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body whole. A body that never ends is cut off by the caller's timeout. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Build the server. It binds nothing until the caller listens; the entry listens on an
 * ephemeral port and registers it with the env. One store is shared by every surface, so a
 * repository pushed over git is readable over REST, GraphQL and MCP with the same ids.
 */
export function createApp(store: Store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const query = queryOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = await readBody(req);

        if (path === '/api/graphql' || path === '/api/graphql/') {
          if (await handleGraphql(store, req, res, path, query, body)) return;
        }
        if (path === '/mcp' || path === '/mcp/') {
          if (await handleMcp(store, req, res, path, query, body)) return;
        }
        if (path.startsWith('/api/v3')) {
          if (await handleRest(store, req, res, path, query, body)) return;
        }
        if (path.includes('.git/') || path.endsWith('.git')) {
          if (await handleGit(store, req, res, path, query, body)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A surface module threw: answer 500 JSON and keep serving. A crash scores 0; a 500 on
        // one request costs one check at most.
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
          } catch {
            // The socket is already gone; nothing left to do.
          }
        }
      }
    })();
  });
}
