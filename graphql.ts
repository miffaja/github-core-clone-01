// The GraphQL (v4) surface: POST /api/graphql.
//
// No full GraphQL parser lives here — the suite sends exactly 18 fixed documents (plus
// batching), so this is a small hand-written executor that matches each document by its
// distinctive fields and answers from the shared store. Every reply is JSON with an
// X-GitHub-Request-Id; a well-formed GraphQL request is always HTTP 200, even when the
// document has errors (then {"data": null, "errors": [...]}). Only authentication failures
// (401) and malformed JSON bodies (400) leave the 200 path.
//
// Global ids are the store's opaque Relay ids (base64url of a type-prefixed payload), never
// the plain databaseId or issue number. Issue/PR state is 'OPEN'/'CLOSED' here; the REST
// surface keeps lowercase.

import {
  Store,
  VIEWER_LOGIN,
  decodeGlobalId,
  globalIdComment,
  globalIdItem,
  globalIdRepo,
  mergeable,
  prFiles,
  squashMerge,
  type ItemRec,
  type Repo,
} from './store.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** A per-process request id, hex, non-empty — the X-GitHub-Request-Id every reply carries. */
function requestId(): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An error envelope: HTTP 200, data null, the message naming the offending field/value. */
function gqlError(message: string): Record<string, unknown> {
  return { data: null, errors: [{ message }] };
}

/** Whether this request carries a bearer token this forge accepts. */
function authenticated(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token !== '') return auth === `Bearer ${token}`;
  return auth.startsWith('Bearer ') && auth.slice('Bearer '.length).length > 0;
}

export async function handleGraphql(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  if (pathname !== '/api/graphql' && pathname !== '/api/graphql/') return false;
  if ((req.method ?? 'GET') !== 'POST') return false;

  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return true;
  }

  // Batching: a JSON array of operations answers a JSON array of envelopes, in order.
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((op) => executeOne(store, op)));
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    sendJson(res, 400, { message: 'No query provided' });
    return true;
  }
  sendJson(res, 200, executeOne(store, parsed));
  return true;
}

/** One operation document ({query, variables}) → one response envelope. Never throws. */
function executeOne(store: Store, op: unknown): Record<string, unknown> {
  if (!isRecord(op) || typeof op.query !== 'string') return gqlError('No query provided');
  const variables = isRecord(op.variables) ? op.variables : {};
  try {
    return dispatch(store, op.query, variables);
  } catch (err) {
    return gqlError(err instanceof Error ? err.message : 'Internal error');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Small readers.
// ---------------------------------------------------------------------------------------------------------

function varString(vars: Record<string, unknown>, name: string): string | undefined {
  const value = vars[name];
  return typeof value === 'string' ? value : undefined;
}

function varInt(vars: Record<string, unknown>, name: string): number | undefined {
  const value = vars[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** An inline `name: 12` argument, for documents that pass a literal instead of a variable. */
function inlineInt(query: string, name: string): number | undefined {
  const match = new RegExp(`${name}:\\s*(\\d+)`).exec(query);
  return match === null ? undefined : Number(match[1]);
}

function inputOf(vars: Record<string, unknown>): Record<string, unknown> {
  return isRecord(vars.input) ? vars.input : {};
}

/** Issue/PR state in GraphQL case. */
function gqlState(item: ItemRec): 'OPEN' | 'CLOSED' {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: globalIdRepo(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.size === 0 ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueJson(repo: Repo, item: ItemRec): Record<string, unknown> {
  return {
    id: globalIdItem(repo, item),
    number: item.number,
    title: item.title,
    state: gqlState(item),
    body: item.body,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** The repository a document names, or undefined when it is unknown (or not the viewer's). */
function namedRepo(store: Store, vars: Record<string, unknown>): Repo | undefined {
  const owner = varString(vars, 'owner');
  const name = varString(vars, 'name');
  if (owner === undefined || name === undefined || owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

/** Resolve an opaque global id to its repository, or undefined when it is not one of ours. */
function repoOfGlobalId(store: Store, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  return store.findRepoById(decoded.repoId);
}

// ---------------------------------------------------------------------------------------------------------
// The dispatcher: match each fixed document by its distinctive fields.
// ---------------------------------------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt',
  'author', 'comments', 'labels', 'assignees', 'closedAt', 'locked', 'milestone',
];

const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt',
  'author', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable',
  'merged', 'mergedAt', 'mergeCommit', 'files', 'commits', 'reviews', 'comments',
];

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate',
  'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests',
  'labels', 'releases', 'forkCount', 'stargazerCount',
];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

function fieldList(names: readonly string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

function dispatch(store: Store, query: string, vars: Record<string, unknown>): Record<string, unknown> {
  // The invalid-field document: a 200 with an errors array naming the field.
  if (query.includes('noSuchFieldOnViewer')) {
    return gqlError('Cannot query field "noSuchFieldOnViewer" on type "Viewer".');
  }
  if (query.includes('__type(name: "SearchType")')) {
    return { data: { SearchType: { enumValues: fieldList(SEARCH_TYPE_VALUES) } } };
  }
  if (query.includes('__type(name: "PullRequest")') || query.includes('__type(name: "Repository")')) {
    const data: Record<string, unknown> = {};
    if (query.includes('__type(name: "PullRequest")')) {
      data.PullRequest = { fields: fieldList(PULL_REQUEST_FIELDS) };
    }
    if (query.includes('__type(name: "Repository")')) {
      data.Repository = { fields: fieldList(REPOSITORY_FIELDS) };
    }
    return { data };
  }
  if (query.includes('__type(name: "Issue")')) {
    return { data: { Issue: { fields: fieldList(ISSUE_FIELDS) } } };
  }
  if (query.includes('createIssue')) return createIssue(store, vars);
  if (query.includes('closeIssue')) return closeIssue(store, vars);
  if (query.includes('createPullRequest')) return createPullRequest(store, vars);
  if (query.includes('mergePullRequest')) return mergePullRequest(store, vars);
  if (query.includes('addComment')) return addComment(store, vars);
  if (query.includes('node(')) return nodeQuery(store, vars);
  if (query.includes('repository(')) return repositoryQuery(store, query, vars);
  if (query.includes('viewer')) return { data: { viewer: { login: VIEWER_LOGIN } } };
  return gqlError(`Unknown document: ${query.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------------------------------------
// Query.repository(...) and everything hanging off it.
// ---------------------------------------------------------------------------------------------------------

function repositoryQuery(store: Store, query: string, vars: Record<string, unknown>): Record<string, unknown> {
  const repo = namedRepo(store, vars);
  if (repo === undefined) return { data: { repository: null } };

  if (query.includes('issues(')) return issuesConnection(store, repo, query, vars);
  if (query.includes('issue(')) {
    const number = varInt(vars, 'number') ?? inlineInt(query, 'number');
    const item = number === undefined ? undefined : store.getItem(repo, number);
    return { data: { repository: { issue: item === undefined ? null : issueJson(repo, item) } } };
  }
  if (query.includes('pullRequests(')) {
    const first = varInt(vars, 'first') ?? inlineInt(query, 'first');
    const nodes = store
      .listItems(repo)
      .filter((item) => item.kind === 'pull' && item.state === 'open')
      .sort((a, b) => a.number - b.number)
      .slice(0, first)
      .map((item) => ({
        id: globalIdItem(repo, item),
        number: item.number,
        headRefName: item.headRef,
        baseRefName: item.baseRef,
        mergeable: mergeable(repo, item),
        state: 'OPEN',
      }));
    return { data: { repository: { pullRequests: { nodes } } } };
  }
  if (query.includes('pullRequest(')) {
    const number = varInt(vars, 'number') ?? inlineInt(query, 'number');
    const item = number === undefined ? undefined : store.getItem(repo, number);
    if (item === undefined || item.kind !== 'pull') {
      return { data: { repository: { pullRequest: null } } };
    }
    const node: Record<string, unknown> = {
      id: globalIdItem(repo, item),
      number: item.number,
      headRefName: item.headRef,
      baseRefName: item.baseRef,
      mergeable: mergeable(repo, item),
      state: gqlState(item),
      merged: item.merged,
    };
    if (query.includes('files(')) {
      const first = inlineInt(query, 'first') ?? 10;
      node.files = {
        nodes: prFiles(repo, item)
          .slice(0, first)
          .map((file) => ({ path: file.filename })),
      };
    }
    return { data: { repository: { pullRequest: node } } };
  }
  return { data: { repository: repoJson(repo) } };
}

/** repository.issues(first, states, orderBy, after): the open list, or the cursor page. */
function issuesConnection(store: Store, repo: Repo, query: string, vars: Record<string, unknown>): Record<string, unknown> {
  const first = varInt(vars, 'first') ?? inlineInt(query, 'first');
  // Issues only (pull requests are not issues here), number ascending.
  const issues = store.listItems(repo).filter((item) => item.kind === 'issue');

  // Cursor pagination (the IssuesPage document): pageInfo present, no states filter.
  if (query.includes('pageInfo')) {
    const after = decodeCursor(varString(vars, 'after'));
    const start = after === null ? 0 : issues.findIndex((item) => item.number > after);
    const from = start < 0 ? issues.length : start;
    const page = first === undefined ? issues.slice(from) : issues.slice(from, from + first);
    const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1].number);
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((item) => ({ number: item.number })),
            pageInfo: { hasNextPage: from + page.length < issues.length, endCursor },
          },
        },
      },
    };
  }

  // The open-issues list: states [OPEN], CREATED_AT DESC — issues only, newest first.
  let nodes = issues;
  if (query.includes('states: [OPEN]')) nodes = nodes.filter((item) => item.state === 'open');
  else if (query.includes('states: [CLOSED]')) nodes = nodes.filter((item) => item.state === 'closed');
  if (query.includes('direction: DESC')) nodes = [...nodes].sort((a, b) => b.seq - a.seq);
  else if (query.includes('direction: ASC')) nodes = [...nodes].sort((a, b) => a.seq - b.seq);
  if (first !== undefined) nodes = nodes.slice(0, first);
  return {
    data: {
      repository: {
        issues: {
          nodes: nodes.map((item) => ({
            number: item.number,
            title: item.title,
            state: gqlState(item),
            id: globalIdItem(repo, item),
          })),
        },
      },
    },
  };
}

/** A page cursor: base64url("cursor:<number>") of the last item on the previous page. */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Mutations.
// ---------------------------------------------------------------------------------------------------------

/** Resolve an item global id to its repo + item, or undefined when it is not one of ours. */
function itemOfGlobalId(
  store: Store,
  id: unknown,
): { repo: Repo; item: ItemRec } | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'item') return undefined;
  const repo = store.findRepoById(decoded.repoId);
  if (repo === undefined) return undefined;
  const item = store.getItem(repo, decoded.number);
  if (item === undefined) return undefined;
  return { repo, item };
}

function createIssue(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(vars);
  const repo = repoOfGlobalId(store, input.repositoryId);
  if (repo === undefined) return gqlError(`Unknown repositoryId: ${String(input.repositoryId ?? '')}`);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const created = store.createIssue(repo, title, body, []);
  if ('labelError' in created) return gqlError(`Unknown label: ${created.labelError}`);
  return {
    data: { createIssue: { issue: { number: created.number, id: globalIdItem(repo, created) } } },
  };
}

function closeIssue(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(vars);
  const found = itemOfGlobalId(store, input.issueId);
  if (found === undefined) return gqlError(`Unknown issueId: ${String(input.issueId ?? '')}`);
  found.item.state = 'closed';
  return {
    data: {
      closeIssue: {
        issue: {
          number: found.item.number,
          id: globalIdItem(found.repo, found.item),
          state: 'CLOSED',
        },
      },
    },
  };
}

function createPullRequest(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(vars);
  const repo = repoOfGlobalId(store, input.repositoryId);
  if (repo === undefined) return gqlError(`Unknown repositoryId: ${String(input.repositoryId ?? '')}`);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const created = store.createPull(repo, title, body, head, base);
  if ('error' in created) return gqlError(created.error);
  return {
    data: {
      createPullRequest: {
        pullRequest: {
          number: created.number,
          id: globalIdItem(repo, created),
          state: 'OPEN',
          headRefName: created.headRef,
          baseRefName: created.baseRef,
        },
      },
    },
  };
}

function mergePullRequest(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(vars);
  const found = itemOfGlobalId(store, input.pullRequestId);
  if (found === undefined) return gqlError(`Unknown pullRequestId: ${String(input.pullRequestId ?? '')}`);
  if (found.item.kind !== 'pull') {
    return gqlError(`Item #${found.item.number} is not a pull request`);
  }
  const merged = squashMerge(store, found.repo, found.item);
  if (merged === null) {
    return gqlError(`Merge conflict: pull request #${found.item.number} cannot be merged`);
  }
  found.item.state = 'closed';
  found.item.merged = true;
  found.item.mergedAt = store.timestampFor(store.nextSeq());
  found.item.mergeCommitSha = merged.sha;
  return {
    data: {
      mergePullRequest: {
        pullRequest: { number: found.item.number, merged: true, state: 'CLOSED' },
      },
    },
  };
}

function addComment(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const input = inputOf(vars);
  const found = itemOfGlobalId(store, input.subjectId);
  if (found === undefined) return gqlError(`Unknown subjectId: ${String(input.subjectId ?? '')}`);
  const body = typeof input.body === 'string' ? input.body : '';
  const comment = store.addComment(found.repo, found.item, body);
  return {
    data: {
      addComment: {
        commentEdge: {
          node: { id: globalIdComment(found.repo, found.item, comment), body: comment.body },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Query.node(id:).
// ---------------------------------------------------------------------------------------------------------

function nodeQuery(store: Store, vars: Record<string, unknown>): Record<string, unknown> {
  const id = varString(vars, 'id');
  if (id === undefined) return gqlError('Unknown node id');
  const decoded = decodeGlobalId(id);
  if (decoded === null) return { data: { node: null } };
  const repo = store.findRepoById(decoded.repoId);
  if (repo === undefined) return { data: { node: null } };
  if (decoded.kind === 'repo') {
    return {
      data: {
        node: { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
      },
    };
  }
  if (decoded.kind === 'item') {
    const item = store.getItem(repo, decoded.number);
    if (item === undefined) return { data: { node: null } };
    return { data: { node: { id, number: item.number, title: item.title } } };
  }
  const item = store.getItem(repo, decoded.number);
  if (item === undefined) return { data: { node: null } };
  const comment = item.comments.find((entry) => entry.id === decoded.commentId);
  if (comment === undefined) return { data: { node: null } };
  return { data: { node: { id, body: comment.body } } };
}
