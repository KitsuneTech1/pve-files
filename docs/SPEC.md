# pve-files spec

Web file browser for Proxmox host storage with upload and download.

Kind: quickwin. The tool exists and works. This release is a polish and security
pass, not a rewrite.

## 1. What exists today

Verified on the build machine at commit 47ca68a (Node v25.2.1).

| Thing | State |
|---|---|
| Runtime | Node.js CommonJS, `>=18`. Zero dependencies, `node:http` only |
| Build | None. `npm install` fetches nothing, `node server.js` runs it |
| Source | `server.js` (10 KB), `public/{index.html,app.js,style.css}` |
| Tests | None. No test script, no test dir, no CI |
| README | Long and good: install, LXC bind-mount walkthrough, systemd unit, config table, troubleshooting |
| LICENSE | MIT, "Copyright (c) 2026 Kitsune Technologies LLC". Correct |
| `.gitignore` | `node_modules/`, `storage/`, `.env`, `*.log`, `.oss31/`. Correct |
| `.env.example` | Placeholders only, no secrets |
| Secrets | None. Scanned tree and all git history for private IPs, Windows user paths, keys, tokens. Clean |

The HTTP API is complete: `GET /api/list`, `PUT /api/upload`,
`GET /api/download`, `POST /api/folder`, `DELETE /api/item`, plus static assets.

### Verified by running it

Started the server against a throwaway storage root and exercised every route.
Browse, upload, download, create folder and delete all work. Path confinement
was tested directly, not assumed:

- `../OUTSIDE.txt`, `sub/../../OUTSIDE.txt`, `dir=../..`, `C:\Windows\win.ini`
  -> all rejected, 400
- Upload with `name=../pwned.txt` and with `dir=../..` -> 400, no file
  appeared outside the root
- `/public/..%2f..%2fserver.js` -> 404, source not served
- `//server/share/x`, `C:x.txt`, `/etc/hosts`, `....//....//etc/passwd` -> all
  resolve *inside* the root, so they are confined, not escapes

So the README's "path-traversal protection" claim holds for `..` and absolute
paths. Two real gaps remain, below.

## 2. Smallest honest version

Feature list, final, 5 items:

1. Browse folders under a configured storage root, with breadcrumbs
2. Upload files into the current folder, with a configurable size limit enforced mid-stream
3. Download any file in the root
4. Create a folder
5. Delete a file or folder, behind authentication

Runtime: Node.js 18+, standard library only, zero dependencies. That stays.

Install:

```
git clone https://github.com/KitsuneTech1/pve-files.git
cd pve-files
```

Demo command, the one that shows it working:

```
STORAGE_ROOT=/mnt/storage PVE_FILES_PASSWORD=changeme node server.js
```

then open `http://localhost:3000`.

Tested by a `test/` dir run with `node --test` (built into Node 18+, so still
zero dependencies), added in the build phase. It starts the server on an
ephemeral port against a temp storage root and asserts: the five features
round-trip; every traversal payload above is rejected or confined; a symlink
pointing outside the root is refused; routes require auth when a password is
set; an oversized upload returns 413 and leaves no partial file. `npm test`
runs it, so a stranger can check the security claims instead of trusting them.

## 3. Release blockers

Ordered by severity. Items 1 and 2 are the security pass the planner held July for.

1. **No authentication at all.** Every route is open, including the recursive
   `DELETE /api/item`, so anyone who can reach the port can wipe the storage
   root. Verified: an unauthenticated DELETE returned
   `{"ok":true,"message":"Deleted item."}`. The README lists "Login and
   authentication" under "Next improvements", which is honest but not shippable
   for a tool whose job is exposing host storage over HTTP. Fix: require a
   password (env var) on all routes, constant-time compared, and refuse to start
   if it is unset rather than silently running open.
2. **Symlinks escape the storage root.** Confinement is checked on the lexical
   path, never the real one, and `server.js` never calls `realpath` or `lstat`.
   Verified live: a symlink inside the root pointing at its parent let a file
   outside the root be read through `/api/download`. This matters here because
   the root is usually a bind-mounted Proxmox share the operator may not fully
   control. Fix: resolve the real path and re-check containment before any read,
   write or delete.
3. **No tests.** The README makes specific security claims ("all paths are
   resolved and checked against the storage root") with nothing a reader can run
   to confirm them. See section 2.
4. **`"private": true` in `package.json`**, left over from a non-published
   project and contradictory in a repo being open-sourced. Also no `repository`,
   `author`, `bugs` or `homepage` fields.
5. **Delete wipes a whole tree from one request.** `fsp.rm(absolute, {
   recursive: true })` removes a directory and everything under it. The browser
   asks "Delete?" but the API does not care. Pair this with blocker 1.
6. **`Content-Disposition` filename is percent-encoded.** `encodeURIComponent` on
   the filename means a download of `my file.txt` saves as `my%20file.txt` in
   some browsers. Should use RFC 5987 `filename*=UTF-8''...` with a plain ASCII
   `filename` fallback.
7. **UI name mismatch.** The page title and heading say "Storage Deck", the repo
   and README say `pve-files`. A stranger cloning this sees two different product
   names. Pick `pve-files`.
8. **Upload overwrites silently.** `createWriteStream` with `flags: "w"` clobbers
   an existing file with no warning. At minimum say so in the README.
9. **`docs/screenshot.png` goes stale** once the UI heading changes, and needs a
   re-check for any private hostname or path visible in the browser chrome.
10. **Missing `X-Content-Type-Options` on API responses**, and full stack traces
    are logged to stdout on any unhandled error. Minor, worth a pass.

Out of scope: drag-and-drop progress, chunked uploads, previews, share links,
rename, move, multi-user accounts. Those stay in "Next improvements".
