// The forge's MCP surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, implemented by
// hand on node:http (no MCP SDK here). It speaks both protocol eras the suite accepts:
//
//   modern 2026-07-28: `server/discover` answers identity, capabilities and supported versions
//           in one request; every request declares its revision in `_meta` and mirrors it in
//           the Mcp-Protocol-Version header, which this server echoes back.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`, with an
//           optional Mcp-Session-Id echoed back when the client sends one.
//
// Auth is decided before any tool exists: Authorization: Bearer <MAKEFUN_SHOP_TOKEN> when
// that variable is set and non-empty, else any non-empty Bearer token. No header -> 401.
// Plain JSON answers only (no SSE), one JSON-RPC response per request, the request's `id`
// echoed exactly. The tools act on the same store as REST, so ids are stable across surfaces.
//
// Determinism: the tools list is one constant serialised identically every time; no wall
// clock and no Math.random anywhere in a response (timestamps come from the store).

import { Store, VIEWER_ID, VIEWER_LOGIN, squashMerge } from './store.ts';
import type { Repo, ItemRec } from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** Every revision this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** The handshake-era revisions `initialize` may negotiate, newest first. */
const LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

let requestSeq = 0;

/** A per-process request id, hex, non-empty — the X-GitHub-Request-Id every reply carries. */
function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/**
 * The one tools list, built once and never mutated: serialising the same object twice is
 * byte-identical, which the tools-list-idempotent check requires. Required properties are
 * only ones the suite can fill.
 */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'open, closed, or all. Defaults to open.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch the changes are on.' },
        base: { type: 'string', description: 'The base branch the changes merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

// ---------------------------------------------------------------- shapes

/** A repository in the same shape REST serves it (stable numeric id included). */
function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/** An issue (or pull request) in the same shape REST serves it. */
function issueView(repo: Repo, item: ItemRec): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    user: { login: item.userLogin, type: 'User' },
    labels: [...item.labels],
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
  if (item.kind === 'pull') {
    view.head = { ref: item.headRef, sha: item.headSha, label: `${repo.owner}:${item.headRef}` };
    view.base = { ref: item.baseRef, sha: item.baseSha, label: `${repo.owner}:${item.baseRef}` };
    view.merged = item.merged;
    view.merged_at = item.mergedAt;
    view.merge_commit_sha = item.mergeCommitSha;
  }
  return view;
}

// ---------------------------------------------------------------- argument normalising

/** A name normalised for matching: lowercase, every non-alphanumeric removed. */
function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The synonyms each canonical argument may arrive under (the suite maps its documented
 * names onto the schema's properties by normalised name, so any of these spellings must
 * resolve to the canonical property).
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
  full_name: ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'],
};

/**
 * Read tool arguments through the synonym lookup: for each canonical key the tool takes,
 * every accepted spelling maps to it. A `full_name` property ("owner/repo") fills owner
 * and repo when they were not given directly. First spelling wins on a clash.
 */
function normaliseArgs(args: unknown, canonicalKeys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return out;
  const byNorm = new Map<string, string>();
  for (const key of canonicalKeys) {
    for (const synonym of SYNONYMS[key] ?? [key]) {
      const n = norm(synonym);
      if (!byNorm.has(n)) byNorm.set(n, key);
    }
  }
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const canonical = byNorm.get(norm(key));
    if (canonical !== undefined && !(canonical in out)) out[canonical] = value;
  }
  if ((out.owner === undefined || out.repo === undefined) && canonicalKeys.includes('owner')) {
    const fullName = (args as Record<string, unknown>).full_name ?? (args as Record<string, unknown>).fullName;
    if (typeof fullName === 'string') {
      const [owner, repo] = fullName.split('/', 2);
      if (owner !== undefined && owner !== '' && repo !== undefined && repo !== '') {
        if (out.owner === undefined) out.owner = owner;
        if (out.repo === undefined) out.repo = repo;
      }
    }
  }
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** A branch name out of a branch name or a full ref ("refs/heads/x" -> "x"). */
function branchName(value: string): string {
  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
}

// ---------------------------------------------------------------- tool results

interface ToolOutcome {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function toolOk(value: unknown): ToolOutcome {
  const text = JSON.stringify(value);
  return {
    result: {
      content: [{ type: 'text', text }],
      structuredContent: value,
      isError: false,
    },
  };
}

function toolFail(message: string): ToolOutcome {
  const value = { error: message };
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: true,
    },
  };
}

/** The first missing required argument's name, or null when all are present. */
function missingRequired(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

// ---------------------------------------------------------------- the tools

function callCreateRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['name']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const name = asString(args.name);
  if (name === null) return toolFail('missing required argument: name');
  const description = typeof args.description === 'string' ? args.description : '';
  const isPrivate = args.private === true || args.private === 'true';
  const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  if (repo === null) return toolFail(`repository ${VIEWER_LOGIN}/${name} already exists`);
  return toolOk(repoView(repo));
}

function callGetRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['owner', 'repo']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const owner = asString(args.owner);
  const name = asString(args.repo);
  if (owner === null || name === null) return toolFail('missing required argument: owner or repo');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolFail(`repository ${owner}/${name} not found`);
  return toolOk(repoView(repo));
}

function lookupRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asString(args.owner);
  const name = asString(args.repo);
  if (owner === null || name === null) return null;
  return store.getRepo(owner, name) ?? null;
}

function callCreateIssue(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['owner', 'repo', 'title']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const repo = lookupRepo(store, args);
  if (repo === null) return toolFail('repository not found');
  const title = asString(args.title);
  if (title === null) return toolFail('missing required argument: title');
  const body = typeof args.body === 'string' ? args.body : '';
  const item = store.createIssue(repo, title, body, []);
  if ('labelError' in item) return toolFail(`unknown label: ${item.labelError}`);
  return toolOk(issueView(repo, item));
}

function callListIssues(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['owner', 'repo']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const repo = lookupRepo(store, args);
  if (repo === null) return toolFail('repository not found');
  const state = typeof args.state === 'string' ? args.state : 'open';
  const items = store.listItems(repo).filter((item) => (state === 'all' ? true : item.state === state));
  return toolOk(items.map((item) => issueView(repo, item)));
}

function callCreatePull(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['owner', 'repo', 'title', 'head', 'base']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const repo = lookupRepo(store, args);
  if (repo === null) return toolFail('repository not found');
  const title = asString(args.title);
  const head = asString(args.head);
  const base = asString(args.base);
  if (title === null || head === null || base === null) return toolFail('missing required argument: title, head or base');
  const body = typeof args.body === 'string' ? args.body : '';
  const item = store.createPull(repo, title, body, branchName(head), branchName(base));
  if ('error' in item) return toolFail(item.error);
  return toolOk(issueView(repo, item));
}

function callMergePull(store: Store, args: Record<string, unknown>): ToolOutcome {
  const missing = missingRequired(args, ['owner', 'repo', 'pull_number']);
  if (missing !== null) return toolFail(`missing required argument: ${missing}`);
  const repo = lookupRepo(store, args);
  if (repo === null) return toolFail('repository not found');
  const number = asNumber(args.pull_number);
  if (number === null) return toolFail('missing required argument: pull_number');
  const item = store.getItem(repo, number);
  if (item === undefined || item.kind !== 'pull') return toolFail(`pull request #${number} not found`);
  if (item.merged) {
    return toolOk({ number: item.number, merged: true, state: 'closed', sha: item.mergeCommitSha });
  }
  if (item.state === 'closed') return toolFail(`pull request #${number} is closed`);
  const merged = squashMerge(store, repo, item);
  if (merged === null) return toolFail(`pull request #${number} cannot be merged (conflict or missing branch)`);
  const mergedAt = store.timestampFor(store.nextSeq());
  item.state = 'closed';
  item.merged = true;
  item.mergedAt = mergedAt;
  item.mergeCommitSha = merged.sha;
  item.updatedAt = mergedAt;
  return toolOk({ number: item.number, merged: true, state: 'closed', sha: merged.sha });
}

/** Dispatch one tools/call by (normalised) tool name. */
function callTool(store: Store, name: string, args: unknown): ToolOutcome {
  const wanted = norm(name);
  for (const tool of TOOLS) {
    if (norm(tool.name) !== wanted && !norm(tool.name).endsWith(wanted) && !wanted.endsWith(norm(tool.name))) continue;
    switch (tool.name) {
      case 'create_repo':
        return callCreateRepo(store, normaliseArgs(args, ['name', 'description', 'private']));
      case 'get_repo':
        return callGetRepo(store, normaliseArgs(args, ['owner', 'repo']));
      case 'create_issue':
        return callCreateIssue(store, normaliseArgs(args, ['owner', 'repo', 'title', 'body']));
      case 'list_issues':
        return callListIssues(store, normaliseArgs(args, ['owner', 'repo', 'state']));
      case 'create_pull_request':
        return callCreatePull(store, normaliseArgs(args, ['owner', 'repo', 'title', 'head', 'base', 'body']));
      case 'merge_pull_request':
        return callMergePull(store, normaliseArgs(args, ['owner', 'repo', 'pull_number']));
      default:
        return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
  }
  return { error: { code: -32602, message: `unknown tool: ${name}` } };
}

// ---------------------------------------------------------------- HTTP plumbing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Auth: the exact bearer token when MAKEFUN_SHOP_TOKEN is set, else any non-empty Bearer. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

/** Write one JSON answer, echoing the protocol version and session the client declared. */
function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': nextRequestId(),
  };
  const protocolVersion = req.headers['mcp-protocol-version'];
  if (typeof protocolVersion === 'string' && protocolVersion !== '') headers['mcp-protocol-version'] = protocolVersion;
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string' && sessionId !== '') headers['mcp-session-id'] = sessionId;
  res.writeHead(status, headers);
  res.end(text);
}

/** Write an empty 202 for a notification (no JSON-RPC result is needed). */
function sendEmpty(req: IncomingMessage, res: ServerResponse, status: number): void {
  const headers: Record<string, string> = {
    'content-length': '0',
    'x-github-request-id': nextRequestId(),
  };
  const protocolVersion = req.headers['mcp-protocol-version'];
  if (typeof protocolVersion === 'string' && protocolVersion !== '') headers['mcp-protocol-version'] = protocolVersion;
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string' && sessionId !== '') headers['mcp-session-id'] = sessionId;
  res.writeHead(status, headers);
  res.end();
}

function rpcResult(req: IncomingMessage, res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(req, res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(req: IncomingMessage, res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(req, res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** The revision `initialize` negotiates: the newest supported one from what was offered. */
function negotiateVersion(params: unknown): string {
  const offered = isRecord(params) ? params.protocolVersion : undefined;
  if (typeof offered === 'string') {
    if (SUPPORTED_VERSIONS.includes(offered)) return offered;
    return '2025-11-25';
  }
  if (Array.isArray(offered)) {
    for (const revision of LEGACY_VERSIONS) if (offered.includes(revision)) return revision;
    for (const revision of SUPPORTED_VERSIONS) if (offered.includes(revision)) return revision;
  }
  return '2025-11-25';
}

// ---------------------------------------------------------------- the handler

/**
 * Handle one request at /mcp. Returns true when the request was answered here (including
 * the 401/400 refusals), false when the path is not /mcp or the method is not one this
 * surface serves — app.ts then answers its own 404.
 */
export async function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  void query;
  if (pathname !== '/mcp' && pathname !== '/mcp/') return false;
  const method = req.method ?? 'GET';

  // The client closes a session with DELETE /mcp: best-effort, never a crash.
  if (method === 'DELETE') {
    sendJson(req, res, 200, { jsonrpc: '2.0', id: null, result: {} });
    return true;
  }
  if (method !== 'POST') return false;

  // Auth is decided before any tool exists: an unauthenticated tools/list is a 401.
  if (!authorized(req)) {
    sendJson(req, res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }

  // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
  let message: unknown;
  try {
    message = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(req, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  // A one-element batch is its request; anything else batch-shaped is an invalid request.
  if (Array.isArray(message)) {
    if (message.length === 1) message = message[0];
    else {
      sendJson(req, res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return true;
    }
  }
  if (!isRecord(message) || typeof message.method !== 'string') {
    const id = isRecord(message) && 'id' in message ? message.id : null;
    rpcError(req, res, id, -32600, 'Invalid Request');
    return true;
  }

  // A notification carries no id: answer 202 with an empty body, never a JSON-RPC result.
  if (!('id' in message) || message.id === undefined) {
    sendEmpty(req, res, 202);
    return true;
  }
  const id: unknown = message.id;
  const params: unknown = message.params ?? {};

  switch (message.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      rpcResult(req, res, id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      rpcResult(req, res, id, {
        protocolVersion: negotiateVersion(params),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      rpcResult(req, res, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(req, res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      if (!isRecord(params) || typeof params.name !== 'string' || params.name === '') {
        rpcError(req, res, id, -32602, 'tools/call requires a tool name');
        return true;
      }
      const outcome = callTool(store, params.name, params.arguments ?? {});
      if (outcome.error !== undefined) {
        rpcError(req, res, id, outcome.error.code, outcome.error.message);
        return true;
      }
      rpcResult(req, res, id, outcome.result ?? {});
      return true;
    }
    default: {
      rpcError(req, res, id, -32601, `Method not found: ${message.method}`);
      return true;
    }
  }
}
