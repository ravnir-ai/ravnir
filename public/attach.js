// Attachments in the composer: pick, paste or drop photos and files. Each one uploads right away
// to the open agent's workspace (server/uploads.js) and waits in a tray above the text; sending
// hands their ids to the message. Also draws attachments under the user's bubbles in the thread.
// Uses window.RavnirHost from app.js. No other dependencies.
(() => {
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_FILES = 10;
  const PHOTOS = /^image\/(png|jpe?g|gif|webp)$/;
  const FILE_ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5z"></path><path d="M11.5 2.5V6H15"></path></svg>';
  const items = [];
  let ownerBot = "";
  let serial = 0;
  let ui = null;

  const host = () => window.RavnirHost || { bot: () => null, toast: () => {} };
  const toast = (text) => host().toast(text, "error");

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function uploadUrl(botId, id) {
    return `/api/bots/${encodeURIComponent(botId)}/uploads/${String(id).split("/").map(encodeURIComponent).join("/")}`;
  }

  function add(fileList) {
    const bot = host().bot();
    if (!bot) return;
    if (ownerBot && ownerBot !== bot.id) clear();
    ownerBot = bot.id;
    for (const file of Array.from(fileList || [])) {
      if (items.length >= MAX_FILES) {
        toast(`Up to ${MAX_FILES} files per message.`);
        break;
      }
      if (file.size > MAX_BYTES) {
        toast(`${file.name} is over ${MAX_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      if (!file.size) continue;
      const item = {
        key: `f${(serial += 1)}`,
        file,
        name: file.name || "file",
        size: file.size,
        type: file.type || "",
        status: "up",
        id: "",
        preview: PHOTOS.test(file.type) ? URL.createObjectURL(file) : "",
      };
      item.promise = upload(bot.id, item);
      items.push(item);
    }
    render();
  }

  async function upload(botId, item) {
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/uploads`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": item.type || "application/octet-stream", "x-file-name": encodeURIComponent(item.name) },
        body: item.file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Could not upload ${item.name}.`);
      Object.assign(item, { id: data.id, name: data.name, type: data.type, size: data.size, status: "ok" });
    } catch (error) {
      item.status = "bad";
      if (items.includes(item)) toast(error.message || `Could not upload ${item.name}.`);
    }
    render();
  }

  function remove(key) {
    const index = items.findIndex((item) => item.key === key);
    if (index < 0) return;
    const [item] = items.splice(index, 1);
    if (item.preview) URL.revokeObjectURL(item.preview);
    render();
    ui.input.focus();
  }

  function render() {
    if (!ui) return;
    ui.tray.replaceChildren(...items.map((item) => {
      const card = el("div", `att${item.preview ? " photo" : ""}${item.status === "up" ? " up" : ""}${item.status === "bad" ? " bad" : ""}`);
      card.title = `${item.name} · ${sizeLabel(item.size)}`;
      if (item.preview) {
        const image = el("img");
        image.src = item.preview;
        image.alt = item.name;
        card.append(image);
      } else {
        const icon = el("span", "att-icon");
        icon.innerHTML = FILE_ICON;
        const copy = el("span", "att-copy");
        copy.append(el("span", "att-name", item.name), el("span", "att-size", item.status === "bad" ? "Did not upload" : sizeLabel(item.size)));
        card.append(icon, copy);
      }
      if (item.status === "up") card.append(el("span", "att-spin"));
      const close = el("button", "att-remove", "×");
      close.type = "button";
      close.setAttribute("aria-label", `Remove ${item.name}`);
      close.addEventListener("click", () => remove(item.key));
      card.append(close);
      return card;
    }));
    ui.tray.hidden = !items.length;
    ui.composer.classList.toggle("has-files", items.length > 0);
  }

  // For sendMessage: waits for uploads still running. Null means something failed and the send stops.
  async function take() {
    if (!items.length) return { ids: [], list: [] };
    await Promise.all(items.map((item) => item.promise));
    if (items.some((item) => item.status !== "ok")) {
      toast("A file did not upload. Remove it or attach it again.");
      return null;
    }
    return { ids: items.map((item) => item.id), list: items.map(({ id, name, type, size, preview }) => ({ id, name, type, size, preview })) };
  }

  // After a send the tray empties; previews stay alive for the bubble that is still sending.
  function clear() {
    items.length = 0;
    render();
  }

  // Files live in one agent's workspace, so switching agents drops what was waiting.
  function switchBot(id) {
    if (ownerBot && id !== ownerBot && items.length) clear();
    ownerBot = id || "";
  }

  // Under a user bubble: photos as thumbnails, other files as chips that download.
  function block(list, botId) {
    const wrap = el("div", "msg-files");
    const photos = list.filter((item) => PHOTOS.test(item.type));
    const files = list.filter((item) => !PHOTOS.test(item.type));
    if (photos.length) {
      const grid = el("div", `msg-photos${photos.length > 1 ? " many" : ""}`);
      for (const item of photos) {
        const link = el("a", "msg-photo");
        const url = item.id ? uploadUrl(botId, item.id) : "";
        if (url) {
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
        }
        const image = el("img");
        image.src = item.preview || url;
        image.alt = item.name;
        image.loading = "lazy";
        link.append(image);
        grid.append(link);
      }
      wrap.append(grid);
    }
    for (const item of files) {
      const link = el("a", "msg-file");
      if (item.id) {
        const url = uploadUrl(botId, item.id);
        link.href = url;
        link.setAttribute("download", item.name);
        // A PDF opens in the app (a download in the home-screen app opens Safari, which has no sign-in).
        if (window.RavnirPdf && RavnirPdf.isPdf(item.type, item.name)) {
          link.addEventListener("click", (event) => {
            event.preventDefault();
            RavnirPdf.openFile(url, item.name);
          });
        }
      }
      const icon = el("span", "att-icon");
      icon.innerHTML = FILE_ICON;
      const copy = el("span", "att-copy");
      copy.append(el("span", "att-name", item.name), el("span", "att-size", sizeLabel(item.size || 0)));
      link.append(icon, copy);
      wrap.append(link);
    }
    return wrap;
  }

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  }

  function bind() {
    ui = {
      composer: document.getElementById("composer"),
      tray: document.getElementById("attach-tray"),
      button: document.getElementById("attach-btn"),
      picker: document.getElementById("attach-input"),
      input: document.getElementById("composer-input"),
      thread: document.getElementById("thread"),
    };
    if (!ui.composer || !ui.tray || !ui.button || !ui.picker) return;
    ui.button.addEventListener("click", () => ui.picker.click());
    ui.picker.addEventListener("change", () => {
      add(ui.picker.files);
      ui.picker.value = "";
    });
    // Pasting a screenshot attaches it; pasted text still goes in the box.
    ui.input.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return;
      event.preventDefault();
      add(files);
    });
    let depth = 0;
    const done = () => {
      depth = 0;
      ui.composer.classList.remove("dropping");
    };
    ui.thread.addEventListener("dragenter", (event) => {
      if (!hasFiles(event) || ui.composer.hidden) return;
      depth += 1;
      ui.composer.classList.add("dropping");
    });
    ui.thread.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || ui.composer.hidden) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    ui.thread.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) done();
    });
    ui.thread.addEventListener("drop", (event) => {
      if (!hasFiles(event) || ui.composer.hidden) return;
      event.preventDefault();
      done();
      add(event.dataTransfer.files);
    });
    render();
  }

  window.RavnirAttach = { take, clear, switchBot, block, has: () => items.length > 0 };
  bind();
})();
