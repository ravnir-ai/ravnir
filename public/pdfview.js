/* PDFs inside the app, drawn with pdf.js (/vendor/pdf.mjs). The bytes are fetched with the app's own
   sign-in, so this works in the home-screen app, where a new Safari tab has no cookie and gets a 401.
   Also the Share button the home-screen app uses in place of Download: Save to Files, Books, Mail.
   window.RavnirPdf = { render, openFile, share, standalone, isPdf } */
(function () {
  "use strict";

  let library = null;
  function load() {
    if (!library) {
      library = import("/vendor/pdf.mjs").then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
        return pdfjs;
      });
      library.catch(() => { library = null; });
    }
    return library;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Installed on the home screen (iOS sets navigator.standalone, others the display mode).
  function standalone() {
    return navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  function isPdf(type, name) {
    return /^application\/pdf$/i.test(type || "") || /\.pdf$/i.test(name || "");
  }

  async function fetchBytes(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(res.status === 401 ? "Sign in again to open this file." : `Could not load the file (${res.status}).`);
    return res;
  }

  // Draws every page into box, each at the box's width, as it scrolls into view.
  // Returns a function that stops the work (call it when the viewer closes).
  function render(box, url) {
    let stopped = false;
    let doc = null;
    let observer = null;
    box.replaceChildren(el("div", "pdf-status", "Loading PDF…"));
    box.classList.add("pdf-stage");
    (async () => {
      try {
        const [pdfjs, res] = await Promise.all([load(), fetchBytes(url)]);
        const data = new Uint8Array(await res.arrayBuffer());
        if (stopped) return;
        doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        if (stopped) return;
        box.replaceChildren();
        const width = Math.max(240, Math.min(box.clientWidth - 24, 1000));
        const first = await doc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        const scale = width / base.width;
        const pages = [];
        for (let number = 1; number <= doc.numPages; number += 1) {
          const page = el("div", "pdf-page");
          page.dataset.page = String(number);
          page.style.width = `${Math.round(width)}px`;
          page.style.aspectRatio = `${base.width} / ${base.height}`;
          page.setAttribute("aria-label", `Page ${number} of ${doc.numPages}`);
          box.append(page);
          pages.push(page);
        }
        const draw = async (page) => {
          if (page.dataset.drawn || stopped) return;
          page.dataset.drawn = "1";
          const pdfPage = await doc.getPage(Number(page.dataset.page));
          const viewport = pdfPage.getViewport({ scale });
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          page.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          await pdfPage.render({ canvasContext: canvas.getContext("2d"), canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
          if (!stopped) page.append(canvas);
        };
        if ("IntersectionObserver" in window) {
          observer = new IntersectionObserver((entries) => {
            for (const entry of entries) if (entry.isIntersecting) draw(entry.target).catch(() => {});
          }, { root: box, rootMargin: "600px 0px" });
          pages.forEach((page) => observer.observe(page));
        } else {
          for (const page of pages) await draw(page);
        }
      } catch (error) {
        if (!stopped) box.replaceChildren(el("div", "pdf-status", error?.message?.startsWith("Could not") || error?.message?.startsWith("Sign in") ? error.message : "This PDF could not be shown. Download it instead."));
      }
    })();
    return () => {
      stopped = true;
      observer?.disconnect();
      doc?.destroy?.();
    };
  }

  // The share sheet with the file itself, where the browser can share files; else a normal download.
  async function share(url, name, type) {
    const res = await fetchBytes(url);
    const blob = await res.blob();
    const file = new File([blob], name || "file", { type: type || blob.type || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name || "" });
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
      }
      return;
    }
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = name || "";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  }

  // A file (an upload) in the same viewer the saved files use: pages, Share or Download, Close.
  function openFile(url, name) {
    const dialog = el("dialog", "art-viewer");
    const shell = el("div", "art-viewer-card");
    const bar = el("div", "art-bar");
    const titleWrap = el("div", "art-bar-title");
    titleWrap.append(el("div", "art-bar-name", name || "PDF"), el("div", "art-bar-kind", "PDF"));
    const controls = el("div", "art-controls");
    const keep = el("button", "ghost", standalone() ? "Share" : "Download");
    keep.type = "button";
    keep.addEventListener("click", () => {
      share(url, name, "application/pdf").catch((error) => window.RavnirHost?.toast?.(error.message || "Could not share the file."));
    });
    const close = el("button", "ghost art-close", "Close");
    close.type = "button";
    controls.append(keep, close);
    bar.append(titleWrap, controls);
    const body = el("div", "art-body");
    shell.append(bar, body);
    dialog.append(shell);
    document.body.append(dialog);
    let stop = () => {};
    const done = () => { stop(); dialog.remove(); };
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", done);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.showModal();
    stop = render(body, url);
  }

  window.RavnirPdf = { render, openFile, share, standalone, isPdf };
})();
