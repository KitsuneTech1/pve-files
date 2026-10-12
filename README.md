<p align="center"><a href="https://kitsunetechnologies.org/work"><img src="https://raw.githubusercontent.com/KitsuneTech1/.github/main/assets/kitsune-banner.svg" alt="Built by Kitsune Technologies" width="760"></a></p>

# pve-files

A web file browser for Proxmox host storage, with upload and download.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)

![Screenshot](docs/screenshot.png)

## What it does

- Browse folders under a configured storage root, with breadcrumbs
- Upload files into the current folder, with a size limit enforced mid-stream
- Download any file in the root
- Create a folder
- Delete a file or folder, behind authentication

A password is required on every route and the server refuses to start without one. Every path is resolved to its real location, symlinks included, and re-checked against the storage root before any read, write, or delete. Zero dependencies, Node standard library only. Run `npm test` to check those claims yourself.

## What you need

- **Node.js 18 or newer.** Check with `node -v`. Download it from [nodejs.org](https://nodejs.org), or on Debian/Ubuntu run `sudo apt install nodejs npm`. Built and tested on Node 25.2.1, CI covers 18, 20, and 22.
- **Git**, to clone the code. Check with `git --version`, or download a ZIP from the GitHub page instead.
- **A folder to browse.** Any path works. For the real use case, a Proxmox storage path bind-mounted into an LXC container. This app never talks to the Proxmox API, it reads and writes plain files at the path you give it, so the storage has to already be reachable as a folder.

## Install

1. Get the code:
   ```bash
   git clone https://github.com/KitsuneTech1/pve-files.git
   cd pve-files
   ```
   You should now see `server.js` and `package.json` in the folder.
2. Install dependencies. There are none beyond Node itself, so this fetches nothing:
   ```bash
   npm install
   ```
   Expect `up to date` or a line like `found 0 vulnerabilities`, and no red error text.
3. Confirm the build is sound:
   ```bash
   npm test
   ```
   Expect `# pass 14` and `# fail 0`.

## Use it

Start it against a folder, with a password of your choosing:

```bash
STORAGE_ROOT=/mnt/storage PVE_FILES_PASSWORD=changeme node server.js
```

On Windows PowerShell:

```powershell
$env:STORAGE_ROOT='Z:\proxmox-share'; $env:PVE_FILES_PASSWORD='changeme'; node server.js
```

You should see exactly three lines:

```
pve-files running on http://localhost:3000
Storage root: /mnt/storage
Authentication: on, user "admin"
```

Check that `Storage root:` is the folder you meant. If you leave `STORAGE_ROOT` out, it creates and uses a `storage/` folder next to `server.js`.

Open `http://localhost:3000` in a browser. It prompts for a username and password: `admin`, and whatever you set above. Pick a real password before you put this on a network.

## It worked if ...

- The page loads and the file list matches what `ls` shows on your storage path.
- You can create a folder, upload a small test file into it, and download that file back.
- A file you upload through the browser appears on the real storage, not just in the UI.
- Opening `http://localhost:3000` in a private window prompts for the password instead of showing the files.

## Troubleshooting

- **`Refusing to start without a password.`** on startup, and the process exits: set `PVE_FILES_PASSWORD`. This is deliberate. The tool exposes host storage over HTTP, delete included, so it will not run open unless you ask for that with `PVE_FILES_ALLOW_NO_AUTH=1`.
- **`{"error":"Path escapes storage root."}`** or `Resolved path escapes storage root.`: a requested path would land outside `STORAGE_ROOT`, so it was refused. This is the confinement check working, not a bug. Usually a stale link, a hand-typed URL, or a symlink in your storage pointing out of the root.
- **`{"error":"Folder is not empty. Pass recursive=1 to delete it and everything under it."}`**: the guard against wiping a tree from one request. The Delete button in the UI retries with `recursive=1` after you confirm. Over the API, add `&recursive=1` yourself.
- **`{"error":"Upload exceeds the 1 GB limit."}`**: the file is bigger than `MAX_UPLOAD_BYTES`, which defaults to `1073741824`. Raise it, in raw bytes, not MB. The partial file is removed, so nothing is left behind.
- **The page loads but the file list is always empty**: `STORAGE_ROOT` is pointing somewhere else, most likely the default `./storage`. Read the `Storage root:` line from startup and compare it to the path you mounted.

## Proxmox LXC setup

To browse real Proxmox storage, bind-mount it into a container. Run this on the Proxmox host, not inside the container, replacing `105` with your container ID and `/mnt/pve/your-storage` with the storage path from Datacenter > Storage:

```bash
pct set 105 -mp0 /mnt/pve/your-storage,mp=/mnt/storage
pct reboot 105
```

Inside the container, `ls /mnt/storage` should show the host's files. Then run the app there with `STORAGE_ROOT=/mnt/storage`.

### Keep it running with systemd

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
Environment=PVE_FILES_PASSWORD=YOUR_PASSWORD

[Install]
WantedBy=multi-user.target
```

Then `sudo chmod 600 /etc/systemd/system/pve-files.service` (it holds your password in plain text) and `sudo systemctl enable --now pve-files`.

## Config

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on |
| `STORAGE_ROOT` | `./storage` | Root directory the UI browses, uploads to, and downloads from |
| `MAX_UPLOAD_BYTES` | `1073741824` | Maximum size of a single upload, in bytes |
| `PVE_FILES_PASSWORD` | none | Password for every route. Required, the server exits if it is unset |
| `PVE_FILES_USER` | `admin` | Username that goes with the password |
| `PVE_FILES_ALLOW_NO_AUTH` | `0` | Set to `1` to run with no authentication. Only on a host nobody else can reach |

## Security notes

- **Basic auth sends the password on every request, base64 encoded, not encrypted.** On a LAN over plain HTTP that is usually fine. Over the internet, put it behind a reverse proxy with HTTPS, or reach it over a VPN. Do not port-forward it.
- **There is one account.** Anyone with the password can read, write, and delete anything under the storage root.
- **Uploads overwrite a file of the same name without warning.** No versioning, no undo.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Kitsune Technologies LLC.
