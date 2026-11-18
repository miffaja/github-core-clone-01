// The forge's store: every repository, git object, ref, issue, label and pull request lives here,
// in memory, in one process. No disk I/O on any request path — the benchmark workloads are timed,
// and the trial replays the same request order, so every timestamp and commit the store mints is
// deterministic (a fixed epoch plus a counter), never the wall clock and never Math.random.
//
// The viewer login is the scenario's fixed viewer. The suite's scenario is generated from the one
// constant SCENARIO_SEED published in the kit (wire.ts), so the viewer is the same in every trial:
// login "adaiversen", id 1000. The bearer token names that login: a request is authenticated when
// its Authorization header carries exactly MAKEFUN_SHOP_TOKEN from this process's environment.

import { createHash } from 'node:crypto';

/** The login the bearer token names; every repository the suite creates belongs to it. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric user id (the scenario's fixed viewer id). */
export const VIEWER_ID = 1000;
/** The viewer's display name and email, used as the identity on commits this forge mints. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The all-zero object id: an unborn ref, a branch create's old value, a delete's new value. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The day-one epoch the deterministic clocks start from (2025-01-01T00:00:00Z). */
export const EPOCH_SEC = 1735689600;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One git object: its type and its exact bytes (stored as received, so round-trips are byte-exact). */
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** One entry of a tree object: mode as git writes it, name, and the object id it points at. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** A parsed commit object. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** One comment on an issue or a pull request. */
export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

/**
 * One issue or pull request. GitHub numbers issues and pull requests in one sequence per
 * repository, and a pull request IS the issue with its number (its comments live here too), so
 * both kinds share this record; the pull-request fields stay null for a plain issue.
 */
export interface ItemRec {
  id: number;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic creation order; createdAt is derived from it, so sorting by it is total. */
  seq: number;
  comments: CommentRec[];
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  nextCommentId: number;
  nextItemId: number;
}

/** The SHA-1 object id of `<type> <length>\0<data>`, exactly as git computes it. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and answer its id; storing the same bytes twice is a no-op. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/**
 * Parse a tree object's bytes into entries. A tree is a run of `<mode> <name>\0<20-byte oid>`
 * records, already sorted by git's rules; the bytes are trusted (they came from a pack the client
 * built or from buildTree below), so a malformed record ends the parse rather than throwing.
 */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries the way git does: sorted by name with directories ordered as if suffixed by '/'. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's bytes (headers, a blank line, then the message). */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Serialise a commit the way git does, with the identity lines in `Name <email> <epoch> +0000` form. */
export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  epochSec: number,
  author?: string,
  committer?: string,
): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author ?? who}`);
  lines.push(`committer ${committer ?? who}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** An opaque, stable Relay-style global id: base64url of a type-prefixed payload, never the bare number. */
export function globalIdRepo(repo: Repo): string {
  return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64url');
}

export function globalIdItem(repo: Repo, item: ItemRec): string {
  return Buffer.from(`I:${repo.id}:${item.number}`, 'utf8').toString('base64url');
}

export function globalIdComment(repo: Repo, item: ItemRec, comment: CommentRec): string {
  return Buffer.from(`C:${repo.id}:${item.number}:${comment.id}`, 'utf8').toString('base64url');
}

export type DecodedId =
  | { kind: 'repo'; repoId: number }
  | { kind: 'item'; repoId: number; number: number }
  | { kind: 'comment'; repoId: number; number: number; commentId: number }
  | null;

/** Decode a global id this forge minted; anything else is not one of ours. */
export function decodeGlobalId(id: string): DecodedId {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const repoId = Number(parts[1]);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
  if (parts[0] === 'R' && parts.length === 2) return { kind: 'repo', repoId };
  if (parts[0] === 'I' && parts.length === 3) {
    const number = Number(parts[2]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { kind: 'item', repoId, number };
  }
  if (parts[0] === 'C' && parts.length === 4) {
    const number = Number(parts[2]);
    const commentId = Number(parts[3]);
    if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(commentId) || commentId <= 0) return null;
    return { kind: 'comment', repoId, number, commentId };
  }
  return null;
}

/**
 * The store itself: repositories keyed by `owner/name`, a global creation sequence, and the
 * deterministic clocks. Every created_at/updated_at is the fixed epoch plus the object's sequence
 * number in seconds, so a replay of the same requests mints the same timestamps, and sorting by
 * created date is the same as sorting by creation order.
 */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;
  private commitSeq = 0;
  private nextItemIdGlobal = 1;

  /** The next value of the global creation sequence. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A deterministic ISO timestamp for the given sequence number. */
  timestampFor(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** A deterministic epoch second for a commit this forge mints. */
  nextCommitEpoch(): number {
    this.commitSeq += 1;
    return EPOCH_SEC + this.commitSeq;
  }

  nextItemId(): number {
    const id = this.nextItemIdGlobal;
    this.nextItemIdGlobal += 1;
    return id;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** Every repository owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * Create a repository. Returns null when a repository of that name already exists under the
   * owner (the caller answers 422). A fresh repository has the six labels GitHub seeds, no refs
   * (it is unborn until the first commit), and no issues.
   */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(Store.repoKey(owner, name))) return null;
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: this.timestampFor(seq),
      updatedAt: this.timestampFor(seq),
      seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextItemId: 1,
    };
    this.nextRepoId += 1;
    for (const [labelName, color] of [
      ['bug', 'd73a4a'],
      ['enhancement', 'a2eeef'],
      ['documentation', '0075ca'],
      ['question', 'd876e3'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
    ] as const) {
      repo.labels.set(labelName, { name: labelName, color, description: '' });
    }
    this.repos.set(Store.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  /** Create an issue; `labelError` names a label that does not exist on the repository. */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): ItemRec | { labelError: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { labelError: label };
    }
    const seq = this.nextSeq();
    const item: ItemRec = {
      id: this.nextItemId(),
      number: repo.nextNumber,
      kind: 'issue',
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER_LOGIN,
      createdAt: this.timestampFor(seq),
      updatedAt: this.timestampFor(seq),
      seq,
      comments: [],
      headRef: null,
      headSha: null,
      baseRef: null,
      baseSha: null,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.nextNumber += 1;
    repo.items.set(item.number, item);
    return item;
  }

  /**
   * Create a pull request. `head` and `base` are branch names; both refs must exist, and an open
   * pull request from the same head branch must not already exist (the caller answers 422 then).
   */
  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): ItemRec | { error: string } {
    const headOid = repo.refs.get(`refs/heads/${head}`);
    if (headOid === undefined) return { error: `head branch ${head} does not exist` };
    const baseOid = repo.refs.get(`refs/heads/${base}`);
    if (baseOid === undefined) return { error: `base branch ${base} does not exist` };
    for (const item of repo.items.values()) {
      if (item.kind === 'pull' && item.state === 'open' && item.headRef === head) {
        return { error: `an open pull request already exists from ${head}` };
      }
    }
    const seq = this.nextSeq();
    const item: ItemRec = {
      id: this.nextItemId(),
      number: repo.nextNumber,
      kind: 'pull',
      title,
      body,
      state: 'open',
      labels: [],
      userLogin: VIEWER_LOGIN,
      createdAt: this.timestampFor(seq),
      updatedAt: this.timestampFor(seq),
      seq,
      comments: [],
      headRef: head,
      headSha: headOid,
      baseRef: base,
      baseSha: baseOid,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.nextNumber += 1;
    repo.items.set(item.number, item);
    return item;
  }

  getItem(repo: Repo, number: number): ItemRec | undefined {
    return repo.items.get(number);
  }

  /** Every issue and pull request in the repository, in creation (number) order. */
  listItems(repo: Repo): ItemRec[] {
    return [...repo.items.values()].sort((a, b) => a.number - b.number);
  }

  addComment(repo: Repo, item: ItemRec, body: string): CommentRec {
    const comment: CommentRec = {
      id: repo.nextCommentId,
      body,
      userLogin: VIEWER_LOGIN,
      createdAt: this.timestampFor(this.nextSeq()),
    };
    repo.nextCommentId += 1;
    item.comments.push(comment);
    return comment;
  }
}

/**
 * Flatten a commit's tree into a map from full path to {mode, oid}, walking subtrees. A path
 * component that is a blob where a directory is needed (or vice versa) ends the walk for that
 * branch — the data comes from packs the client built, so it is well-formed in practice.
 */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry);
  }
  return out;
}

/** The flattened file map of the commit `oid` points at, or null when the commit is unknown. */
export function filesOfCommit(repo: Repo, commitOid: string): Map<string, TreeEntry> | null {
  const obj = getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  return flattenTree(repo, info.tree);
}

export type ReadPathResult =
  | { kind: 'file'; oid: string; data: Buffer }
  | { kind: 'dir'; entries: { name: string; path: string; type: 'file' | 'dir'; oid: string }[] }
  | null;

/**
 * Read a path at a ref (a branch name, or a full ref). A file answers its blob; a directory
 * answers its immediate children; anything else is null. `ref` may also be a raw commit id.
 */
export function readPath(repo: Repo, ref: string, path: string): ReadPathResult {
  const oid = ref.startsWith('refs/') ? repo.refs.get(ref) : repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (oid === undefined) return null;
  const files = filesOfCommit(repo, oid);
  if (files === null) return null;
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') {
    // The root directory: the top-level entries.
    const top = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
    for (const [filePath, entry] of files) {
      const first = filePath.split('/')[0];
      if (!top.has(first)) {
        const isDir = filePath.includes('/');
        top.set(first, { name: first, path: first, type: isDir ? 'dir' : 'file', oid: isDir ? '' : entry.oid });
      }
    }
    // Directory entries need a tree id: resolve them from the commit's tree.
    const commit = parseCommit(getObject(repo, oid)!.data);
    for (const entry of parseTree(getObject(repo, commit.tree)!.data)) {
      if (entry.mode === '40000' && top.has(entry.name)) top.get(entry.name)!.oid = entry.oid;
    }
    return { kind: 'dir', entries: [...top.values()] };
  }
  const direct = files.get(clean);
  if (direct !== undefined) {
    const blob = getObject(repo, direct.oid);
    if (blob === undefined || blob.type !== 'blob') return null;
    return { kind: 'file', oid: direct.oid, data: blob.data };
  }
  // A directory: every file under `clean/` contributes its first component.
  const prefix = `${clean}/`;
  const children = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0];
    if (!children.has(first)) {
      children.set(first, {
        name: first,
        path: `${clean}/${first}`,
        type: rest.includes('/') ? 'dir' : 'file',
        oid: rest.includes('/') ? '' : entry.oid,
      });
    }
  }
  if (children.size === 0) return null;
  return { kind: 'dir', entries: [...children.values()] };
}

/**
 * Rebuild a tree from a flattened file map, creating the intermediate trees. Returns the new
 * root tree's id. The map's entries are the files; directories are implied by the paths.
 */
export function buildTreeFromFiles(repo: Repo, files: Map<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return writeNode(root);
}

/**
 * Write (create or replace) a file at `path` on branch `ref`, minting one commit whose parent is
 * the branch tip (or no parent when the repository is unborn). Returns the new commit and blob
 * ids, or null when the branch does not exist and the repository is not unborn.
 */
export function writePath(
  store: Store,
  repo: Repo,
  ref: string,
  path: string,
  content: Buffer,
  message: string,
): { commitOid: string; blobOid: string } | null {
  const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const tip = repo.refs.get(refName);
  const files = tip === undefined ? new Map<string, TreeEntry>() : filesOfCommit(repo, tip) ?? new Map<string, TreeEntry>();
  if (tip === undefined && repo.refs.size > 0 && !repo.refs.has(refName)) return null;
  const clean = path.replace(/^\/+/, '');
  const blobOid = putObject(repo, 'blob', content);
  files.set(clean, { mode: '100644', name: clean.split('/').pop()!, oid: blobOid });
  const treeOid = buildTreeFromFiles(repo, files);
  const commitOid = putObject(
    repo,
    'commit',
    buildCommit(treeOid, tip === undefined ? [] : [tip], message, store.nextCommitEpoch()),
  );
  repo.refs.set(refName, commitOid);
  return { commitOid, blobOid };
}

/** Delete the file at `path` on branch `ref`, minting one commit; null when it is not there. */
export function deletePath(
  store: Store,
  repo: Repo,
  ref: string,
  path: string,
  message: string,
): { commitOid: string } | null {
  const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const files = filesOfCommit(repo, tip);
  if (files === null) return null;
  const clean = path.replace(/^\/+/, '');
  if (!files.has(clean)) return null;
  files.delete(clean);
  const treeOid = buildTreeFromFiles(repo, files);
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, [tip], message, store.nextCommitEpoch()));
  repo.refs.set(refName, commitOid);
  return { commitOid };
}

/**
 * The merge base of two commits: the nearest common ancestor, found by walking both histories
 * breadth-first from the tips. Histories here are short (the suite's fixtures are a handful of
 * commits), so a simple two-sided walk is fast enough.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const seenA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (seenA.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
  }
  return null;
}

/** Is `ancestor` reachable from `descendant` (a fast-forward)? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const queue = [descendant];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * The three-way merge of a pull request: files changed on the head side since the merge base,
 * and files changed on the base side since the merge base. A file changed on both sides to
 * different contents is a conflict. Otherwise the merged file map takes the head's version where
 * the head changed it, the base tip's where only the base changed it, and the base version elsewhere.
 */
export function threeWayMerge(
  repo: Repo,
  pr: ItemRec,
): { conflict: boolean; files: Map<string, TreeEntry> | null; baseOid: string | null } {
  if (pr.headSha === null || pr.baseSha === null) return { conflict: false, files: null, baseOid: null };
  const headFiles = filesOfCommit(repo, pr.headSha);
  const baseTipFiles = filesOfCommit(repo, pr.baseSha);
  if (headFiles === null || baseTipFiles === null) return { conflict: false, files: null, baseOid: null };
  const base = mergeBase(repo, pr.headSha, pr.baseSha);
  const baseFiles = base === null ? new Map<string, TreeEntry>() : filesOfCommit(repo, base) ?? new Map<string, TreeEntry>();
  const merged = new Map<string, TreeEntry>(baseTipFiles);
  let conflict = false;
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
  for (const path of allPaths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inTip = baseTipFiles.get(path);
    const headChanged = (inHead?.oid ?? null) !== (inBase?.oid ?? null);
    const tipChanged = (inTip?.oid ?? null) !== (inBase?.oid ?? null);
    if (headChanged && tipChanged && (inHead?.oid ?? null) !== (inTip?.oid ?? null)) {
      conflict = true;
      continue;
    }
    if (headChanged) {
      if (inHead === undefined) merged.delete(path);
      else merged.set(path, inHead);
    }
  }
  return { conflict, files: merged, baseOid: base };
}

/** Whether a pull request can merge: UNKNOWN when a side is missing, else the three-way verdict. */
export function mergeable(repo: Repo, pr: ItemRec): Mergeable {
  if (pr.headSha === null || pr.baseSha === null) return 'UNKNOWN';
  if (getObject(repo, pr.headSha) === undefined || getObject(repo, pr.baseSha) === undefined) return 'UNKNOWN';
  return threeWayMerge(repo, pr).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request onto its base branch: one commit on the base branch whose tree is
 * the three-way merge and whose parent is the base tip. Returns the new commit id, or null when
 * the merge conflicts or a side is missing. The caller marks the pull request merged.
 */
export function squashMerge(store: Store, repo: Repo, pr: ItemRec): { sha: string } | null {
  if (pr.headRef === null || pr.baseRef === null || pr.headSha === null || pr.baseSha === null) return null;
  const baseRefName = `refs/heads/${pr.baseRef}`;
  const baseTip = repo.refs.get(baseRefName);
  if (baseTip === undefined) return null;
  // Re-read the base tip (the branch may have moved since the pull request was opened).
  const live: ItemRec = { ...pr, baseSha: baseTip };
  const { conflict, files } = threeWayMerge(repo, live);
  if (conflict || files === null) return null;
  const treeOid = buildTreeFromFiles(repo, files);
  const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, [baseTip], message, store.nextCommitEpoch()));
  repo.refs.set(baseRefName, commitOid);
  return { sha: commitOid };
}

/** The files a pull request changes, head side versus the merge base, with a line-level count. */
export function prFiles(
  repo: Repo,
  pr: ItemRec,
): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
  if (pr.headSha === null || pr.baseSha === null) return [];
  const headFiles = filesOfCommit(repo, pr.headSha);
  if (headFiles === null) return [];
  const base = mergeBase(repo, pr.headSha, pr.baseSha);
  const baseFiles = base === null ? new Map<string, TreeEntry>() : filesOfCommit(repo, base) ?? new Map<string, TreeEntry>();
  const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
  const countLines = (data: Buffer | undefined): string[] =>
    data === undefined ? [] : data.toString('utf8').split('\n').filter((line) => line.length > 0);
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if ((inBase?.oid ?? null) === (inHead?.oid ?? null)) continue;
    const baseData = inBase === undefined ? undefined : getObject(repo, inBase.oid)?.data;
    const headData = inHead === undefined ? undefined : getObject(repo, inHead.oid)?.data;
    const baseLines = new Set(countLines(baseData));
    const headLines = countLines(headData);
    let additions = 0;
    for (const line of headLines) if (!baseLines.has(line)) additions += 1;
    const headSet = new Set(headLines);
    let deletions = 0;
    for (const line of baseLines) if (!headSet.has(line)) deletions += 1;
    out.push({
      filename: path,
      status: inBase === undefined ? 'added' : inHead === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}
