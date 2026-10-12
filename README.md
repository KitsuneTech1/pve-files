<p align="center"><a href="https://kitsunetechnologies.org/work"><img src="https://raw.githubusercontent.com/KitsuneTech1/.github/main/assets/kitsune-banner.svg" alt="Built by Kitsune Technologies" width="760"></a></p>

# pve-files

A small Node.js web UI for browsing, uploading, and downloading files on a storage path mounted from your Proxmox host.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)

![Screenshot](docs/screenshot.png)

## Features

- Browse folders under a configured storage root, with breadcrumbs
- Upload files directly into the current folder
- Download files with a direct link
- Create folders
- Delete files or folders
- Password required on every route, the server refuses to start without one
- Path confinement, every path is resolved to its real location (symlinks included) and checked against the storage root
- Upload size limit, configurable, rejects oversized uploads mid-stream
- Zero dependencies, Node standard library only
- Tests you can run yourself: `npm test`

## Run it yourself

### What you need

- **A machine to run it on.** Your own PC, a spare Linux box, or (the main use case) a Proxmox LXC container, a lightweight Linux container that Proxmox runs directly on the host, cheaper than a full VM.
- **Node.js 18 or newer.** Check what you have with `node -v`. If it's missing or older:
  - Debian/Ubuntu: `sudo apt update && sudo apt install nodejs npm`
  - Windows: get the LTS installer from [nodejs.org](https://nodejs.org).
  - macOS: `brew install node` (needs [Homebrew](https://brew.sh)).
- **Git**, to grab the code, or download a ZIP from the GitHub page. Check with `git --version`.
- **(To browse actual Proxmox storage) a Proxmox VE host you manage**, with access to the Proxmox web UI or SSH as root, so you can create the LXC and bind-mount storage into it. This app never talks to the Proxmox API itself, it only reads and writes plain files at a folder path you give it (`STORAGE_ROOT`), so the storage has to already be reachable as a folder before the app can see it.
- **(Optional)** A domain name and a reverse proxy (Nginx or Caddy) if you want a real URL and HTTPS instead of `http://ip:3000`.

### Step by step

Get the code first, whichever option you use below:

```bash
git clone https://github.com/KitsuneTech1/pve-files.git
cd pve-files
```

You should see `server.js` and `package.json` in the folder. No `git`? Download the ZIP from the GitHub page, extract it, and open a terminal there instead.

#### Option A: plain Node, browsing a local folder

Good for trying it out before you point it at real Proxmox storage.

1. Install dependencies (there are none beyond Node itself, this just sets things up):
   ```bash
   npm install
   ```
   You should see it finish with no red error text (it may print `up to date` since there's nothing to fetch).
2. Start the server with a password of your choosing:
   ```bash
   PVE_FILES_PASSWORD=changeme node server.js
   ```
   You should see `pve-files running on http://localhost:3000`, the storage root it's using (defaults to a `storage/` folder created next to `server.js`), and `Authentication: on`. Without `PVE_FILES_PASSWORD` the server prints an error and exits, on purpose, so it never sits open by accident.
3. Open `http://localhost:3000` in a browser. It asks for a username and password: `admin` and whatever you set above.

**It worked if:** the page loads, shows an empty file list, and you can create a folder and upload a small test file into it.

**Keep it running after you close the terminal:** use the systemd service further down (Linux), or `pm2 start server.js --name pve-files` on any OS with Node.

#### Option B: Proxmox LXC with Proxmox storage bind-mounted in

This is the actual point of this app: browsing a real disk or storage pool from your Proxmox host through a web page, without exposing Proxmox's own admin UI.

1. In the Proxmox web UI, create an Ubuntu or Debian LXC (or reuse one), and note its container ID, for example `105`.
2. Install Node.js 18+ inside that LXC:
   ```bash
   apt update && apt install -y nodejs npm
   node -v
   ```
   You should see `v18` or higher.
3. Copy this project into the LXC (from your own machine, replace `105` with your container ID):
   ```bash
   scp -r pve-files root@<lxc-ip>:/opt/pve-files
   ```
   Or `git clone` the repo directly inside the LXC if it has network access.
4. **Bind-mount your Proxmox storage into the container.** This is the step that actually connects the app to real storage. Run this on the Proxmox host itself (not inside the container), replacing `105` with your container ID and `/mnt/pve/your-storage` with the actual path of the storage you want to browse (find it under Datacenter > Storage in the Proxmox UI, or `/etc/pve/storage.cfg`):
   ```bash
   pct set 105 -mp0 /mnt/pve/your-storage,mp=/mnt/storage
   ```
   `pct set` changes a container's config. `-mp0` adds (or replaces) the container's first bind-mount slot. The part before the comma is the real path on the Proxmox host, the part after `mp=` is where it shows up inside the container. After this, restart the container (`pct reboot 105`) so the mount takes effect.
5. Inside the LXC, confirm the mount showed up:
   ```bash
   ls /mnt/storage
   ```
   You should see the same files that exist on the host storage.
6. Set `STORAGE_ROOT` to that mounted path and start the app:
   ```bash
   cd /opt/pve-files
   STORAGE_ROOT=/mnt/storage PVE_FILES_PASSWORD=changeme node server.js
   ```
   You should see `Storage root: /mnt/storage` printed on startup, confirming it's pointed at the right place and not the default local `storage/` folder. Pick a real password, not `changeme`.
7. Open `http://<lxc-ip>:3000` in a browser and log in as `admin` with that password. You should see the real contents of your Proxmox storage.

**It worked if:** the file list in the browser matches what you see with `ls` on the mounted path in step 5, and a file you upload through the browser shows up on the Proxmox host's actual storage.

**Keep it running:** set up the systemd service below, using `STORAGE_ROOT=/mnt/storage` (or your path) as one of the `Environment=` lines, then `systemctl enable --now pve-files`.

**Windows example** (browsing storage over an existing SMB share instead of an LXC bind mount):

```powershell
$env:STORAGE_ROOT='Z:\proxmox-share'
$env:PVE_FILES_PASSWORD='changeme'
node server.js
```

**Linux example** (an NFS share or any other already-mounted path):

```bash
STORAGE_ROOT=/mnt/proxmox-storage PVE_FILES_PASSWORD=changeme node server.js
```

### Example systemd service

Create `/etc/systemd/system/pve-files.service`:

```ini
[Unit]
Description=pve-files storage browser
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pve-files
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
Environment=STORAGE_ROOT=/mnt/storage
Environment=MAX_UPLOAD_BYTES=1073741824
Environment=PVE_FILES_PASSWORD=YOUR_PASSWORD

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pve-files
```

The unit file holds your password in plain text, so keep it root-readable only:

```bash
sudo chmod 600 /etc/systemd/system/pve-files.service
```

### Troubleshooting

- **The server prints "Refusing to start without a password" and exits**: set `PVE_FILES_PASSWORD`. This is deliberate. The app exposes host storage over HTTP, including delete, so it will not run wide open unless you ask for that with `PVE_FILES_ALLOW_NO_AUTH=1`.
- **The browser keeps asking for a password**: the username is `admin` unless you changed `PVE_FILES_USER`. Browsers cache basic-auth credentials for the tab, so close it and reopen to retry a different password.
- **The page loads but the file list shows "Request cannot be constructed from a URL that includes credentials"**: you opened it as `http://admin:password@host:3000/`. Browsers block `fetch` from a page loaded that way, so the listing never arrives. Open plain `http://host:3000/` instead and type the username and password into the prompt.
- **Deleting a folder returns "Folder is not empty"**: that is the guard against wiping a tree by accident. The browser's Delete button retries with `recursive=1` after you confirm. Over the API, add `&recursive=1` yourself.
- **Page loads but the file list is always empty, even though you know the storage has files**: `STORAGE_ROOT` is pointing at the wrong folder, most likely still the default `./storage`. Check the startup log line `Storage root: ...` and confirm it matches the path you bind-mounted or shared.
- **Uploads fail with "Upload exceeds the ... limit"**: the file is bigger than `MAX_UPLOAD_BYTES` (default is 1 GiB, `1073741824` bytes). Raise it in `.env` or your systemd `Environment=` line, keep in mind it's in raw bytes, not MB.
- **A request returns "Resolved path escapes storage root"**: the app blocks any path that would land outside `STORAGE_ROOT`, this is a safety check working as intended, not a bug. It usually means a stale link or a manually typed URL, not something you need to change in the storage itself.
- **The LXC container can't see anything under the mount point**: the bind mount didn't take effect. Double-check the `pct set` command ran on the Proxmox host (not inside the container), then `pct reboot <id>` and re-check with `ls` inside the container.

## Security notes

Read these before you put this on a network you do not control.

- **A password is required.** Every route, including the static page, needs HTTP basic auth. The server refuses to start without `PVE_FILES_PASSWORD`.
- **Basic auth sends the password on every request, base64 encoded, not encrypted.** Over plain `http://` on a LAN that is usually fine. Over the internet, put it behind a reverse proxy with HTTPS (Caddy or Nginx), or reach it over a VPN or Tailscale. Do not port-forward it.
- **Paths are confined to `STORAGE_ROOT`.** Requested paths are normalized, resolved to their real location with `realpath` so a symlink cannot point out of the root, and re-checked before any read, write, or delete. `npm test` covers the traversal and symlink cases.
- **Deleting a non-empty folder needs an explicit `recursive=1`.** The UI asks you to confirm first.
- **Uploads overwrite an existing file with the same name, without warning.** There is no versioning and no undo.
- **There is one account.** Anyone with the password can read, write, and delete anything under the storage root.

## Tests

```bash
npm test
```

This runs `node --test` (built into Node 18+, so still zero dependencies). It starts the server on an ephemeral port against a temp folder and checks the five features round-trip, that auth is enforced on every route, that traversal payloads and out-of-root symlinks are refused, that an oversized upload returns 413 and leaves nothing behind, and that the storage root itself cannot be deleted. If you do not want to take the security claims above on trust, run this.

## Config

Set these as environment variables, or copy `.env.example` to `.env` and load it with your process manager of choice.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on |
| `STORAGE_ROOT` | `./storage` | Root directory the UI browses, uploads to, and downloads from |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GB) | Maximum size for a single upload, larger uploads are rejected |
| `PVE_FILES_PASSWORD` | none | Password for every route. Required. The server exits if it is unset |
| `PVE_FILES_USER` | `admin` | Username that goes with the password |
| `PVE_FILES_ALLOW_NO_AUTH` | `0` | Set to `1` to run with no authentication at all. Only on a host nobody else can reach |

## Next improvements

- Multiple user accounts and per-user permissions
- Rename and move
- Drag-and-drop upload progress
- Chunked uploads for very large files
- File previews
- Share links with expiration

## License

MIT, see [LICENSE](LICENSE).
