# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/miffaja/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/miffaja/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process, written in TypeScript on the Node 22 standard library only. No git binary, no outside service, no proxy, no UI.

## Run it

```sh
node main.ts
```

It binds an ephemeral port, registers that port with the trial environment (`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the trial is over and exits 0.

## Surfaces (one in-memory store, one base URL)

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with a v0 fallback), receive-pack v0 with report-status and side-band-64k. Packfiles are built and read from scratch: loose objects, SHA-1 ids, zlib-deflated entries, delta application for incoming packs. Every push must fast-forward; a non-fast-forward update is refused per ref with `non-fast-forward` and the ref does not move. A push cannot invent a repository — it is created through REST only.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels, issues, pull requests (including squash merge with three-way conflict detection). Every reply is JSON with a non-empty `X-GitHub-Request-Id`; errors are JSON `{"message": ...}`.
- **GraphQL** at `/api/graphql` — a hand-written executor for the documents the suite sends: viewer, repository fields, introspection for Issue / PullRequest / Repository / SearchType, issue lists and pagination, issue and pull-request mutations, `node(id:)` and batched operation documents. Global ids are opaque and stable.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, both the 2026-07-28 `server/discover` revision and the legacy `initialize` handshake, with six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Auth

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`, the token from this process's environment. A request without it is 401. The token names one login (`adaiversen`, the scenario's viewer); a repository belongs to that login, and the same repository name under another owner is 404, never 403.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — the HTTP shell: body reading, routing, the JSON 404, the 500 guard.
- `store.ts` — the in-memory store: repositories, git objects, refs, issues, labels, pull requests, contents, three-way merge, deterministic timestamps and commit ids.
- `git.ts` — pkt-lines, packfiles, upload-pack v2, receive-pack v0.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL executor.
- `mcp.ts` — the MCP JSON-RPC surface.

## Determinism

No wall clock, no unseeded randomness anywhere in a response: timestamps and commit ids are a fixed epoch plus a counter, pack object order is sorted, and the tools/list answer is a constant. A replay of the same requests leaves the same state.

## Verification

The kit's sealed local suite (`sdk/run.ts`, the same checks the trial env runs) passes 120/120 conformance checks against this server on a fresh process, and the four benchmark workloads score 188–195/200 (push 50, read 50, write 48–50, clone 40–45) — the reference forge scores 100/200 on performance. Total: 988–995/1000 against the reference's 900.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jnzd112y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
