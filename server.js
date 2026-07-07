"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pipeline } = require("stream/promises");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, "storage"));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const PUBLIC_ROOT = path.join(__dirname, "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeRelativePath(inputPath = "") {
  const cleaned = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);

  if (normalized === "." || normalized === "/") {
    return "";
  }

  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error("Path escapes storage root.");
  }

  return normalized;
}

function resolveStoragePath(relativePath = "") {
  const safeRelative = normalizeRelativePath(relativePath);
  const absolute = path.resolve(STORAGE_ROOT, safeRelative);

  if (absolute !== STORAGE_ROOT && !absolute.startsWith(`${STORAGE_ROOT}${path.sep}`)) {
    throw new Error("Resolved path escapes storage root.");
  }

  return { safeRelative, absolute };
}

function sanitizeName(input) {
  const trimmed = String(input || "").trim();

  if (!trimmed) {
    throw new Error("Name is required.");
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error("Invalid name.");
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

async function ensureStorageRoot() {
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
}

async function readRequestBody(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;

    if (totalLength > 1024 * 1024) {
      throw new Error("Request body too large.");
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
  const { safeRelative, absolute } = resolveStoragePath(relativeDir);
  const entries = await fsp.readdir(absolute, { withFileTypes: true });

  const mapped = await Promise.all(entries.map(async (entry) => {
    const entryRelative = safeRelative ? `${safeRelative}/${entry.name}` : entry.name;
    const entryAbsolute = path.join(absolute, entry.name);
    const stats = await fsp.stat(entryAbsolute);

    return {
      name: entry.name,
      path: entryRelative,
      type: entry.isDirectory() ? "directory" : "file",
      size: stats.size,
      sizeLabel: entry.isDirectory() ? "Folder" : formatBytes(stats.size),
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

  if (absolutePath !== PUBLIC_ROOT && !absolutePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
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
  const { absolute: targetDir } = resolveStoragePath(dir);
  const targetFile = path.join(targetDir, name);
  let receivedBytes = 0;

  await fsp.mkdir(targetDir, { recursive: true });

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
  const { absolute } = resolveStoragePath(filePath);
  const stats = await fsp.stat(absolute);

  if (!stats.isFile()) {
    json(res, 400, { error: "Requested path is not a file." });
    return;
  }

  const fileName = path.basename(absolute);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": stats.size
  });

  await pipeline(fs.createReadStream(absolute), res);
}

async function handleCreateFolder(req, res) {
  const body = await parseJsonBody(req);
  const dir = body.dir || "";
  const name = sanitizeName(body.name);
  const { absolute: parentDir } = resolveStoragePath(dir);
  const folderPath = path.join(parentDir, name);

  await fsp.mkdir(folderPath, { recursive: false });
  json(res, 201, { ok: true, message: `Created folder ${name}` });
}

async function handleDelete(url, res) {
  const itemPath = url.searchParams.get("path") || "";
  const { absolute } = resolveStoragePath(itemPath);

  await fsp.rm(absolute, { recursive: true, force: false });
  json(res, 200, { ok: true, message: "Deleted item." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
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
    if (error.code === "ENOENT") {
      json(res, 404, { error: "Item not found." });
      return;
    }

    if (error.code === "EEXIST") {
      json(res, 409, { error: "That folder already exists." });
      return;
    }

    if (error instanceof SyntaxError) {
      json(res, 400, { error: "Invalid JSON request body." });
      return;
    }

    if (error.message === "Path escapes storage root." || error.message === "Resolved path escapes storage root." || error.message === "Invalid name." || error.message === "Name is required.") {
      json(res, 400, { error: error.message });
      return;
    }

    console.error(error);
    json(res, 500, { error: "Internal server error." });
  }
});

async function start() {
  await ensureStorageRoot();

  server.listen(PORT, () => {
    console.log(`Proxmox storage site running on http://localhost:${PORT}`);
    console.log(`Storage root: ${STORAGE_ROOT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
