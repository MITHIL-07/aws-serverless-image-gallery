(function () {
  "use strict";

  // API_URL comes from config.js (local testing) or is generated on Vercel from the API_URL env variable
  const config = window.GALLERY_CONFIG || {};
  const API_URL = String(config.API_URL || "").trim().replace(/\/+$/, "");

  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const MAX_BYTES = 5 * 1024 * 1024;
  const STALE_AFTER_MS = 20 * 60 * 1000; // reload links that may have expired (no-CloudFront mode)
  const SKELETON_COUNT = 6;
  const TOKEN_STORAGE_KEY = "gallery.deleteTokens";

  const TRASH_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  const $ = (id) => document.getElementById(id);
  const dropzone = $("dropzone");
  const fileInput = $("file-input");
  const dropHint = $("drop-hint");
  const preview = $("preview");
  const titleInput = $("title-input");
  const uploadBtn = $("upload-btn");
  const progressWrap = $("progress-wrap");
  const progressBar = $("progress-bar");
  const progressText = $("progress-text");
  const uploadStatus = $("upload-status");
  const galleryStatus = $("gallery-status");
  const diagnostics = $("diagnostics");
  const diagnosticsText = $("diagnostics-text");
  const gallery = $("gallery");
  const countLabel = $("count");
  const refreshBtn = $("refresh-btn");
  const lightbox = $("lightbox");
  const lightboxImg = $("lightbox-img");
  const lightboxCaption = $("lightbox-caption");
  const lightboxCounter = $("lightbox-counter");
  const lightboxPrev = $("lightbox-prev");
  const lightboxNext = $("lightbox-next");
  const lightboxDelete = $("lightbox-delete");
  const confirmDialog = $("confirm-dialog");
  const confirmText = $("confirm-text");
  const confirmCancel = $("confirm-cancel");
  const confirmDeleteBtn = $("confirm-delete");

  let selectedFile = null;
  let previewUrl = null;
  let busy = false;
  let loading = false;
  let deleting = false;
  let images = [];
  let lastLoadedAt = 0;
  let autoRetried = false;
  let currentIndex = -1;

  // ---------------------------------------------------------------
  // Delete tokens
  // When you upload an image, the server gives this browser a secret token.
  // Only a browser that holds the token can delete that image.
  // ---------------------------------------------------------------
  const memoryTokens = {}; // used if the browser blocks localStorage

  function readTokens() {
    try {
      const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeTokens(tokens) {
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    } catch (_) {
      // Storage unavailable (private mode?): the in-memory copy still works for this visit
    }
  }

  function saveToken(id, token) {
    if (!id || !token) return;
    memoryTokens[id] = token;
    const tokens = readTokens();
    tokens[id] = token;
    writeTokens(tokens);
  }

  function getToken(id) {
    return memoryTokens[id] || readTokens()[id] || "";
  }

  function removeToken(id) {
    delete memoryTokens[id];
    const tokens = readTokens();
    delete tokens[id];
    writeTokens(tokens);
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function setStatus(el, type, text) {
    el.className = "status" + (type ? " " + type : "");
    el.textContent = text || "";
  }

  function apiConfigured() {
    return API_URL !== "" && !API_URL.includes("YOUR-API-ID");
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status; // 0 means "no response at all" (network or CORS)
    }
  }

  async function api(path, options) {
    const opts = options || {};
    const init = { method: opts.method || "GET", cache: "no-store" };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }

    let response;
    try {
      response = await fetch(API_URL + path, init);
    } catch (error) {
      throw new ApiError((error && error.message) || "Request was blocked", 0);
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // Not JSON: fall through to the generic message
    }
    if (!response.ok) {
      throw new ApiError(data.message || response.statusText || "Request failed", response.status);
    }
    return data;
  }

  // Turn technical errors into messages a student can act on
  function friendlyError(error) {
    const status = error && error.status;
    const message = (error && error.message) || "";

    if (status === 0) {
      return (
        "Cannot reach the API. Check API_URL in config.js, and that API Gateway CORS allows " +
        location.origin +
        "."
      );
    }
    if (status === 404 && /^not found$/i.test(message)) {
      return "API route not found (404). Check the routes POST /upload-url, POST /confirm, GET /images and POST /delete.";
    }
    if (status === 403 && /^forbidden$/i.test(message)) {
      return "Access denied (403). Check the API URL and the API Gateway settings.";
    }
    if (status === 429) {
      return "Too many requests. Please wait a moment and try again.";
    }
    if (status >= 500) {
      return "Server error (" + status + "). Check the CloudWatch logs of the gallery-api Lambda function.";
    }
    return message || "Something went wrong. Please try again.";
  }

  function showDiagnostics(error, request) {
    diagnostics.hidden = false;
    diagnosticsText.textContent = [
      "Page origin : " + location.origin,
      "API URL     : " + (API_URL || "(not set)"),
      "Request     : " + request,
      "HTTP status : " + (error.status === 0 ? "no response (network or CORS)" : error.status),
      "Message     : " + error.message,
      "Time        : " + new Date().toISOString(),
    ].join("\n");
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function showProgress(percent) {
    progressWrap.hidden = false;
    progressBar.style.width = percent + "%";
    progressBar.parentElement.setAttribute("aria-valuenow", String(percent));
    progressText.textContent = percent + "%";
  }

  function hideProgress() {
    progressWrap.hidden = true;
    progressBar.style.width = "0%";
    progressText.textContent = "0%";
  }

  function setBusy(isBusy) {
    busy = isBusy;
    uploadBtn.disabled = isBusy || !selectedFile;
    uploadBtn.textContent = isBusy ? "Uploading..." : "Upload";
    titleInput.disabled = isBusy;
  }

  // ---------------------------------------------------------------
  // File selection
  // ---------------------------------------------------------------
  function clearSelection() {
    selectedFile = null;
    fileInput.value = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    preview.hidden = true;
    preview.removeAttribute("src");
    dropHint.hidden = false;
    uploadBtn.disabled = true;
  }

  function selectFile(file) {
    setStatus(uploadStatus, "", "");
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      clearSelection();
      setStatus(uploadStatus, "error", "Only JPG, PNG, WEBP and GIF images are allowed.");
      return;
    }
    if (file.size > MAX_BYTES) {
      clearSelection();
      setStatus(uploadStatus, "error", "Image must be smaller than 5 MB.");
      return;
    }

    selectedFile = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
    dropHint.hidden = true;
    uploadBtn.disabled = busy;
  }

  dropzone.addEventListener("click", () => {
    if (!busy) fileInput.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !busy) {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));

  ["dragenter", "dragover"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (event) => {
    if (busy) return;
    selectFile(event.dataTransfer && event.dataTransfer.files[0]);
  });

  // ---------------------------------------------------------------
  // Upload straight to S3 with the pre-signed POST (XHR gives progress events)
  // ---------------------------------------------------------------
  function s3ErrorMessage(text) {
    if (text.includes("EntityTooLarge")) return "Image is too large.";
    if (text.includes("Policy Condition failed")) return "Image type or size is not allowed.";
    if (text.includes("AccessDenied") || text.includes("SignatureDoesNotMatch")) {
      return "Upload was not permitted. Check the Lambda role permissions and bucket name, then try again.";
    }
    if (text.includes("ExpiredToken") || text.includes("expired")) {
      return "Upload link expired. Please try again.";
    }
    return "Upload failed. Please try again.";
  }

  function uploadToS3(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      Object.entries(upload.fields).forEach(([key, value]) => form.append(key, value));
      form.append("file", file); // the file field must be last

      const xhr = new XMLHttpRequest();
      xhr.open("POST", upload.url);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(s3ErrorMessage(xhr.responseText || "")));
      };
      xhr.onerror = () =>
        reject(new Error("Upload to S3 failed. Check your connection and the S3 bucket CORS settings."));
      xhr.send(form);
    });
  }

  async function handleUpload() {
    if (!selectedFile || busy) return;
    if (!apiConfigured()) {
      setStatus(uploadStatus, "error", "API URL is not configured. See config.example.js.");
      return;
    }

    setBusy(true);
    hideProgress();

    try {
      setStatus(uploadStatus, "info", "Requesting upload permission...");
      const permission = await api("/upload-url", {
        method: "POST",
        body: {
          contentType: selectedFile.type,
          size: selectedFile.size,
          title: titleInput.value.trim(),
        },
      });

      setStatus(uploadStatus, "info", "Uploading image...");
      showProgress(0);
      await uploadToS3(permission.upload, selectedFile, showProgress);

      setStatus(uploadStatus, "info", "Finishing up...");
      const result = await api("/confirm", { method: "POST", body: { id: permission.id } });

      // Keep the secret that allows THIS browser to delete the image later
      saveToken(permission.id, permission.deleteToken);

      images.unshift(result.image);
      lastLoadedAt = Date.now();
      renderGallery();
      setStatus(uploadStatus, "success", "Upload complete! Your image is in the gallery.");
      titleInput.value = "";
      clearSelection();
    } catch (error) {
      console.error("Upload failed:", error);
      setStatus(uploadStatus, "error", friendlyError(error));
    } finally {
      hideProgress();
      setBusy(false);
    }
  }

  uploadBtn.addEventListener("click", handleUpload);

  // ---------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------
  function confirmDelete(image) {
    return new Promise((resolve) => {
      confirmText.textContent = image.title
        ? '"' + image.title + '" will be removed permanently.'
        : "This image will be removed permanently.";

      let confirmed = false;
      const onCancel = () => confirmDialog.close();
      const onConfirm = () => {
        confirmed = true;
        confirmDialog.close();
      };
      confirmCancel.addEventListener("click", onCancel);
      confirmDeleteBtn.addEventListener("click", onConfirm);
      confirmDialog.addEventListener(
        "close",
        () => {
          confirmCancel.removeEventListener("click", onCancel);
          confirmDeleteBtn.removeEventListener("click", onConfirm);
          resolve(confirmed);
        },
        { once: true }
      );
      confirmDialog.showModal();
      confirmCancel.focus();
    });
  }

  confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) confirmDialog.close(); // click on the dark backdrop
  });

  function setTileDeleting(id, isDeleting) {
    gallery.querySelectorAll(".tile").forEach((tile) => {
      if (tile.dataset.id === id) tile.classList.toggle("deleting", isDeleting);
    });
  }

  async function deleteImage(image) {
    if (deleting) return;
    const token = getToken(image.id);
    if (!token) return;

    const confirmed = await confirmDelete(image);
    if (!confirmed) return;

    deleting = true;
    setTileDeleting(image.id, true);
    lightboxDelete.disabled = true;

    try {
      await api("/delete", { method: "POST", body: { id: image.id, deleteToken: token } });

      removeToken(image.id);
      images = images.filter((item) => item.id !== image.id);
      if (lightbox.open) lightbox.close();
      renderGallery();
      setStatus(
        galleryStatus,
        "success",
        images.length ? "Image deleted." : "Image deleted. The gallery is now empty."
      );
    } catch (error) {
      console.error("Delete failed:", error);
      setTileDeleting(image.id, false);

      if (error.status === 404) {
        // Already gone (for example deleted from another tab): just remove it from the page
        removeToken(image.id);
        images = images.filter((item) => item.id !== image.id);
        if (lightbox.open) lightbox.close();
        renderGallery();
        setStatus(galleryStatus, "info", "That image was already deleted.");
      } else if (error.status === 403) {
        // This browser's token is not valid for the image: stop offering the button
        removeToken(image.id);
        if (lightbox.open) lightbox.close();
        renderGallery();
        setStatus(galleryStatus, "error", friendlyError(error));
      } else {
        setStatus(galleryStatus, "error", friendlyError(error));
      }
    } finally {
      deleting = false;
      lightboxDelete.disabled = false;
    }
  }

  lightboxDelete.addEventListener("click", () => {
    const image = images[currentIndex];
    if (image) deleteImage(image);
  });

  // ---------------------------------------------------------------
  // Gallery
  // ---------------------------------------------------------------
  function showSkeleton() {
    gallery.replaceChildren();
    for (let i = 0; i < SKELETON_COUNT; i += 1) {
      const tile = document.createElement("div");
      tile.className = "tile skeleton";
      tile.setAttribute("aria-hidden", "true");
      gallery.appendChild(tile);
    }
  }

  // An image can fail if its temporary link expired or the image address is wrong
  function handleBrokenImage(figure, img) {
    const placeholder = document.createElement("div");
    placeholder.className = "broken";
    placeholder.textContent = "Image unavailable";
    img.replaceWith(placeholder);
    figure.dataset.broken = "1";

    if (!autoRetried) {
      autoRetried = true; // retry once, so a bad address cannot cause an endless loop
      setTimeout(() => loadGallery({ quiet: true }), 600);
    }
  }

  function buildDeleteButton(image) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tile-delete";
    button.setAttribute("aria-label", "Delete " + (image.title || "image"));
    button.title = "Delete";
    button.innerHTML = TRASH_ICON; // static icon markup, no user data
    button.addEventListener("click", () => deleteImage(image));
    return button;
  }

  function buildTile(image, index) {
    const figure = document.createElement("figure");
    figure.className = "tile";
    figure.dataset.id = image.id;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "tile-open";
    openButton.setAttribute("aria-label", "Open " + (image.title || "image"));

    const img = document.createElement("img");
    img.alt = image.title || "Uploaded image";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => handleBrokenImage(figure, img));
    img.src = image.url;
    openButton.appendChild(img);
    openButton.addEventListener("click", () => {
      if (figure.dataset.broken) return;
      openLightbox(index);
    });

    const caption = document.createElement("figcaption");
    const title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = image.title || "Untitled";
    const date = document.createElement("div");
    date.className = "tile-date";
    date.textContent = formatDate(image.createdAt);
    caption.append(title, date);

    figure.append(openButton, caption);

    // Only images uploaded from this browser get a delete button
    if (getToken(image.id)) figure.appendChild(buildDeleteButton(image));

    return figure;
  }

  function renderGallery() {
    gallery.replaceChildren();
    diagnostics.hidden = true;
    countLabel.textContent = images.length ? "(" + images.length + ")" : "";

    if (images.length === 0) {
      setStatus(galleryStatus, "info", "No images yet. Upload the first one!");
      return;
    }
    setStatus(galleryStatus, "", "");
    images.forEach((image, index) => gallery.appendChild(buildTile(image, index)));
  }

  async function loadGallery(options) {
    const quiet = Boolean(options && options.quiet);
    if (loading) return;

    if (!apiConfigured()) {
      gallery.replaceChildren();
      setStatus(
        galleryStatus,
        "error",
        "API URL is not configured. Create config.js from config.example.js (local) or set API_URL (Vercel)."
      );
      return;
    }

    loading = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
    if (!quiet) {
      autoRetried = false;
      setStatus(galleryStatus, "info", "Loading gallery...");
      showSkeleton();
    }

    try {
      const data = await api("/images");
      images = Array.isArray(data.images) ? data.images : [];
      lastLoadedAt = Date.now();
      renderGallery();
    } catch (error) {
      console.error("Could not load the gallery:", error);
      if (!quiet) {
        gallery.replaceChildren();
        setStatus(galleryStatus, "error", friendlyError(error) + " Then press Refresh.");
        showDiagnostics(error, "GET " + API_URL + "/images");
      }
    } finally {
      loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  }

  refreshBtn.addEventListener("click", () => loadGallery());

  // Links can expire when the tab stays open for a long time, so refresh when the user comes back
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      lastLoadedAt &&
      Date.now() - lastLoadedAt > STALE_AFTER_MS &&
      !busy &&
      !deleting
    ) {
      loadGallery({ quiet: true });
    }
  });

  // ---------------------------------------------------------------
  // Lightbox (previous / next, arrow keys, swipe, delete)
  // ---------------------------------------------------------------
  function updateLightbox() {
    const image = images[currentIndex];
    if (!image) return;
    lightboxImg.src = image.url;
    lightboxImg.alt = image.title || "Uploaded image";
    lightboxCaption.textContent = image.title || "Untitled";
    lightboxCounter.textContent = currentIndex + 1 + " / " + images.length;
    const single = images.length < 2;
    lightboxPrev.hidden = single;
    lightboxNext.hidden = single;
    lightboxDelete.hidden = !getToken(image.id); // only for your own images
  }

  function openLightbox(index) {
    currentIndex = index;
    updateLightbox();
    if (!lightbox.open) lightbox.showModal();
  }

  function stepLightbox(delta) {
    if (images.length < 2) return;
    currentIndex = (currentIndex + delta + images.length) % images.length;
    updateLightbox();
  }

  lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  lightboxNext.addEventListener("click", () => stepLightbox(1));
  $("lightbox-close").addEventListener("click", () => lightbox.close());

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close(); // click on the dark backdrop
  });
  lightbox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepLightbox(-1);
    if (event.key === "ArrowRight") stepLightbox(1);
  });
  lightbox.addEventListener("close", () => lightboxImg.removeAttribute("src"));

  let touchStartX = null;
  lightboxImg.addEventListener(
    "touchstart",
    (event) => {
      touchStartX = event.changedTouches[0].clientX;
    },
    { passive: true }
  );
  lightboxImg.addEventListener(
    "touchend",
    (event) => {
      if (touchStartX === null) return;
      const dx = event.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );

  // ---------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------
  loadGallery();
})();
