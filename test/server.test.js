"use strict";

// Starts the real server in this test process on an ephemeral loopback port
// against a temp storage root, then exercises the HTTP user path. No external
// network access or dependencies are needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const PASSWORD = "test-password";
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
const MAX_UPLOAD = 1024;
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "pve-files-test-"));
const storageRoot = path.join(tempBase, "root");
const outsideDir = path.join(tempBase, "outside");

fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(outsideDir, "SECRET.txt"), "do not read me");

process.env.PORT = "0";
process.env.STORAGE_ROOT = storageRoot;
process.env.MAX_UPLOAD_BYTES = String(MAX_UPLOAD);
process.env.PVE_FILES_PASSWORD = PASSWORD;
process.env.PVE_FILES_ALLOW_NO_AUTH = "";

const { server, start } = require("../server.js");

let baseUrl = "";

function req(pathname, options = {}) {
  const headers = { Authorization: AUTH, ...(options.headers || {}) };
  return fetch(`${baseUrl}${pathname}`, { ...options, headers });
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tempBase, { recursive: true, force: true });
});

test("refuses to start with no password and no explicit opt-out", async () => {
  await assert.rejects(() => start({ password: "", allowNoAuth: false }), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.match(error.message, /Refusing to start without a password/);
    return true;
  });
});

test("every route requires auth when a password is set", async () => {
  const routes = [
    ["GET", "/api/list"],
    ["GET", "/api/download?path=x.txt"],
    ["PUT", "/api/upload?name=x.txt"],
    ["POST", "/api/folder"],
    ["DELETE", "/api/item?path=x.txt"],
    ["GET", "/"]
  ];

  for (const [method, pathname] of routes) {
    const response = await fetch(`${baseUrl}${pathname}`, { method });
    assert.equal(response.status, 401, `${method} ${pathname} should be 401`);
    assert.match(response.headers.get("www-authenticate") || "", /^Basic realm=/);
  }
});

test("a wrong password is rejected", async () => {
  const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
  const response = await fetch(`${baseUrl}/api/list`, { headers: { Authorization: wrong } });
  assert.equal(response.status, 401);
});

test("authenticated users can load the browser", async () => {
  const response = await req("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>pve-files<\/title>/);
});

test("the five features round-trip", async () => {
  // Create a folder.
  const created = await req("/api/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: "", name: "demo" })
  });
  assert.equal(created.status, 201);

  // Upload into it.
  const uploaded = await req("/api/upload?dir=demo&name=hello%20world.txt", {
    method: "PUT",
    body: "hello from the test"
  });
  assert.equal(uploaded.status, 201);

  // Browse it, with breadcrumbs.
  const listed = await (await req("/api/list?dir=demo")).json();
  assert.equal(listed.currentDir, "demo");
  assert.deepEqual(listed.breadcrumbs.map((c) => c.name), ["storage", "demo"]);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].name, "hello world.txt");
  assert.equal(listed.entries[0].type, "file");

  // Download it, with an unencoded filename in the header.
  const downloaded = await req("/api/download?path=demo%2Fhello%20world.txt");
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), "hello from the test");
  const disposition = downloaded.headers.get("content-disposition");
  assert.match(disposition, /filename="hello world\.txt"/);
  assert.match(disposition, /filename\*=UTF-8''hello%20world\.txt/);

  // Delete the file, then the now-empty folder.
  assert.equal((await req("/api/item?path=demo%2Fhello%20world.txt", { method: "DELETE" })).status, 200);
  assert.equal((await req("/api/item?path=demo", { method: "DELETE" })).status, 200);

  const after = await (await req("/api/list")).json();
  assert.equal(after.entries.find((e) => e.name === "demo"), undefined);
});

test("traversal payloads are rejected or confined", async () => {
  const payloads = [
    "../OUTSIDE.txt",
    "sub/../../OUTSIDE.txt",
    "../..",
    "....//....//etc/passwd",
    "/etc/hosts",
    "C:\\Windows\\win.ini",
    "//server/share/x",
    "bad\0path"
  ];

  for (const payload of payloads) {
    const response = await req(`/api/download?path=${encodeURIComponent(payload)}`);
    // Either refused outright, or resolved to a path inside the root that does
    // not exist. Never a 200.
    assert.ok([400, 404].includes(response.status), `${payload} returned ${response.status}`);
  }

  // Nothing leaked out of the root.
  const leaked = await fsp.readdir(path.dirname(storageRoot));
  assert.deepEqual(leaked.sort(), ["outside", "root"]);
});

test("upload cannot write outside the root", async () => {
  const response = await req("/api/upload?dir=&name=..%2Fpwned.txt", {
    method: "PUT",
    body: "pwned"
  });
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(path.join(path.dirname(storageRoot), "pwned.txt")), false);

  const viaDir = await req("/api/upload?dir=..%2F..&name=pwned2.txt", {
    method: "PUT",
    body: "pwned"
  });
  assert.equal(viaDir.status, 400);
  assert.equal(fs.existsSync(path.join(path.dirname(storageRoot), "pwned2.txt")), false);
});

test("source is not served through the static route", async () => {
  const response = await req("/public/..%2f..%2fserver.js");
  assert.ok([403, 404].includes(response.status));
  const body = await response.text();
  assert.equal(body.includes("STORAGE_ROOT"), false);
});

test("a symlink pointing outside the root is refused", async (t) => {
  const link = path.join(storageRoot, "escape");

  try {
    await fsp.symlink(outsideDir, link, "dir");
  } catch (error) {
    // Windows needs elevation or developer mode for symlinks. Skip rather than
    // report a false pass.
    t.skip(`cannot create symlink here: ${error.code}`);
    return;
  }

  try {
    const read = await req("/api/download?path=escape%2FSECRET.txt");
    assert.equal(read.status, 400);

    const listed = await req("/api/list?dir=escape");
    assert.equal(listed.status, 400);

    const rootListing = await (await req("/api/list")).json();
    assert.equal(rootListing.entries.some((entry) => entry.name === "escape"), false);

    const written = await req("/api/upload?dir=escape&name=planted.txt", {
      method: "PUT",
      body: "planted"
    });
    assert.equal(written.status, 400);
    assert.equal(fs.existsSync(path.join(outsideDir, "planted.txt")), false);

    const deleted = await req("/api/item?path=escape%2FSECRET.txt", { method: "DELETE" });
    assert.equal(deleted.status, 400);
    assert.equal(fs.existsSync(path.join(outsideDir, "SECRET.txt")), true);
  } finally {
    await fsp.unlink(link).catch(() => {});
  }
});

test("an oversized upload returns 413 and leaves no partial file", async () => {
  await fsp.writeFile(path.join(storageRoot, "big.bin"), "keep this file");

  const response = await req("/api/upload?dir=&name=big.bin", {
    method: "PUT",
    body: Buffer.alloc(MAX_UPLOAD * 4, 0x61)
  }).catch((error) => error);

  // The server destroys the request mid-stream, so fetch may reject instead of
  // returning a response. Either way the file must not survive.
  if (response instanceof Error) {
    assert.match(String(response), /fetch|socket|terminated|aborted/i);
  } else {
    assert.equal(response.status, 413);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await fsp.readFile(path.join(storageRoot, "big.bin"), "utf8"), "keep this file");

  const replaced = await req("/api/upload?dir=&name=big.bin", {
    method: "PUT",
    body: "replacement"
  });
  assert.equal(replaced.status, 201);
  assert.equal(await fsp.readFile(path.join(storageRoot, "big.bin"), "utf8"), "replacement");
});

test("an upload at the limit still succeeds", async () => {
  const response = await req("/api/upload?dir=&name=atlimit.bin", {
    method: "PUT",
    body: Buffer.alloc(MAX_UPLOAD, 0x62)
  });
  assert.equal(response.status, 201);

  const stats = await fsp.stat(path.join(storageRoot, "atlimit.bin"));
  assert.equal(stats.size, MAX_UPLOAD);

  await req("/api/item?path=atlimit.bin", { method: "DELETE" });
});

test("an upload cannot replace a folder", async () => {
  await fsp.mkdir(path.join(storageRoot, "folder-target"));
  const response = await req("/api/upload?name=folder-target", {
    method: "PUT",
    body: "not a folder"
  });

  assert.equal(response.status, 409);
  assert.equal((await fsp.stat(path.join(storageRoot, "folder-target"))).isDirectory(), true);
});

test("deleting a non-empty folder needs recursive=1", async () => {
  await req("/api/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: "", name: "tree" })
  });
  await req("/api/upload?dir=tree&name=keep.txt", { method: "PUT", body: "keep" });

  const refused = await req("/api/item?path=tree", { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.equal(fs.existsSync(path.join(storageRoot, "tree", "keep.txt")), true);

  const allowed = await req("/api/item?path=tree&recursive=1", { method: "DELETE" });
  assert.equal(allowed.status, 200);
  assert.equal(fs.existsSync(path.join(storageRoot, "tree")), false);
});

test("the storage root itself cannot be deleted", async () => {
  const response = await req("/api/item?path=", { method: "DELETE" });
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(storageRoot), true);
});

test("bad names are rejected", async () => {
  for (const name of ["", " ", ".", "..", "a/b", "a\\b"]) {
    const response = await req("/api/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "", name })
    });
    assert.equal(response.status, 400, `name ${JSON.stringify(name)} returned ${response.status}`);
  }
});

test("API responses carry X-Content-Type-Options", async () => {
  const response = await req("/api/list");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
