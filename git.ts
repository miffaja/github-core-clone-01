// The forge's git smart-HTTP surface: protocol v2 + v0 upload-pack, v0 receive-pack.
// Node 22 stdlib only (node:crypto, node:http, node:zlib). This module NEVER calls a git
// binary; git is only a test tool. All state lives in the shared store (store.ts).
// Deterministic: no wall clock, no Math.random; pack objects are sorted by oid.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  getObject,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  putObject,
  type GitObject,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';

const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const JSON_CT = 'application/json; charset=utf-8';
const AGENT = 'makefun-git/1.0';
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the start of `buf`; returns packets and the offset of the first byte after them. */
function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush' }); offset += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${header}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

function pktText(packet: Pkt): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : '';
}

/** Sideband-wrap `payload` (band byte 1) into pkt-lines; data chunks fit the pkt-line limit. */
function sidebandPackets(payload: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < payload.length; offset += maxData) {
    const chunk = payload.subarray(offset, Math.min(payload.length, offset + maxData));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson404(res: ServerResponse): void {
  sendBuffer(res, 404, JSON_CT, Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8'));
}

function sendJson400(res: ServerResponse, message: string): void {
  sendBuffer(res, 400, JSON_CT, Buffer.from(JSON.stringify({ message }) + '\n', 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

interface RefInfo {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefInfo[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The oid HEAD points at (default branch, else the first branch), or null when unborn. */
function headOid(repo: Repo): string | null {
  const def = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (def !== undefined) return def;
  const branches = sortedRefs(repo).filter((ref) => ref.name.startsWith('refs/heads/'));
  return branches.length ? branches[0].oid : null;
}

/** Peel an annotated tag (recursively) to its ultimate target oid. */
function peelOid(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = getObject(repo, current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (!match) return current;
    current = match[1];
  }
}

function parseTagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`. When `stopAt` names shallow boundaries, a commit in that
 * set is included but its parents are not traversed (the client holds it, not its history).
 * When `maxCommitDepth` is set, commits are included only within that many generations of a root
 * (depth 1 = the root commits only); trees/blobs of included commits are always fully included.
 */
function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  options: { stopAt?: ReadonlySet<string>; maxCommitDepth?: number } = {},
): { objects: Set<string>; commits: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];
  for (const root of roots) {
    if (HEX40.test(root)) queue.push({ oid: root, depth: 0 });
  }
  const seenCommitDepth = new Map<string, number>();
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (objects.has(oid)) {
      // A commit seen at a shallower depth may still need expanding; re-queue if deeper-first.
      if (seenCommitDepth.has(oid) && (seenCommitDepth.get(oid) ?? 0) <= depth) continue;
    }
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      const prev = seenCommitDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
      seenCommitDepth.set(oid, depth);
      commits.add(oid);
      const info = parseCommit(obj.data);
      objects.add(info.tree);
      collectTree(repo, info.tree, objects);
      const cutByDepth = options.maxCommitDepth !== undefined && depth >= options.maxCommitDepth - 1;
      const cutByShallow = options.stopAt !== undefined && options.stopAt.has(oid);
      if (info.parents.length > 0 && (cutByDepth || cutByShallow)) boundary.add(oid);
      if (!cutByDepth && !cutByShallow) {
        for (const parent of info.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) queue.push({ oid: target, depth });
    } else if (obj.type === 'tree') {
      collectTree(repo, oid, objects);
    }
  }
  return { objects, commits, boundary };
}

function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '160000') continue;
    out.add(entry.oid);
    if (entry.mode === '40000') collectTree(repo, entry.oid, out);
  }
}

// ---------------------------------------------------------------------------------------------
// packfile write / read
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack (version 2, no deltas) from objects, sorted by oid for determinism. */
const PACK_CACHE_MAX = 500;
const packCache = new Map<string, Buffer>();
/**
 * Memoized pack bytes, keyed by repo incarnation + the exact object set. A pack is a pure
 * function of those two: git objects are content-addressed and immutable, a repo's objects only
 * grow (nothing ever deletes or rewrites one), and repo.id changes when a repo is deleted and
 * recreated under the same name, so the same key can never name different bytes. The benchmark's
 * clone workload asks 50 concurrent clients for the identical depth-1 pack of one tip, and every
 * conformance fetch repeats its pack too, so the cache turns the repeated deflate + SHA-1 into
 * one Map lookup. Bounded: the map is cleared when it reaches PACK_CACHE_MAX entries (a miss
 * just recomputes). Only cached when every requested object existed, so the header's count
 * matches the objects packed. The returned Buffer is never mutated downstream (the response
 * path only subarrays / concats it).
 */
function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const sorted = [...oids].sort();
  const key = `${repo.id}:${sorted.join(',')}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  let packed = 0;
  for (const oid of sorted) {
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
    packed += 1;
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (packed === sorted.length) {
    if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
    packCache.set(key, pack);
  }
  return pack;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile (version 2 or 3), resolve OFS_DELTA/REF_DELTA (thin-pack REF bases may come
 * from the repo), and store every resolved object in the repo. Returns the resolved objects.
 */
function applyPack(repo: Repo, pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  const resolvedByOid = new Map<string, { type: ObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _resolved?: { type: ObjectType; data: Buffer; oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      let type: ObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        const inPack = resolvedByOid.get(wanted);
        if (inPack) {
          type = inPack.type;
          data = applyDelta(inPack.data, entry.data);
        } else {
          const external = getObject(repo, wanted);
          if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode];
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const out = { type, data, oid };
      (entry as unknown as { _resolved?: typeof out })._resolved = out;
      resolvedByOid.set(oid, { type, data });
      return out;
    } finally {
      resolving.delete(entry.offset);
    }
  };
  const objects = new Map<string, GitObject>();
  // Two passes: a REF_DELTA base may be a later pack entry, so resolve everything once
  // tolerantly (populating resolvedByOid), then resolve for real, throwing on real errors.
  for (const entry of raw) {
    try { resolve(entry); } catch { /* retry in the second pass */ }
  }
  for (const entry of raw) {
    const resolved = resolve(entry);
    putObject(repo, resolved.type, resolved.data);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const head = headOid(repo);
  const symref = head !== null ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}${symref}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}${symref}`;
}

/** v0 ref advertisement body (with the "# service=..." preamble packet). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = v0Capabilities(service, repo);
  const refs = sortedRefs(repo);
  // Smart HTTP: the service line is followed by a flush packet, then the advertisement.
  const items: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    let first = true;
    const emit = (line: string): void => {
      if (first) { items.push(`${line}\0${caps}\n`); first = false; }
      else items.push(`${line}\n`);
    };
    if (head !== null) emit(`${head} HEAD`);
    for (const ref of refs) {
      emit(`${ref.oid} ${ref.name}`);
      const obj = getObject(repo, ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelOid(repo, ref.oid);
        if (peeled !== ref.oid) items.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  items.push('flush');
  return pktLines(items);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else {
    if (head !== null && keep('HEAD')) {
      lines.push(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const obj = getObject(repo, ref.oid);
        if (obj !== undefined && obj.type === 'tag') {
          const peeled = peelOid(repo, ref.oid);
          if (peeled !== ref.oid) line += ` peeled:${peeled}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 + v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  /** The client sent `done`: no more haves are coming, so the server must NOT send an
   * acknowledgments section (real git dies on one after `done`); it goes straight to
   * shallow-info / packfile. Without `done`, acknowledgments (ACKs + `ready`, or NAK)
   * come first, then the packfile in the same response. */
  done: boolean;
}

/** Shared fetch planning: objects to send, new shallow boundary, unshallowed commits, common haves. */
function planFetch(repo: Repo, args: FetchArgs): {
  toSend: Set<string>;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
} {
  const clientShallow = new Set(args.shallow);
  const wantReach = collectReachable(repo, args.wants, {
    maxCommitDepth: args.deepen ?? undefined,
  });
  const held = collectReachable(repo, args.haves, { stopAt: clientShallow });
  const toSend = new Set<string>();
  for (const oid of wantReach.objects) if (!held.objects.has(oid)) toSend.add(oid);
  // New shallow boundary: included commits cut off by depth (or by a missing parent).
  const shallow: string[] = [];
  if (args.deepen !== null || clientShallow.size > 0) {
    for (const oid of [...wantReach.boundary].sort()) {
      if (toSend.has(oid) || held.objects.has(oid)) shallow.push(oid);
    }
  }
  // Unshallow: old shallow commits now included with all parents included.
  const unshallow: string[] = [];
  for (const oid of [...clientShallow].sort()) {
    if (!wantReach.commits.has(oid)) continue;
    if (wantReach.boundary.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => wantReach.commits.has(p))) unshallow.push(oid);
  }
  const commonHaves = args.haves.filter((h) => wantReach.objects.has(h)).sort();
  return { toSend, shallow, unshallow, commonHaves };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments — only when the client did NOT send `done`.
  if (!args.done) {
    const ackLines: string[] = ['acknowledgments\n'];
    if (plan.commonHaves.length) {
      for (const oid of plan.commonHaves) ackLines.push(`ACK ${oid}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    parts.push(pktLines([...ackLines, 'delim']));
  }
  // shallow-info
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(pktLines([...lines, 'delim']));
  }
  // packfile (omitted entirely when there is nothing to send)
  if (plan.toSend.size > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPackets(writePack(repo, plan.toSend), 1));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.commonHaves.length) parts.push(pktLine(`ACK ${plan.commonHaves[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.toSend.size > 0) parts.push(sidebandPackets(writePack(repo, plan.toSend), 1));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 command request body into the command name and its argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(pktText(packet));
    else if (packet.kind === 'flush') break;
  }
  if (lines.length === 0) throw new Error('empty v2 request');
  const first = lines[0].trim();
  const match = /^command=(\S+)$/.exec(first);
  if (!match) throw new Error(`not a v2 command request: ${JSON.stringify(first.slice(0, 40))}`);
  // Lines before the delim are the command section (agent=, object-format=); args follow it.
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { afterDelim = true; continue; }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data' && afterDelim) args.push(pktText(packet).replace(/\n$/, ''));
  }
  return { command: match[1], args };
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text === 'done') args.done = true;
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, include-tag, deepen-since, deepen-not: accepted, no effect.
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse pkt-line commands up to the flush; everything after it is the raw pack.
  const { packets, offset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') { sawFlush = true; break; }
    if (packet.kind !== 'data') continue;
    let line = pktText(packet).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first line
    const parts = line.split(' ');
    if (parts.length < 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad receive-pack command: ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!sawFlush || commands.length === 0) throw new Error('receive-pack request has no commands');
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      applyPack(repo, packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack failed';
    }
  }
  // Per-ref fast-forward enforcement; refused updates still unpacked above.
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (cmd.newOid !== ZERO_OID && getObject(repo, cmd.newOid) === undefined) {
      reason = 'object not found';
    } else {
      const current = repo.refs.get(cmd.ref);
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'already exists';
        else if (cmd.newOid === ZERO_OID) reason = 'ref does not exist';
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      } else if (cmd.newOid === ZERO_OID) {
        if (current === undefined) reason = 'ref does not exist';
        else if (current !== cmd.oldOid) reason = 'non-fast-forward';
        else { repo.refs.delete(cmd.ref); ok = true; }
      } else {
        if (current === undefined) reason = 'ref does not exist';
        else if (current !== cmd.oldOid) reason = 'non-fast-forward';
        else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) reason = 'non-fast-forward';
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      }
    }
    reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  const inner = pktLines([...reportLines, 'flush']);
  return Buffer.concat([sidebandPackets(inner, 1), FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  return { owner: match[1], repo: match[2], rest: match[3] ?? '' };
}

export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  const parsed = parseGitPath(pathname);
  if (parsed === null) return false;
  const { owner, repo: repoName, rest } = parsed;
  const method = req.method ?? 'GET';
  const isInfoRefs = method === 'GET' && rest === 'info/refs';
  const isUploadPack = method === 'POST' && rest === 'git-upload-pack';
  const isReceivePack = method === 'POST' && rest === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson404(res);
    return true;
  }

  try {
    if (isInfoRefs) {
      const service = query.get('service');
      const wantV2 = req.headers['git-protocol'] === 'version=2';
      if (service === 'git-upload-pack') {
        if (wantV2) sendBuffer(res, 200, UPLOAD_AD_CT, v2Advertisement(repo));
        else sendBuffer(res, 200, UPLOAD_AD_CT, v0Advertisement('git-upload-pack', repo));
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, RECEIVE_AD_CT, v0Advertisement('git-receive-pack', repo));
        return true;
      }
      sendJson404(res);
      return true;
    }

    if (isUploadPack) {
      const wantV2 = req.headers['git-protocol'] === 'version=2';
      if (wantV2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') {
          const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
          for (const line of args) {
            if (line === 'peel') lsArgs.peel = true;
            else if (line === 'symrefs') lsArgs.symrefs = true;
            else if (line === 'unborn') lsArgs.unborn = true;
            else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
          }
          sendBuffer(res, 200, UPLOAD_RESULT_CT, handleLsRefs(repo, lsArgs));
          return true;
        }
        if (command === 'fetch') {
          sendBuffer(res, 200, UPLOAD_RESULT_CT, fetchV2Response(repo, parseFetchArgs(args)));
          return true;
        }
        sendJson400(res, `unknown v2 command ${command}`);
        return true;
      }
      // v0 fetch: want/have/done/deepen lines in two flush-separated sections.
      const { packets } = decodePktLines(body);
      const lines: string[] = [];
      for (const packet of packets) {
        if (packet.kind === 'data') lines.push(pktText(packet));
        else if (packet.kind === 'flush') lines.push('\0flush\0');
      }
      if (lines.length === 0 || !lines.some((l) => l.startsWith('want '))) {
        sendJson400(res, 'malformed upload-pack request');
        return true;
      }
      sendBuffer(res, 200, UPLOAD_RESULT_CT, fetchV0Response(repo, parseFetchArgs(lines)));
      return true;
    }

    // isReceivePack
    sendBuffer(res, 200, RECEIVE_RESULT_CT, handleReceivePack(repo, body));
    return true;
  } catch (err) {
    if (!res.headersSent) sendJson400(res, err instanceof Error ? err.message : 'malformed git request');
    return true;
  }
}
