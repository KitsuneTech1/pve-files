const state = {
  currentDir: "",
  entries: []
};

const elements = {
  breadcrumbs: document.getElementById("breadcrumbs"),
  fileInput: document.getElementById("file-input"),
  fileList: document.getElementById("file-list"),
  newFolderButton: document.getElementById("new-folder-button"),
  refreshButton: document.getElementById("refresh-button"),
  status: document.getElementById("status"),
  template: document.getElementById("item-template")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

async function api(pathname, options = {}) {
  const response = await fetch(pathname, options);
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response;
  }

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

function renderBreadcrumbs(breadcrumbs) {
  elements.breadcrumbs.replaceChildren();

  for (const crumb of breadcrumbs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "crumb";
    button.textContent = crumb.name;
    button.addEventListener("click", () => loadDirectory(crumb.path));

    if (crumb.path === state.currentDir) {
      button.classList.add("active");
    }

    elements.breadcrumbs.appendChild(button);
  }
}

// The API refuses to delete a folder that still has anything in it unless the
// caller asks for a recursive delete. Confirm a second time, then retry.
async function deleteEntry(entry) {
  const base = `/api/item?path=${encodeURIComponent(entry.path)}`;

  try {
    return await api(base, { method: "DELETE" });
  } catch (error) {
    if (!error.message.includes("not empty")) {
      throw error;
    }

    const confirmed = window.confirm(`"${entry.name}" is not empty. Delete it and everything inside it?`);

    if (!confirmed) {
      throw new Error("Delete cancelled.");
    }

    return api(`${base}&recursive=1`, { method: "DELETE" });
  }
}

function renderEntries(entries) {
  elements.fileList.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "This folder is empty.";
    elements.fileList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const fragment = elements.template.content.cloneNode(true);
    const row = fragment.querySelector(".file-row");
    const icon = fragment.querySelector(".file-icon");
    const link = fragment.querySelector(".file-link");
    const modified = fragment.querySelector(".file-modified");
    const size = fragment.querySelector(".file-size");
    const download = fragment.querySelector(".download-link");
    const deleteButton = fragment.querySelector(".delete-button");

    link.textContent = entry.name;
    modified.textContent = formatDate(entry.modifiedAt);
    size.textContent = entry.sizeLabel;

    if (entry.type === "directory") {
      icon.classList.add("directory");
      link.addEventListener("click", () => loadDirectory(entry.path));
      download.remove();
    } else {
      download.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      download.setAttribute("download", entry.name);
      link.addEventListener("click", () => window.location.href = download.href);
    }

    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete "${entry.name}"?`);

      if (!confirmed) {
        return;
      }

      try {
        setStatus(`Deleting ${entry.name}...`);
        await deleteEntry(entry);
        await loadDirectory(state.currentDir);
        setStatus(`Deleted ${entry.name}.`);
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    elements.fileList.appendChild(row);
  }
}

async function loadDirectory(dir = "") {
  try {
    setStatus("Loading...");
    const payload = await api(`/api/list?dir=${encodeURIComponent(dir)}`);
    state.currentDir = payload.currentDir;
    state.entries = payload.entries;
    renderBreadcrumbs(payload.breadcrumbs);
    renderEntries(payload.entries);
    setStatus(`Viewing ${payload.currentDir || "storage root"}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function uploadFiles(fileList) {
  if (!fileList.length) {
    return;
  }

  for (const file of fileList) {
    try {
      setStatus(`Uploading ${file.name}...`);
      await fetch(`/api/upload?dir=${encodeURIComponent(state.currentDir)}&name=${encodeURIComponent(file.name)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": file.name
        },
        body: file
      }).then(async (response) => {
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || `Upload failed for ${file.name}`);
        }
      });
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
  }

  await loadDirectory(state.currentDir);
  setStatus(`Uploaded ${fileList.length} file${fileList.length === 1 ? "" : "s"}.`);
}

elements.fileInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  await uploadFiles(files);
  event.target.value = "";
});

elements.newFolderButton.addEventListener("click", async () => {
  const name = window.prompt("Folder name:");

  if (!name) {
    return;
  }

  try {
    setStatus(`Creating ${name}...`);
    await api("/api/folder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dir: state.currentDir,
        name
      })
    });
    await loadDirectory(state.currentDir);
    setStatus(`Created ${name}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.refreshButton.addEventListener("click", () => {
  loadDirectory(state.currentDir);
});

loadDirectory();
