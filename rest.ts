// The forge's GitHub REST v3 surface (/api/v3): repositories, branches, commits, contents,
// labels, issues, pull requests and merges. All state lives in the shared Store; this module
// never touches disk and never calls a git binary. Every reply is JSON with a
// X-GitHub-Request-Id; every route requires the bearer token (see auth below).
//
// Two deliberate behaviours worth knowing:
// - POST /labels upserts: the store seeds the six GitHub labels, and the conformance suite
//   POSTs one of those seeded names (e.g. "bug") and expects 201, so re-posting an existing
//   label updates it and answers 201 instead of 422. A missing/empty name is still 422.
// - GET /issues lists pull requests too, as GitHub does (a pull request IS the issue with
//   its number); GET /pulls/{n} on a plain issue number is 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  deletePath,
  filesOfCommit,
  getObject,
  mergeable,
  parseCommit,
  parseTree,
  prFiles,
  squashMerge,
  writePath,
  type ItemRec,
  type LabelRec,
  type Repo,
  type Store,
} from './store.ts';

type Json = Record<string, unknown>;

let requestSeq = 0;

/** A per-process request id, hex, non-empty. */
function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------
// Reply plumbing

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(res, status, { message });
}

// ---------------------------------------------------------------------------------------------
// Auth

/**
 * The bearer token names the viewer. When MAKEFUN_SHOP_TOKEN is set and non-empty the request
 * must carry exactly "Bearer <that token>"; when it is unset/empty any non-empty Bearer token
 * is accepted. No (or an empty/malformed) Authorization header is 401 on every /api/v3 route.
 */
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || header.trim() === '') return false;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (match === null) return false;
  const token = match[1].trim();
  if (token === '') return false;
  const env = process.env.MAKEFUN_SHOP_TOKEN;
  if (env !== undefined && env !== '') return token === env;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Shapes

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(label: LabelRec): Json {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, item: ItemRec): Json {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => ({ name })),
    user: { login: item.userLogin },
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    comments: item.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${item.number}`,
  };
}

function commentJson(comment: { id: number; body: string; userLogin: string; createdAt: string }): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin },
    created_at: comment.createdAt,
  };
}

function pullJson(repo: Repo, item: ItemRec): Json {
  const headSha = (item.headRef !== null ? repo.refs.get(`refs/heads/${item.headRef}`) : undefined) ?? item.headSha;
  const baseSha = (item.baseRef !== null ? repo.refs.get(`refs/heads/${item.baseRef}`) : undefined) ?? item.baseSha;
  // Mergeability is judged against the branches' live tips: the base may have moved since
  // the pull request was opened (e.g. another pull request merged first).
  const live: ItemRec = { ...item, headSha, baseSha };
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    head: { ref: item.headRef, sha: headSha },
    base: { ref: item.baseRef, sha: baseSha },
    user: { login: item.userLogin },
    merged: item.merged,
    merged_at: item.mergedAt,
    merge_commit_sha: item.mergeCommitSha,
    mergeable: mergeable(repo, live),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const rawPerPage = Number(query.get('per_page'));
  const perPage = Number.isSafeInteger(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30;
  const rawPage = Number(query.get('page'));
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], params: PageParams): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { pageItems: items.slice(start, start + params.perPage), totalPages };
}

/**
 * The Link header for the next (and last) page, on the same origin as the request, keeping the
 * other query parameters. Only sent when another page exists, so a walk of the chain ends.
 */
function linkHeader(req: IncomingMessage, pathname: string, query: URLSearchParams, params: PageParams, totalPages: number): string | null {
  if (params.page >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const build = (page: number): string => {
    const next = new URLSearchParams(query);
    next.set('per_page', String(params.perPage));
    next.set('page', String(page));
    return `http://${host}${pathname}?${next.toString()}`;
  };
  return `<${build(params.page + 1)}>; rel="next", <${build(totalPages)}>; rel="last"`;
}

function sendPage<T>(res: ServerResponse, req: IncomingMessage, pathname: string, query: URLSearchParams, items: readonly T[]): void {
  const params = pageParams(query);
  const { pageItems, totalPages } = paginate(items, params);
  const extra: Record<string, string> = {};
  const link = linkHeader(req, pathname, query, params, totalPages);
  if (link !== null) extra.link = link;
  send(res, 200, pageItems, extra);
}

// ---------------------------------------------------------------------------------------------
// Git helpers

/** Resolve a branch name, a full ref, or a raw commit id to a commit oid. */
function resolveTip(repo: Repo, ref: string): string | undefined {
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  const obj = getObject(repo, ref);
  return obj !== undefined && obj.type === 'commit' ? ref : undefined;
}

/** The tree oid of the directory `dirPath` ('' for the root) at a commit, or null. */
function subtreeOid(repo: Repo, commitOid: string, dirPath: string): string | null {
  const commitObj = getObject(repo, commitOid);
  if (commitObj === undefined || commitObj.type !== 'commit') return null;
  let treeOid = parseCommit(commitObj.data).tree;
  if (dirPath === '') return treeOid;
  for (const part of dirPath.split('/')) {
    const treeObj = getObject(repo, treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

interface CommitEntry {
  sha: string;
  epoch: number;
  message: string;
  parents: string[];
}

/** Every commit reachable from a tip, newest first (by the deterministic commit epoch). */
function listCommits(repo: Repo, tipOid: string): CommitEntry[] {
  const seen = new Set<string>();
  const out: CommitEntry[] = [];
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    const epochMatch = / (\d+) \+0000$/.exec(info.author);
    out.push({ sha: oid, epoch: epochMatch === null ? 0 : Number(epochMatch[1]), message: info.message, parents: info.parents });
    for (const parent of info.parents) stack.push(parent);
  }
  // Array.sort is stable, so equal epochs keep discovery order (tip first).
  out.sort((a, b) => b.epoch - a.epoch);
  return out;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------------------------
// The handler

export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';

  // Auth first: every /api/v3 route, including GET / and GET /meta, requires the token.
  if (!authed(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // A non-empty body on a body-bearing method must be valid JSON.
  let parsedBody: Json | null = null;
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && body.length > 0) {
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        sendError(res, 400, 'Request body must be a JSON object');
        return true;
      }
      parsedBody = value as Json;
    } catch {
      sendError(res, 400, 'Malformed JSON in request body');
      return true;
    }
  }
  const jsonBody: Json = parsedBody ?? {};

  const rest = pathname === '/api/v3' ? '' : pathname.slice('/api/v3'.length);

  // GET /api/v3/ — the API root.
  if (rest === '' || rest === '/') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (rest === '/meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (rest === '/user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
    return true;
  }

  // /api/v3/user/repos
  if (rest === '/user/repos') {
    if (method === 'GET') {
      sendPage(res, req, pathname, query, store.reposOf(VIEWER_LOGIN).map((repo) => repoJson(repo)));
      return true;
    }
    if (method === 'POST') {
      const name = jsonBody.name;
      if (typeof name !== 'string' || name.trim() === '') {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      const description = typeof jsonBody.description === 'string' ? jsonBody.description : '';
      const isPrivate = jsonBody.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      send(res, 201, repoJson(repo));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[...]
  if (!rest.startsWith('/repos/')) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const segments = rest.slice('/repos/'.length).split('/');
  const owner = segments[0] ?? '';
  const repoName = segments[1] ?? '';
  const tail = segments.slice(2);
  // A repository belongs to the login the token names; the same name under another owner is
  // 404, never 403 — and a missing repository is 404 the same way.
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      send(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof jsonBody.description === 'string') repo.description = jsonBody.description;
      send(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      send(res, 204, null);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const sub = tail[0];

  // GET /repos/{owner}/{repo}/branches
  if (sub === 'branches' && tail.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const branches: Json[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    send(res, 200, branches);
    return true;
  }

  // POST /repos/{owner}/{repo}/git/refs — create a branch.
  // GET  /repos/{owner}/{repo}/git/refs/... — read a ref (heads/{branch} or a full ref).
  if (sub === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = jsonBody.ref;
      const sha = jsonBody.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
        sendError(res, 422, 'Invalid ref: expected refs/heads/<branch>');
        return true;
      }
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
        sendError(res, 422, 'Invalid sha: expected a 40-character hex object id');
        return true;
      }
      const obj = getObject(repo, sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendError(res, 422, 'sha is not an existing commit');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      send(res, 201, { ref, object: { sha } });
      return true;
    }
    if (method === 'GET' && tail.length > 2) {
      const remainder = tail.slice(2).join('/');
      const refName = remainder.startsWith('refs/')
        ? remainder
        : remainder.startsWith('heads/') || remainder.startsWith('tags/')
          ? `refs/${remainder}`
          : `refs/heads/${remainder}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, { ref: refName, object: { sha } });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET /repos/{owner}/{repo}/commits[?sha=<ref>]
  if (sub === 'commits' && tail.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveTip(repo, ref);
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(
      res,
      200,
      listCommits(repo, tip).map((commit) => ({
        sha: commit.sha,
        commit: { message: commit.message },
        parents: commit.parents.map((sha) => ({ sha })),
        author: { login: VIEWER_LOGIN },
        committer: { login: VIEWER_LOGIN },
      })),
    );
    return true;
  }

  // /repos/{owner}/{repo}/contents/{path...}
  if (sub === 'contents') {
    const path = tail.slice(1).join('/');
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (method === 'GET') {
      const branch = query.get('ref') ?? repo.defaultBranch;
      const tip = resolveTip(repo, branch);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const files = filesOfCommit(repo, tip);
      if (files === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const direct = clean === '' ? undefined : files.get(clean);
      if (direct !== undefined) {
        const blob = getObject(repo, direct.oid);
        if (blob === undefined || blob.type !== 'blob') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        send(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: direct.oid,
          size: blob.data.length,
          name: basename(clean),
          path: clean,
        });
        return true;
      }
      // A directory: its immediate children, with real tree ids for subdirectories.
      const prefix = clean === '' ? '' : `${clean}/`;
      const children = new Map<string, Json>();
      for (const [filePath, entry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const first = restPath.split('/')[0];
        if (children.has(first)) continue;
        const isDir = restPath.includes('/');
        const childPath = clean === '' ? first : `${clean}/${first}`;
        children.set(first, {
          type: isDir ? 'dir' : 'file',
          name: first,
          path: childPath,
          sha: isDir ? (subtreeOid(repo, tip, childPath) ?? '') : entry.oid,
        });
      }
      if (children.size === 0) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, [...children.values()]);
      return true;
    }
    if (method === 'PUT') {
      if (typeof jsonBody.content !== 'string') {
        sendError(res, 422, 'content is required');
        return true;
      }
      const message = typeof jsonBody.message === 'string' ? jsonBody.message : '';
      const branch = typeof jsonBody.branch === 'string' && jsonBody.branch !== '' ? jsonBody.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      let isUpdate = false;
      let currentSha: string | undefined;
      if (tip !== undefined) {
        const existing = filesOfCommit(repo, tip)?.get(clean);
        if (existing !== undefined) {
          isUpdate = true;
          currentSha = existing.oid;
        }
      }
      if (typeof jsonBody.sha === 'string' && jsonBody.sha !== '') {
        if (!isUpdate) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (jsonBody.sha !== currentSha) {
          sendError(res, 409, 'sha does not match the current blob sha');
          return true;
        }
      }
      const result = writePath(store, repo, branch, clean, Buffer.from(jsonBody.content, 'base64'), message);
      if (result === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, isUpdate ? 200 : 201, {
        content: { sha: result.blobOid, encoding: 'base64', name: basename(clean), path: clean },
        commit: { sha: result.commitOid, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const message = typeof jsonBody.message === 'string' ? jsonBody.message : '';
      const branch = typeof jsonBody.branch === 'string' && jsonBody.branch !== '' ? jsonBody.branch : repo.defaultBranch;
      const result = deletePath(store, repo, branch, clean, message);
      if (result === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, { commit: { sha: result.commitOid } });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{repo}/labels
  if (sub === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      send(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
      return true;
    }
    if (method === 'POST') {
      const name = jsonBody.name;
      if (typeof name !== 'string' || name.trim() === '') {
        sendError(res, 422, 'Label name is required');
        return true;
      }
      const color = typeof jsonBody.color === 'string' && jsonBody.color !== '' ? jsonBody.color : 'ededed';
      const description = typeof jsonBody.description === 'string' ? jsonBody.description : '';
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        existing.color = color;
        if (typeof jsonBody.description === 'string') existing.description = description;
        send(res, 201, labelJson(existing));
        return true;
      }
      const label: LabelRec = { name, color, description };
      repo.labels.set(name, label);
      send(res, 201, labelJson(label));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{repo}/issues...
  if (sub === 'issues') {
    // GET/POST /issues
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let items = store.listItems(repo);
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        // 'all' (or anything else) keeps every item.
        items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        sendPage(res, req, pathname, query, items.map((item) => issueJson(repo, item)));
        return true;
      }
      if (method === 'POST') {
        const title = jsonBody.title;
        if (typeof title !== 'string' || title === '') {
          sendError(res, 422, 'title is required');
          return true;
        }
        const labels = Array.isArray(jsonBody.labels) ? jsonBody.labels.filter((label): label is string => typeof label === 'string') : [];
        const result = store.createIssue(repo, title, typeof jsonBody.body === 'string' ? jsonBody.body : '', labels);
        if ('labelError' in result) {
          sendError(res, 422, `Label ${result.labelError} does not exist`);
          return true;
        }
        send(res, 201, issueJson(repo, result));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    // /issues/{number} and /issues/{number}/comments
    const number = Number(tail[1]);
    if (!/^\d+$/.test(tail[1] ?? '') || !Number.isSafeInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const item = store.getItem(repo, number);
    if (tail.length === 2) {
      if (item === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        send(res, 200, issueJson(repo, item));
        return true;
      }
      if (method === 'PATCH') {
        if (jsonBody.state === 'open' || jsonBody.state === 'closed') item.state = jsonBody.state;
        if (typeof jsonBody.title === 'string') item.title = jsonBody.title;
        if (typeof jsonBody.body === 'string') item.body = jsonBody.body;
        send(res, 200, issueJson(repo, item));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (item === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        send(res, 200, item.comments.map((comment) => commentJson(comment)));
        return true;
      }
      if (method === 'POST') {
        if (typeof jsonBody.body !== 'string' || jsonBody.body === '') {
          sendError(res, 422, 'body is required');
          return true;
        }
        const comment = store.addComment(repo, item, jsonBody.body);
        send(res, 201, commentJson(comment));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{repo}/pulls...
  if (sub === 'pulls') {
    // GET/POST /pulls
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let items = store.listItems(repo).filter((item) => item.kind === 'pull');
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        items = [...items].sort((a, b) => b.seq - a.seq);
        sendPage(res, req, pathname, query, items.map((item) => pullJson(repo, item)));
        return true;
      }
      if (method === 'POST') {
        const title = jsonBody.title;
        if (typeof title !== 'string' || title === '') {
          sendError(res, 422, 'title is required');
          return true;
        }
        const head = jsonBody.head;
        const base = jsonBody.base;
        if (typeof head !== 'string' || head === '' || typeof base !== 'string' || base === '') {
          sendError(res, 422, 'head and base branches are required');
          return true;
        }
        const result = store.createPull(repo, title, typeof jsonBody.body === 'string' ? jsonBody.body : '', head, base);
        if ('error' in result) {
          sendError(res, 422, result.error);
          return true;
        }
        send(res, 201, pullJson(repo, result));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    // /pulls/{number}, /pulls/{number}/files, /pulls/{number}/merge
    const number = Number(tail[1]);
    if (!/^\d+$/.test(tail[1] ?? '') || !Number.isSafeInteger(number) || number < 1) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const item = store.getItem(repo, number);
    const pull = item !== undefined && item.kind === 'pull' ? item : undefined;
    if (tail.length === 2) {
      if (pull === undefined || method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, pullJson(repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (pull === undefined || method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, prFiles(repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method !== 'PUT') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (pull.state !== 'open' || pull.merged) {
        sendError(res, 405, 'Pull request is already closed');
        return true;
      }
      // Judge mergeability against the base branch's live tip, not the tip recorded when the
      // pull request was opened: another merge may have moved the base since then, and that
      // is exactly what turns a mergeable pull request into a conflicting one.
      const liveBaseTip = pull.baseRef !== null ? repo.refs.get(`refs/heads/${pull.baseRef}`) : undefined;
      const livePull: ItemRec = liveBaseTip !== undefined ? { ...pull, baseSha: liveBaseTip } : pull;
      if (mergeable(repo, livePull) === 'CONFLICTING') {
        sendError(res, 405, 'Merge conflict');
        return true;
      }
      const result = squashMerge(store, repo, pull);
      if (result === null) {
        sendError(res, 422, 'Unable to merge pull request');
        return true;
      }
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.timestampFor(store.nextSeq());
      pull.mergeCommitSha = result.sha;
      send(res, 200, {
        sha: result.sha,
        merged: true,
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}
