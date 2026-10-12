"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, "storage"));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const PASSWORD = process.env.PVE_FILES_PASSWORD || "";
const AUTH_USER = process.env.PVE_FILES_USER || "admin";
const ALLOW_NO_AUTH = process.env.PVE_FILES_ALLOW_NO_AUTH === "1";
const PUBLIC_ROOT = path.join(__dirname, "public");
const REALM = "pve-files";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

// Compare two strings without leaking their contents through timing. Hashing
// first keeps timingSafeEqual happy when the lengths differ.
function constantTimeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function isAuthorized(req) {
  if (!PASSWORD) {
    return true;
  }

  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    return false;
  }

  let decoded = "";

  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");

  if (separator === -1) {
    return false;
  }

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);

  return constantTimeEqual(user, AUTH_USER) && constantTimeEqual(pass, PASSWORD);
}

function requireAuth(res) {
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`
  });
  res.end(JSON.stringify({ error: "Authentication required." }));
}

function normalizeRelativePath(inputPath = "") {
  const cleaned = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);

  if (normalized === "." || normalized === "/") {
    return "";
  }

  if (normalized.startsWith("../") || normalized === "..") {
    throw new HttpError(400, "Path escapes storage root.");
  }

  return normalized;
}

function isInsideRoot(absolute, root) {
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

function resolveStoragePath(relativePath = "") {
  const safeRelative = normalizeRelativePath(relativePath);
  const absolute = path.resolve(STORAGE_ROOT, safeRelative);

  if (!isInsideRoot(absolute, STORAGE_ROOT)) {
    throw new HttpError(400, "Resolved path escapes storage root.");
  }

  return { safeRelative, absolute };
}

// The lexical check above only proves the requested string stays inside the
// root. A symlink inside the root can still point outside it, so resolve the
// real path and check containment again before touching anything.
async function realPathInsideRoot(absolute) {
  const rootReal = await fsp.realpath(STORAGE_ROOT);

  try {
    const target = await fsp.realpath(absolute);

    if (!isInsideRoot(target, rootReal)) {
      throw new HttpError(400, "Resolved path escapes storage root.");
    }

    return target;
  } catch (error) {
    if (error instanceof HttpError || error.code !== "ENOENT") {
      throw error;
    }
  }

  // The item does not exist yet (a new upload or folder). Check the closest
  // existing ancestor instead, which is where a write would actually land.
  let parent = path.dirname(absolute);

  for (;;) {
    try {
      const parentReal = await fsp.realpath(parent);

      if (!isInsideRoot(parentReal, rootReal)) {
        throw new HttpError(400, "Resolved path escapes storage root.");
      }

      return absolute;
    } catch (error) {
      if (error instanceof HttpError || error.code !== "ENOENT") {
        throw error;
      }

      const next = path.dirname(parent);

      if (next === parent) {
        throw new HttpError(400, "Resolved path escapes storage root.");
      }

      parent = next;
    }
  }
}

async function resolveStoragePathChecked(relativePath = "") {
  const resolved = resolveStoragePath(relativePath);
  await realPathInsideRoot(resolved.absolute);
  return resolved;
}

function sanitizeName(input) {
  const trimmed = String(input || "").trim();

  if (!trimmed) {
    throw new HttpError(400, "Name is required.");
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new HttpError(400, "Invalid name.");
  }

  if (trimmed.includes("\0")) {
    throw new HttpError(400, "Invalid name.");
  }

  return trimmed;
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// RFC 5987: give browsers a plain ASCII fallback plus the real UTF-8 name, so
// "my file.txt" saves under that name instead of "my%20file.txt".
function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function ensureStorageRoot() {
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
}

async function readRequestBody(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;

    if (totalLength > 1024 * 1024) {
      throw new HttpError(413, "Request body too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function parseJsonBody(req) {
  const text = await readRequestBody(req);
  return text ? JSON.parse(text) : {};
}

async function listDirectory(relativeDir) {
  const { safeRelative, absolute } = await resolveStoragePathChecked(relativeDir);
  const entries = await fsp.readdir(absolute, { withFileTypes: true });

  const mapped = await Promise.all(entries.map(async (entry) => {
    const entryRelative = safeRelative ? `${safeRelative}/${entry.name}` : entry.name;
    const entryAbsolute = path.join(absolute, entry.name);
    let stats = null;

    try {
      stats = await fsp.stat(entryAbsolute);
    } catch {
      // Broken symlink, or a race with another process. Fall back to the link
      // itself so the rest of the listing still renders.
      stats = await fsp.lstat(entryAbsolute);
    }

    const isDirectory = stats.isDirectory();

    return {
      name: entry.name,
      path: entryRelative,
      type: isDirectory ? "directory" : "file",
      size: stats.size,
      sizeLabel: isDirectory ? "Folder" : formatBytes(stats.size),
      modifiedAt: stats.mtime.toISOString()
    };
  }));

  mapped.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    currentDir: safeRelative,
    breadcrumbs: buildBreadcrumbs(safeRelative),
    entries: mapped
  };
}

function buildBreadcrumbs(relativeDir) {
  const parts = relativeDir ? relativeDir.split("/") : [];
  const breadcrumbs = [{ name: "storage", path: "" }];
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    breadcrumbs.push({ name: part, path: current });
  }

  return breadcrumbs;
}

async function serveStaticAsset(reqPath, res) {
  const relativePath = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(PUBLIC_ROOT, relativePath);

  if (!isInsideRoot(absolutePath, PUBLIC_ROOT)) {
    json(res, 403, { error: "Invalid asset path." });
    return;
  }

  try {
    const stats = await fsp.stat(absolutePath);

    if (!stats.isFile()) {
      json(res, 404, { error: "Asset not found." });
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });

    await pipeline(fs.createReadStream(absolutePath), res);
  } catch (error) {
    if (error.code === "ENOENT") {
      json(res, 404, { error: "Asset not found." });
      return;
    }

    throw error;
  }
}

async function handleList(url, res) {
  const dir = url.searchParams.get("dir") || "";
  const listing = await listDirectory(dir);
  json(res, 200, listing);
}

async function handleUpload(req, url, res) {
  const dir = url.searchParams.get("dir") || "";
  const name = sanitizeName(url.searchParams.get("name") || req.headers["x-file-name"]);
  const { absolute: targetDir } = await resolveStoragePathChecked(dir);
  const targetFile = path.join(targetDir, name);
  let receivedBytes = 0;

  await fsp.mkdir(targetDir, { recursive: true });
  await realPathInsideRoot(targetFile);

  const writeStream = fs.createWriteStream(targetFile, { flags: "w" });

  req.on("data", (chunk) => {
    receivedBytes += chunk.length;

    if (receivedBytes > MAX_UPLOAD_BYTES) {
      writeStream.destroy(new Error("Upload exceeds size limit."));
      req.destroy(new Error("Upload exceeds size limit."));
    }
  });

  try {
    await pipeline(req, writeStream);
    json(res, 201, {
      ok: true,
      message: `Uploaded ${name}`,
      bytesWritten: receivedBytes
    });
  } catch (error) {
    await fsp.rm(targetFile, { force: true }).catch(() => {});

    if (String(error.message).includes("size limit")) {
      json(res, 413, { error: `Upload exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit.` });
      return;
    }

    throw error;
  }
}

async function handleDownload(url, res) {
  const filePath = url.searchParams.get("path") || "";
  const { absolute } = await resolveStoragePathChecked(filePath);
  const stats = await fsp.stat(absolute);

  if (!stats.isFile()) {
    json(res, 400, { error: "Requested path is not a file." });
    return;
  }

  const fileName = path.basename(absolute);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(fileName),
    "Content-Length": stats.size
  });

  await pipeline(fs.createReadStream(absolute), res);
}

async function handleCreateFolder(req, res) {
  const body = await parseJsonBody(req);
  const dir = body.dir || "";
  const name = sanitizeName(body.name);
  const { absolute: parentDir } = await resolveStoragePathChecked(dir);
  const folderPath = path.join(parentDir, name);

  await realPathInsideRoot(folderPath);
  await fsp.mkdir(folderPath, { recursive: false });
  json(res, 201, { ok: true, message: `Created folder ${name}` });
}

async function handleDelete(url, res) {
  const itemPath = url.searchParams.get("path") || "";
  const { safeRelative, absolute } = await resolveStoragePathChecked(itemPath);

  if (!safeRelative) {
    throw new HttpError(400, "Refusing to delete the storage root.");
  }

  const stats = await fsp.lstat(absolute);

  // Wiping a whole tree takes an explicit opt-in, so one stray request cannot
  // take out a populated folder.
  if (stats.isDirectory()) {
    const entries = await fsp.readdir(absolute);

    if (entries.length && url.searchParams.get("recursive") !== "1") {
      throw new HttpError(409, "Folder is not empty. Pass recursive=1 to delete it and everything under it.");
    }
  }

  await fsp.rm(absolute, { recursive: true, force: false });
  json(res, 200, { ok: true, message: "Deleted item." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (!isAuthorized(req)) {
      requireAuth(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/public/"))) {
      const assetPath = url.pathname === "/" ? "/" : url.pathname.replace(/^\/public/, "");
      await serveStaticAsset(assetPath, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      await handleList(url, res);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/upload") {
      await handleUpload(req, url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/download") {
      await handleDownload(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/folder") {
      await handleCreateFolder(req, res);
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/item") {
      await handleDelete(url, res);
      return;
    }

    json(res, 404, { error: "Route not found." });
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    if (error instanceof HttpError) {
      json(res, error.statusCode, { error: error.message });
      return;
    }

    if (error.code === "ENOENT") {
      json(res, 404, { error: "Item not found." });
      return;
    }

    if (error.code === "EEXIST") {
      json(res, 409, { error: "That folder already exists." });
      return;
    }

    if (error.code === "ENOTEMPTY") {
      json(res, 409, { error: "Folder is not empty." });
      return;
    }

    if (error instanceof SyntaxError) {
      json(res, 400, { error: "Invalid JSON request body." });
      return;
    }

    console.error(`${req.method} ${url.pathname} failed: ${error.message}`);
    json(res, 500, { error: "Internal server error." });
  }
});

async function start() {
  if (!PASSWORD && !ALLOW_NO_AUTH) {
    console.error("Refusing to start without a password.");
    console.error("Set PVE_FILES_PASSWORD to a password of your own, for example:");
    console.error("  PVE_FILES_PASSWORD=your-password node server.js");
    console.error("To run with no authentication anyway, set PVE_FILES_ALLOW_NO_AUTH=1.");
    console.error("Only do that on a host nobody else can reach.");
    process.exit(1);
  }

  await ensureStorageRoot();

  server.listen(PORT, () => {
    console.log(`pve-files running on http://localhost:${PORT}`);
    console.log(`Storage root: ${STORAGE_ROOT}`);

    if (PASSWORD) {
      console.log(`Authentication: on, user "${AUTH_USER}"`);
    } else {
      console.log("Authentication: OFF. Every route is open to anyone who can reach this port.");
    }
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { server, start, STORAGE_ROOT, PORT };
