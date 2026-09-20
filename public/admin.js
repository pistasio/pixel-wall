import { api } from './api-config.js';

(() => {
  const SIZE = 25;
  const PAGE_SIZE = 24;
  const elements = Object.fromEntries([
    "access-panel", "access-form", "access-key", "access-error", "connect-button",
    "submissions-panel", "collection-count", "refresh-button", "disconnect-button",
    "collection-error", "collection-error-message", "retry-button", "empty-state",
    "artwork-list", "load-more-button", "status",
  ].map((id) => [id, document.getElementById(id)]));

  if (!api.available) {
    document.getElementById('access-description').textContent = api.message;
    document.getElementById('key-note').textContent = 'Organizer access is unavailable until submissions are connected.';
    elements['access-key'].disabled = true;
    elements['connect-button'].disabled = true;
    elements['access-form'].addEventListener('submit', (event) => event.preventDefault());
    return;
  }

  let accessKey = "";
  let authenticated = false;
  let loading = false;
  let offset = 0;
  let total = 0;
  let hasMore = false;
  let requestId = 0;
  let controller = null;
  let lastAppend = false;
  const renderedIds = new Set();

  function setBusy(busy) {
    loading = busy;
    elements["access-form"].setAttribute("aria-busy", String(busy));
    elements["submissions-panel"].setAttribute("aria-busy", String(busy));
    for (const id of ["connect-button", "access-key", "refresh-button", "load-more-button", "retry-button"]) {
      elements[id].disabled = busy;
    }
    elements["connect-button"].firstChild.textContent = busy ? "Opening… " : "Open submissions ";
    elements["load-more-button"].textContent = busy && lastAppend ? "Loading…" : "Load more artwork";
  }

  function clearError() {
    elements["access-error"].hidden = true;
    elements["collection-error"].hidden = true;
    elements["access-key"].removeAttribute("aria-invalid");
  }

  function showError(message, keyRejected = false) {
    if (authenticated) {
      elements["collection-error-message"].textContent = message;
      elements["collection-error"].hidden = false;
    } else {
      elements["access-error"].textContent = message;
      elements["access-error"].hidden = false;
      if (keyRejected) elements["access-key"].setAttribute("aria-invalid", "true");
    }
  }

  function lockView(message = "", preserveInput = false) {
    requestId += 1;
    if (controller) controller.abort();
    controller = null;
    accessKey = "";
    authenticated = false;
    offset = 0;
    total = 0;
    hasMore = false;
    renderedIds.clear();
    elements["artwork-list"].replaceChildren();
    elements["submissions-panel"].hidden = true;
    elements["access-panel"].hidden = false;
    if (!preserveInput) elements["access-key"].value = "";
    elements["status"].textContent = "";
    clearError();
    setBusy(false);
    if (message) showError(message, true);
    elements["access-key"].focus();
  }

  function createArtworkCard(submission) {
    const name = typeof submission.name === "string" && submission.name.trim() ? submission.name : "Anonymous artist";
    const card = document.createElement("article");
    card.className = "artwork-card";
    const frame = document.createElement("div");
    frame.className = "artwork-frame";
    const canvas = document.createElement("canvas");
    canvas.width = 500;
    canvas.height = 500;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `25 by 25 pixel artwork by ${name}`);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    const scale = canvas.width / SIZE;
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        const color = submission.grid?.[row]?.[column];
        context.fillStyle = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff";
        context.fillRect(column * scale, row * scale, scale, scale);
      }
    }
    frame.append(canvas);
    const title = document.createElement("h3");
    title.textContent = name;
    const timestamp = document.createElement("time");
    const date = new Date(submission.createdAt);
    if (!Number.isNaN(date.getTime())) {
      timestamp.dateTime = date.toISOString();
      timestamp.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    } else {
      timestamp.textContent = "Submission time unavailable";
    }
    card.append(frame, title, timestamp);
    if (typeof submission.studentId === "string" && submission.studentId.trim()) {
      const studentId = document.createElement("p");
      studentId.className = "student-id";
      studentId.textContent = `Club / student ID: ${submission.studentId}`;
      card.append(studentId);
    }
    return card;
  }

  async function loadSubmissions(append = false) {
    if (loading || !accessKey) return;
    lastAppend = append;
    clearError();
    setBusy(true);
    elements["status"].textContent = append ? "Loading more artwork…" : "Loading submissions…";
    const currentRequest = ++requestId;
    const currentController = new AbortController();
    controller = currentController;
    let focusCollection = false;
    const timeout = window.setTimeout(() => currentController.abort(), 15000);
    try {
      const response = await fetch(api.url(`/api/submissions?limit=${PAGE_SIZE}&offset=${append ? offset : 0}`), {
        headers: { "X-Admin-Key": accessKey, "Accept": "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: currentController.signal,
      });
      if (currentRequest !== requestId) return;
      if (response.status === 401 || response.status === 403) {
        const wasAuthenticated = authenticated;
        lockView(wasAuthenticated ? "Your access key was rejected. Enter the current organizer key to reconnect." : "That access key wasn’t accepted. Check it and try again.", !wasAuthenticated);
        return;
      }
      if (!response.ok) throw new Error(response.status === 429 ? "Too many requests. Wait a moment and try again." : "We couldn’t load submissions. Please try again.");
      const data = await response.json();
      if (currentRequest !== requestId) return;
      if (!Array.isArray(data.submissions) || !Number.isInteger(data.total) || data.total < 0) {
        throw new Error("We couldn’t read the submissions. Please try again.");
      }
      if (!append) {
        renderedIds.clear();
        elements["artwork-list"].replaceChildren();
        offset = 0;
      }
      const fragment = document.createDocumentFragment();
      for (const submission of data.submissions) {
        if (renderedIds.has(submission.id)) continue;
        fragment.append(createArtworkCard(submission));
        renderedIds.add(submission.id);
      }
      elements["artwork-list"].append(fragment);
      offset += data.submissions.length;
      total = data.total;
      hasMore = Boolean(data.hasMore) && data.submissions.length > 0;
      focusCollection = !authenticated;
      authenticated = true;
      elements["access-key"].value = "";
      elements["access-panel"].hidden = true;
      elements["submissions-panel"].hidden = false;
      elements["empty-state"].hidden = total !== 0;
      elements["load-more-button"].hidden = !hasMore;
      elements["collection-count"].textContent = total === 0 ? "Waiting for the first mark" : `${renderedIds.size} of ${total} ${total === 1 ? "artwork" : "artworks"} · newest first`;
      elements["status"].textContent = total === 0 ? "No submissions yet." : `${renderedIds.size} ${renderedIds.size === 1 ? "artwork" : "artworks"} loaded.`;
    } catch (error) {
      if (currentRequest !== requestId) return;
      const message = error.name === "AbortError" ? "The connection took too long. Please try again." : error instanceof TypeError ? "Couldn’t connect. Check your connection and try again." : error.message || "We couldn’t load submissions. Please try again.";
      showError(message);
      elements["status"].textContent = "";
    } finally {
      window.clearTimeout(timeout);
      if (currentRequest === requestId) {
        controller = null;
        setBusy(false);
        if (focusCollection) elements["refresh-button"].focus();
      }
    }
  }

  elements["access-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    if (loading) return;
    accessKey = elements["access-key"].value.trim();
    if (!accessKey) {
      showError("Enter your organizer access key.", true);
      elements["access-key"].focus();
      return;
    }
    loadSubmissions();
  });
  elements["access-key"].addEventListener("input", clearError);
  elements["refresh-button"].addEventListener("click", () => loadSubmissions());
  elements["load-more-button"].addEventListener("click", () => loadSubmissions(true));
  elements["retry-button"].addEventListener("click", () => loadSubmissions(lastAppend));
  elements["disconnect-button"].addEventListener("click", () => lockView());
  window.addEventListener("pagehide", () => {
    accessKey = "";
    elements["access-key"].value = "";
    if (controller) controller.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) lockView();
  });
  // Enable entry only after the submit handler is installed and configuration is valid.
  elements["access-key"].disabled = false;
  elements["connect-button"].disabled = false;
})();
