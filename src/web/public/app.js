(() => {
  const API = Object.freeze({
    capabilities: "/api/v1",
    overview: "/api/v1/overview",
    map: "/api/v1/graph",
    timeline: "/api/v1/timeline",
    health: "/api/v1/health",
    review: "/api/v1/review-workspace",
    reviewSession: "/api/v1/review-session",
    externalImportPreview: "/api/v1/external-import/preview",
    externalImportApply: "/api/v1/external-import/apply",
    proposals: "/api/v1/proposals?status=pending",
    search: "/api/v1/search",
  });

  const VIEW_META = Object.freeze({
    overview: { title: "Project overview", documentTitle: "Overview" },
    map: { title: "Project map", documentTitle: "Map" },
    timeline: { title: "Project timeline", documentTitle: "Timeline" },
    health: { title: "Context health", documentTitle: "Health" },
    review: { title: "Human review", documentTitle: "Review" },
  });

  const CURRENT_USE_STATUSES = new Set(["current", "stale", "conflicting", "removed", "unknown", "historical"]);
  const liveTextVersions = new WeakMap();

  const ICONS = Object.freeze({
    archive: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/></svg>',
    branch:
      '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 12h4a6 6 0 0 0 6-4"/></svg>',
    file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5"/></svg>',
    shield:
      '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 4.5 6v5c0 4.6 3.1 8.1 7.5 10 4.4-1.9 7.5-5.4 7.5-10V6z"/><path d="m9 12 2 2 4-5"/></svg>',
    source: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 12h8M12 8l4 4-4 4"/><path d="M5 5h14v14H5z"/></svg>',
    empty: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 12h6"/></svg>',
    error: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2.5 20h19zM12 9v5M12 17h.01"/></svg>',
    search: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg>',
    commit: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12h6M16 12h6"/><circle cx="12" cy="12" r="4"/></svg>',
  });

  const state = {
    currentView: "overview",
    cache: { overview: null, map: null, timeline: null, health: null, review: null },
    loading: new Set(),
    graph: {
      nodes: [],
      edges: [],
      positions: new Map(),
      visibleIds: new Set(),
      selectedId: null,
      query: "",
      zoom: 1,
      panX: 0,
      panY: 0,
      dragging: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0,
    },
    timeline: { query: "", type: "all", activeIndex: -1 },
    health: { filter: "all" },
    review: { sessionToken: null, sessionPromise: null, proposalId: null, action: null, submitting: false, returnFocus: null },
    sourceImport: { plan: null, payload: null, submitting: false, returnFocus: null, maximumSourceBytes: null, capabilitiesPromise: null },
    briefing: { step: 0 },
    searchController: null,
    searchTimer: null,
    searchActiveIndex: -1,
  };

  const dom = {
    viewTitle: document.querySelector("#view-title"),
    refresh: document.querySelector("#refresh-view"),
    syncTime: document.querySelector("#sync-time"),
    searchForm: document.querySelector("#global-search"),
    searchInput: document.querySelector("#global-search-input"),
    searchResults: document.querySelector("#search-results"),
    searchStatus: document.querySelector("#search-status"),
    toastRegion: document.querySelector("#toast-region"),
    appStatus: document.querySelector("#app-status"),
    shortcutDialog: document.querySelector("#shortcut-dialog"),
    briefingDialog: document.querySelector("#briefing-dialog"),
    briefingContent: document.querySelector("#briefing-content"),
    briefingStepLabel: document.querySelector("#briefing-step-label"),
    briefingProgress: document.querySelector("#briefing-progress-bar"),
    briefingPrevious: document.querySelector("#briefing-previous"),
    briefingNext: document.querySelector("#briefing-next"),
    reviewDialog: document.querySelector("#proposal-review-dialog"),
    reviewForm: document.querySelector("#proposal-review-form"),
    reviewKicker: document.querySelector("#proposal-review-kicker"),
    reviewTitle: document.querySelector("#proposal-review-title"),
    reviewPreview: document.querySelector("#proposal-review-preview"),
    reviewId: document.querySelector("#proposal-review-id"),
    reviewAction: document.querySelector("#proposal-review-action"),
    reviewActor: document.querySelector("#proposal-review-actor"),
    reviewRationale: document.querySelector("#proposal-review-rationale"),
    reviewError: document.querySelector("#proposal-review-error"),
    reviewSubmit: document.querySelector("#proposal-review-submit"),
    sourceImportDialog: document.querySelector("#source-import-dialog"),
    sourceImportForm: document.querySelector("#source-import-form"),
    sourceImportKind: document.querySelector("#source-import-kind"),
    sourceImportMode: document.querySelector("#source-import-mode"),
    sourceImportFileGroup: document.querySelector("#source-import-file-group"),
    sourceImportTextGroup: document.querySelector("#source-import-text-group"),
    sourceImportFile: document.querySelector("#source-import-file"),
    sourceImportFileLimit: document.querySelector("#source-import-file-limit"),
    sourceImportText: document.querySelector("#source-import-text"),
    sourceImportTextLimit: document.querySelector("#source-import-text-limit"),
    sourceImportTitle: document.querySelector("#source-import-title-field"),
    sourceImportOrigin: document.querySelector("#source-import-origin"),
    sourceImportAuthority: document.querySelector("#source-import-authority"),
    sourceImportSensitivity: document.querySelector("#source-import-sensitivity"),
    sourceImportPurpose: document.querySelector("#source-import-purpose"),
    sourceImportActor: document.querySelector("#source-import-actor"),
    sourceImportError: document.querySelector("#source-import-error"),
    sourceImportPreview: document.querySelector("#source-import-preview"),
    sourceImportPreviewButton: document.querySelector("#source-import-preview-button"),
    sourceImportConfirmGroup: document.querySelector("#source-import-confirm-group"),
    sourceImportConfirmation: document.querySelector("#source-import-confirmation"),
    sourceImportApply: document.querySelector("#source-import-apply"),
  };

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHTML(value).replaceAll("`", "&#096;");
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function plural(value, singular, pluralForm = `${singular}s`) {
    return `${value} ${value === 1 ? singular : pluralForm}`;
  }

  function setLiveText(element, message) {
    if (!element) return;
    const version = (liveTextVersions.get(element) || 0) + 1;
    liveTextVersions.set(element, version);
    element.textContent = "";
    window.requestAnimationFrame(() => {
      if (liveTextVersions.get(element) === version) element.textContent = message;
    });
  }

  function announce(message) {
    setLiveText(dom.appStatus, message);
  }

  function preferredScrollBehavior() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  function words(value) {
    return String(value ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleCase(value) {
    const normalized = words(value);
    return normalized ? normalized.replace(/\b\w/g, (character) => character.toUpperCase()) : "Unknown";
  }

  function safeToken(value, fallback = "unknown") {
    const token = String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    return token || fallback;
  }

  function currentUseState(value, statusField = "status") {
    const object = asObject(value);
    const rawStatus = String(object[statusField] || "unknown")
      .trim()
      .toLowerCase();
    let status = CURRENT_USE_STATUSES.has(rawStatus) ? rawStatus : "unknown";
    const settled = status === "current" && object.settled === true;
    const inconsistentCurrent = status === "current" && !settled;
    if (inconsistentCurrent) status = "unknown";
    const reason = inconsistentCurrent
      ? "The local service returned an inconsistent current-use state, so the interface treated it as unknown."
      : String(
          object.reason ||
            (settled
              ? "Current for the synchronized repository snapshot; this is not proof of runtime correctness."
              : "Current-use authority was not established by the local service."),
        );
    return {
      status,
      settled,
      reason,
      authority: String(object.authority || "unknown"),
      evidenceIds: asArray(object.evidenceIds).map(String).filter(Boolean),
    };
  }

  function currentUseMarkup(value, className = "current-use-state") {
    const presentation = currentUseState(value);
    const label = presentation.settled
      ? "Settled for this synchronized snapshot"
      : `${titleCase(presentation.status)} — not settled for current use`;
    return `<div class="${escapeAttr(className)}" data-settled="${presentation.settled}" data-status="${escapeAttr(safeToken(presentation.status))}">
      <b>${escapeHTML(label)}</b>
      <span>Authority: ${escapeHTML(titleCase(presentation.authority))}</span>
      ${presentation.settled ? "" : `<small>${escapeHTML(presentation.reason)}</small>`}
    </div>`;
  }

  function unsettledCallout(value) {
    const presentation = currentUseState(value);
    if (presentation.settled) return "";
    return `<div class="briefing-claim-warning"><strong>${escapeHTML(`${titleCase(presentation.status)} context`)}</strong><span>${escapeHTML(presentation.reason)}</span><small>Authority: ${escapeHTML(titleCase(presentation.authority))}</small></div>`;
  }

  function truncate(value, length = 24) {
    const text = String(value ?? "");
    return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}…` : text;
  }

  function formatDate(value, options = {}) {
    if (!value) return "Unknown date";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...options,
    }).format(date);
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function relativeTime(value) {
    if (!value) return "Not timestamped";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return formatDate(value);
    const difference = date.getTime() - Date.now();
    const absolute = Math.abs(difference);
    const units = [
      ["year", 31_536_000_000],
      ["month", 2_592_000_000],
      ["day", 86_400_000],
      ["hour", 3_600_000],
      ["minute", 60_000],
    ];
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [unit, milliseconds] of units) {
      if (absolute >= milliseconds || unit === "minute") {
        return formatter.format(Math.round(difference / milliseconds), unit);
      }
    }
    return "just now";
  }

  function confidenceInfo(value) {
    const raw = String(value ?? "").trim();
    const numeric = Number(raw);
    if (raw && Number.isFinite(numeric)) {
      const percent = Math.round(clamp(numeric > 0 && numeric <= 1 ? numeric * 100 : numeric, 0, 100));
      return {
        short: `${percent}%`,
        label: `${percent}% confidence`,
        tone: percent >= 80 ? "good" : percent >= 55 ? "warning" : "danger",
      };
    }
    const token = safeToken(raw);
    const label = titleCase(raw || "unknown");
    return {
      short: label,
      label: `${label} confidence`,
      tone: token === "approved" ? "good" : token === "inferred" || token === "unknown" ? "warning" : "info",
    };
  }

  function evidenceCount(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return Math.max(0, Math.round(safeNumber(value, 0)));
  }

  function statusTone(status, severity) {
    const combined = `${status ?? ""} ${severity ?? ""}`.toLowerCase();
    if (/critical|error|fail|danger|blocked|missing|unhealthy|conflict|invalid|denied/.test(combined)) return "danger";
    if (/warn|medium|high|stale|pending|review|degraded|unknown|removed|historical|unsettled/.test(combined)) return "warning";
    if (/pass|good|healthy|current|complete|active|ok|low|verified/.test(combined)) return "good";
    return "info";
  }

  function stateIcon(kind) {
    return `<div class="state-icon">${ICONS[kind] || ICONS.empty}</div>`;
  }

  async function fetchJSON(url, signal) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`The local service returned ${response.status} ${response.statusText || ""}`.trim());
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("The local service did not return JSON.");
    }
    const payload = await response.json();
    if (payload?.contractVersion !== "1.0.0" || !("data" in payload)) {
      throw new Error("The local service returned an unsupported Context Atlas contract.");
    }
    return payload.data;
  }

  async function postVersionedJSON(url, body, sessionToken = null) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (sessionToken) headers["X-Context-Atlas-Session"] = sessionToken;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.toLowerCase().includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const errorData = asObject(asObject(payload).data);
      const error = new Error(
        String(errorData.message || `The local service returned ${response.status} ${response.statusText || ""}`.trim()),
      );
      error.code = String(errorData.code || "request_failed");
      error.status = response.status;
      throw error;
    }
    if (payload?.contractVersion !== "1.0.0" || !("data" in payload)) {
      throw new Error("The local service returned an unsupported Context Atlas contract.");
    }
    return payload.data;
  }

  async function ensureReviewSession() {
    if (state.review.sessionToken) return state.review.sessionToken;
    if (!state.review.sessionPromise) {
      state.review.sessionPromise = postVersionedJSON(API.reviewSession, {})
        .then((data) => {
          const token = String(asObject(data).token || "");
          if (!/^[a-zA-Z0-9_-]{40,100}$/.test(token))
            throw new Error("The local service did not establish a valid browser review session.");
          state.review.sessionToken = token;
          return token;
        })
        .finally(() => {
          state.review.sessionPromise = null;
        });
    }
    return state.review.sessionPromise;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return window.btoa(binary);
  }

  function formatSourceLimit(maximumSourceBytes) {
    const kibibytes = maximumSourceBytes / 1024;
    return Number.isInteger(kibibytes) ? `${kibibytes} KiB (${maximumSourceBytes} bytes)` : `${maximumSourceBytes} bytes`;
  }

  function updateSourceImportLimitCopy(maximumSourceBytes) {
    const limit = formatSourceLimit(maximumSourceBytes);
    if (dom.sourceImportFileLimit) {
      dom.sourceImportFileLimit.textContent = `One .txt or .md file, maximum ${limit}. Its host path is never sent or stored.`;
    }
    if (dom.sourceImportTextLimit) {
      dom.sourceImportTextLimit.textContent = `Paste a bounded summary, not a raw chat archive. Maximum ${limit} after UTF-8 encoding. Remove secrets before preview.`;
    }
    dom.sourceImportText.maxLength = maximumSourceBytes;
  }

  async function ensureSourceImportCapabilities() {
    if (Number.isSafeInteger(state.sourceImport.maximumSourceBytes) && state.sourceImport.maximumSourceBytes > 0) {
      return state.sourceImport.maximumSourceBytes;
    }
    if (!state.sourceImport.capabilitiesPromise) {
      state.sourceImport.capabilitiesPromise = fetchJSON(API.capabilities)
        .then((capabilities) => {
          const externalImport = asObject(asObject(capabilities).externalImport);
          const maximumSourceBytes = Number(externalImport.maximumSourceBytes);
          if (!Number.isSafeInteger(maximumSourceBytes) || maximumSourceBytes < 1) {
            throw new Error("The local service did not provide a valid external-import source limit.");
          }
          state.sourceImport.maximumSourceBytes = maximumSourceBytes;
          updateSourceImportLimitCopy(maximumSourceBytes);
          return maximumSourceBytes;
        })
        .finally(() => {
          state.sourceImport.capabilitiesPromise = null;
        });
    }
    return state.sourceImport.capabilitiesPromise;
  }

  function clearSourceImportPreview() {
    state.sourceImport.plan = null;
    state.sourceImport.payload = null;
    dom.sourceImportPreview.hidden = true;
    dom.sourceImportPreview.innerHTML = "";
    dom.sourceImportConfirmGroup.hidden = true;
    dom.sourceImportApply.hidden = true;
    dom.sourceImportConfirmation.value = "";
  }

  function setSourceImportBusy(busy, label) {
    state.sourceImport.submitting = busy;
    dom.sourceImportForm?.setAttribute("aria-busy", String(busy));
    dom.sourceImportForm?.querySelectorAll("input, textarea, select, button").forEach((control) => {
      control.disabled = busy;
    });
    if (!busy) {
      dom.sourceImportConfirmation.disabled = false;
      dom.sourceImportApply.disabled = false;
    }
    if (label) dom.sourceImportPreviewButton.textContent = label;
  }

  function syncSourceImportMode() {
    const pasted = dom.sourceImportMode.value === "pasted_text";
    dom.sourceImportFileGroup.hidden = pasted;
    dom.sourceImportTextGroup.hidden = !pasted;
    dom.sourceImportFile.required = !pasted;
    dom.sourceImportText.required = pasted;
  }

  function openSourceImport() {
    const previousActor = dom.sourceImportActor.value;
    dom.sourceImportForm.reset();
    dom.sourceImportActor.value = previousActor;
    dom.sourceImportError.hidden = true;
    dom.sourceImportError.textContent = "";
    clearSourceImportPreview();
    syncSourceImportMode();
    state.sourceImport.returnFocus = document.activeElement;
    dom.sourceImportDialog.showModal();
    window.requestAnimationFrame(() => dom.sourceImportKind.focus());
    void ensureSourceImportCapabilities().catch((error) => {
      if (!dom.sourceImportDialog.open) return;
      dom.sourceImportError.textContent = error instanceof Error ? error.message : "The local source limit could not be loaded.";
      dom.sourceImportError.hidden = false;
    });
    announce("Add one external source. Preview is required before import.");
  }

  function closeSourceImport() {
    if (state.sourceImport.submitting) return;
    const returnFocus = state.sourceImport.returnFocus;
    if (dom.sourceImportDialog.open) dom.sourceImportDialog.close();
    clearSourceImportPreview();
    state.sourceImport.returnFocus = null;
    if (returnFocus instanceof HTMLElement) window.requestAnimationFrame(() => returnFocus.focus());
  }

  async function sourceImportPayload() {
    const maximumSourceBytes = await ensureSourceImportCapabilities();
    const mode = dom.sourceImportMode.value;
    let bytes;
    let displayName;
    let observedAt;
    if (mode === "browser_file") {
      const file = dom.sourceImportFile.files?.[0];
      if (!file) throw new Error("Choose one UTF-8 text or Markdown file.");
      if (file.size > maximumSourceBytes)
        throw new Error(`The selected file exceeds the ${formatSourceLimit(maximumSourceBytes)} decoded source limit.`);
      bytes = new Uint8Array(await file.arrayBuffer());
      displayName = file.name || "selected-source.txt";
      observedAt = new Date(file.lastModified || Date.now()).toISOString();
    } else {
      const text = dom.sourceImportText.value;
      if (!text.trim()) throw new Error("Paste a non-empty conversation summary.");
      bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maximumSourceBytes)
        throw new Error(`The pasted summary exceeds the ${formatSourceLimit(maximumSourceBytes)} decoded source limit.`);
      displayName = "pasted-conversation-summary.md";
      observedAt = new Date().toISOString();
    }
    return {
      source: {
        bodyBase64: bytesToBase64(bytes),
        displayName,
        observedAt,
        selectionKind: mode,
      },
      metadata: {
        actor: dom.sourceImportActor.value.trim(),
        declaredAuthority: dom.sourceImportAuthority.value,
        originLabel: dom.sourceImportOrigin.value.trim(),
        purpose: dom.sourceImportPurpose.value.trim(),
        sensitivityLabel: dom.sourceImportSensitivity.value,
        sourceKind: dom.sourceImportKind.value,
        title: dom.sourceImportTitle.value.trim(),
      },
    };
  }

  function renderSourceImportPreview(plan) {
    const source = asObject(plan.source);
    const planned = asObject(plan.planned);
    const warnings = asArray(plan.warnings);
    const persistence =
      source.bodyPersistence === "omitted_sensitive"
        ? "Sensitive metadata only · body will not be persisted"
        : "Body stored locally in immutable project evidence";
    dom.sourceImportPreview.innerHTML = `
      <div class="source-preview-heading"><div><p class="eyebrow">Read-only preview</p><h3>${escapeHTML(source.title || source.displayName || "Selected source")}</h3></div><span data-persistence="${escapeAttr(source.bodyPersistence)}">${escapeHTML(persistence)}</span></div>
      <dl class="source-preview-facts">
        <div><dt>Exact size</dt><dd>${escapeHTML(String(source.bytes || 0))} bytes</dd></div>
        <div><dt>SHA-256</dt><dd><code>${escapeHTML(String(source.contentDigest || "").slice(0, 16))}…</code></dd></div>
        <div><dt>Planned writes</dt><dd>${escapeHTML(String(planned.writesPlanned ?? 0))}</dd></div>
        <div><dt>Existing import</dt><dd>${planned.alreadyImported ? "Yes · idempotent" : "No"}</dd></div>
      </dl>
      <div class="source-preview-text"><strong>Sanitized preview</strong><pre>${escapeHTML(source.previewText || "No body preview is available.")}</pre>${source.previewTruncated ? "<small>Preview shortened; the content digest covers the full selected source.</small>" : ""}</div>
      ${warnings.length ? `<ul class="source-preview-warnings">${warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join("")}</ul>` : ""}
      <p class="source-preview-consent">Nothing has been written. Check this preview, then type <code>IMPORT</code> to bind consent to these exact bytes and metadata.</p>`;
    dom.sourceImportPreview.hidden = false;
    dom.sourceImportConfirmGroup.hidden = false;
    dom.sourceImportApply.hidden = false;
  }

  async function previewSourceImport() {
    if (state.sourceImport.submitting || !dom.sourceImportForm.reportValidity()) return;
    dom.sourceImportError.hidden = true;
    clearSourceImportPreview();
    setSourceImportBusy(true, "Scanning exact bytes…");
    try {
      const payload = await sourceImportPayload();
      const sessionToken = await ensureReviewSession();
      const plan = await postVersionedJSON(API.externalImportPreview, payload, sessionToken);
      state.sourceImport.payload = payload;
      state.sourceImport.plan = plan;
      renderSourceImportPreview(plan);
      announce("Source preview ready. No project data has been changed.");
    } catch (error) {
      dom.sourceImportError.textContent = error instanceof Error ? error.message : "The selected source could not be previewed.";
      dom.sourceImportError.hidden = false;
      announce("Source preview failed. No project data was changed.");
    } finally {
      setSourceImportBusy(false, "Preview exact source");
    }
  }

  async function submitSourceImport(event) {
    event.preventDefault();
    if (state.sourceImport.submitting || !state.sourceImport.plan || !state.sourceImport.payload) return;
    if (dom.sourceImportConfirmation.value !== "IMPORT") {
      dom.sourceImportError.textContent = "Type the exact confirmation IMPORT before writing this source.";
      dom.sourceImportError.hidden = false;
      dom.sourceImportConfirmation.focus();
      return;
    }
    dom.sourceImportError.hidden = true;
    setSourceImportBusy(true, "Preview locked");
    dom.sourceImportApply.textContent = "Importing…";
    try {
      const sessionToken = await ensureReviewSession();
      const result = await postVersionedJSON(
        API.externalImportApply,
        {
          ...state.sourceImport.payload,
          planId: state.sourceImport.plan.planId,
          confirmation: "IMPORT",
        },
        sessionToken,
      );
      state.cache.overview = null;
      state.cache.map = null;
      state.cache.timeline = null;
      state.cache.health = null;
      state.cache.review = null;
      setSourceImportBusy(false, "Preview exact source");
      dom.sourceImportDialog.close();
      clearSourceImportPreview();
      showToast(
        result.alreadyImported ? "Source was already present; no duplicate was created." : "Source imported as untrusted evidence.",
        "success",
      );
      announce("External source import completed and was added to the immutable local timeline.");
      void refreshReviewBadge();
    } catch (error) {
      setSourceImportBusy(false, "Preview exact source");
      dom.sourceImportApply.textContent = "Import reviewed source";
      if (error?.code === "invalid_review_session") state.review.sessionToken = null;
      dom.sourceImportError.textContent =
        error instanceof Error ? error.message : "The source import failed without returning source content.";
      dom.sourceImportError.hidden = false;
      announce("Source import failed. Review the error and preview again if the selection changed.");
    }
  }

  function setViewState(view, mode, content = "") {
    const panel = document.querySelector(`[data-view-panel="${view}"]`);
    if (!panel) return;
    const loading = panel.querySelector("[data-state='loading']");
    const target = panel.querySelector(".view-content");
    loading.hidden = mode !== "loading";
    target.hidden = mode === "loading";
    panel.setAttribute("aria-busy", String(mode === "loading"));
    if (mode !== "loading" && content !== undefined) target.innerHTML = content;
    if (mode === "error") announce(`${VIEW_META[view].documentTitle} could not be loaded.`);
    if (mode === "empty") announce(`${VIEW_META[view].documentTitle} has no context yet.`);
  }

  function errorMarkup(view, error) {
    const message = error instanceof Error ? error.message : "The local Context Atlas service could not be reached.";
    return `
      <div class="error-state surface" role="alert">
        ${stateIcon("error")}
        <h2>Couldn’t load ${escapeHTML(VIEW_META[view].documentTitle.toLowerCase())}</h2>
        <p>${escapeHTML(message)} Your project data was not replaced or modified.</p>
        <button class="primary-button" type="button" data-retry-view="${escapeAttr(view)}">Try again</button>
      </div>`;
  }

  function emptyMarkup(title, message) {
    return `
      <div class="empty-state surface">
        ${stateIcon("empty")}
        <h2>${escapeHTML(title)}</h2>
        <p>${escapeHTML(message)}</p>
      </div>`;
  }

  function showToast(message, tone = "info") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.tone = safeToken(tone);
    toast.textContent = message;
    dom.toastRegion.append(toast);
    announce(message);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function markLoaded(timestamp) {
    const value = timestamp || new Date().toISOString();
    dom.syncTime.textContent = `Loaded ${relativeTime(value)}`;
    dom.syncTime.title = value;
  }

  function activateView(view, options = {}) {
    if (!VIEW_META[view]) return;
    state.currentView = view;
    dom.viewTitle.textContent = VIEW_META[view].title;
    document.title = `${VIEW_META[view].documentTitle} · Context Atlas`;

    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      const active = panel.dataset.viewPanel === view;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    try {
      history.replaceState(null, "", `#${view}`);
    } catch {
      // Hash navigation is a progressive enhancement only.
    }

    closeSearchResults();
    announce(`${VIEW_META[view].title} selected.`);
    return loadView(view, Boolean(options.force));
  }

  async function loadView(view, force = false) {
    if (!API[view] || state.loading.has(view)) return;
    if (state.cache[view] && !force) {
      renderView(view, state.cache[view]);
      return;
    }

    state.loading.add(view);
    setViewState(view, "loading");
    if (view === state.currentView) dom.refresh.classList.add("is-spinning");
    try {
      const data = await fetchJSON(API[view]);
      state.cache[view] = asObject(data);
      renderView(view, state.cache[view]);
      markLoaded(data?.generatedAt);
      if (force) showToast(`${VIEW_META[view].documentTitle} refreshed from local evidence.`);
    } catch (error) {
      setViewState(view, "error", errorMarkup(view, error));
    } finally {
      state.loading.delete(view);
      if (view === state.currentView) dom.refresh.classList.remove("is-spinning");
    }
  }

  function renderView(view, data) {
    if (view === "overview") renderOverview(data);
    if (view === "map") renderMap(data);
    if (view === "timeline") renderTimeline(data);
    if (view === "health") renderHealth(data);
    if (view === "review") renderReview(data);
  }

  function projectIdentity(project) {
    if (typeof project === "string") return { name: project, description: "" };
    const object = asObject(project);
    return {
      name: object.name || object.title || object.id || "Untitled project",
      description: object.description || object.purpose || "",
    };
  }

  function normalizeStats(stats) {
    if (Array.isArray(stats)) {
      return stats.slice(0, 8).map((item, index) => {
        const object = asObject(item);
        return { label: object.label || object.name || `Metric ${index + 1}`, value: object.value ?? object.count ?? 0 };
      });
    }
    const flattened = [];
    const nested = [];
    for (const [label, value] of Object.entries(asObject(stats))) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedLabel, nestedValue] of Object.entries(value)) {
          nested.push({ label: label === "byType" ? nestedLabel : `${label} ${nestedLabel}`, value: nestedValue });
        }
      } else {
        flattened.push({ label, value });
      }
    }
    return [...flattened, ...nested].slice(0, 8);
  }

  function statIcon(index) {
    return [ICONS.archive, ICONS.branch, ICONS.file, ICONS.shield][index % 4];
  }

  function normalizeRisk(risk, index) {
    if (typeof risk === "string") return { title: risk, summary: "", severity: "unknown" };
    const object = asObject(risk);
    return {
      title: object.title || object.label || object.name || `Risk ${index + 1}`,
      summary: object.summary || object.details || object.description || "",
      severity: object.status || object.severity || "unknown",
    };
  }

  function normalizeCommitFile(file) {
    if (typeof file === "string") return { path: file, status: "", previousPath: "" };
    const object = asObject(file);
    return {
      path: String(object.path || object.file || "Unknown path"),
      status: String(object.status || ""),
      previousPath: String(object.previousPath || ""),
    };
  }

  function normalizeEvent(event, index) {
    const object = asObject(event);
    return {
      id: object.id ?? `event-${index}`,
      timestamp: object.timestamp || object.date || object.createdAt || "",
      type: object.type || "event",
      title: object.title || object.label || `Event ${index + 1}`,
      summary: object.summary || object.details || object.description || "",
      commit: object.commit || "",
      files: asArray(object.files).map(normalizeCommitFile),
      evidence: object.evidence,
    };
  }

  function briefingSteps(data) {
    const project = projectIdentity(data.project);
    const summaryObject = asObject(data.summary);
    const overviewClaim = asObject(asObject(data.assertions).overview);
    const claimState = currentUseState(overviewClaim);
    const orientation = asObject(data.orientation);
    const purpose = asObject(orientation.purpose);
    const purposeState = currentUseState(purpose);
    const summary =
      typeof data.summary === "string" ? data.summary : summaryObject.text || summaryObject.description || project.description;
    const architecture = asArray(orientation.architecture).slice(0, 6);
    const decisions = asArray(orientation.decisions).slice(0, 5);
    const unknowns = asArray(orientation.unknowns).slice(0, 5);
    const entryPoints = asArray(orientation.recommendedEntryPoints).slice(0, 6);
    const risks = asArray(data.risks).map(normalizeRisk).slice(0, 4);
    const list = (items, empty, mapper) =>
      items.length
        ? `<ul class="briefing-list">${items.map(mapper).join("")}</ul>`
        : `<p class="briefing-unknown">${escapeHTML(empty)}</p>`;

    return [
      {
        label: "The one-minute snapshot",
        title: project.name,
        lead: summary || "A supported plain-language project summary has not been recorded yet.",
        body: `${claimState.settled ? "" : `<div class="briefing-claim-warning"><strong>${escapeHTML(`${titleCase(claimState.status)} reviewed overview`)}</strong><span>${escapeHTML(claimState.reason)}</span><small>Authority: ${escapeHTML(titleCase(claimState.authority))}</small></div>`}<div class="briefing-principle">Context Atlas separates what the repository supports from what remains unknown. Use this briefing to orient yourself, then verify consequential claims at their evidence.</div>`,
      },
      {
        label: "Purpose and shape",
        title: "Why it exists—and how it is divided",
        lead: purposeState.settled
          ? purpose.text || "The project purpose is not supported by a recognized README summary yet."
          : purpose.text
            ? `Historical or unsettled purpose: ${purpose.text}`
            : "The current project purpose has not been established.",
        body: `${unsettledCallout(purpose)}${list(architecture, "No component boundaries have been mapped yet.", (item) => `<li><strong>${escapeHTML(item.title || "Untitled component")}</strong><span>${escapeHTML(item.summary || "No supported explanation yet.")}</span>${currentUseMarkup(item, "briefing-item-state")}</li>`)}`,
        evidence: purpose.evidenceId || "No purpose evidence linked",
      },
      {
        label: "Decisions and rationale",
        title: "The choices that shaped today’s code",
        lead: "Decision records are kept distinct from inferred implementation facts so missing rationale stays visible.",
        body: list(
          decisions,
          "No decision records were found; do not invent rationale from the implementation.",
          (item) =>
            `<li><strong>${escapeHTML(item.title || "Untitled decision")}</strong><span>${escapeHTML(item.summary || "No rationale was recorded.")}</span>${currentUseMarkup(item, "briefing-item-state")}</li>`,
        ),
      },
      {
        label: "Trust boundaries",
        title: "What you should verify before changing code",
        lead: "Unknowns and risks are part of the map, not footnotes. They show where a developer or coding assistant could overreach.",
        body: `${list(unknowns, "No explicit context gaps were returned; that is not a correctness guarantee.", (item) => `<li class="is-warning"><strong>Known unknown</strong><span>${escapeHTML(String(item))}</span></li>`)}${risks.length ? `<div class="briefing-risk-row">${risks.map((risk) => `<span>${escapeHTML(risk.title)}</span>`).join("")}</div>` : ""}`,
      },
      {
        label: "Your first move",
        title: "Start with an indexed candidate, then verify it",
        lead: "These are navigation candidates from the indexed projection, not current-use claims. Open the map to check each candidate’s status, authority, and evidence posture.",
        body: list(
          entryPoints,
          "No recommended entry point is supported yet.",
          (item) =>
            `<li><strong>${escapeHTML(item.title || item.id || "Untitled")}</strong><span>${escapeHTML(titleCase(item.type || "item"))}</span></li>`,
        ),
      },
    ];
  }

  function renderBriefing() {
    const data = state.cache.overview;
    if (!data || !dom.briefingContent) return;
    const steps = briefingSteps(data);
    state.briefing.step = clamp(state.briefing.step, 0, steps.length - 1);
    const step = steps[state.briefing.step];
    dom.briefingStepLabel.textContent = `${state.briefing.step + 1} of ${steps.length} · ${step.label}`;
    dom.briefingProgress.dataset.step = String(state.briefing.step + 1);
    dom.briefingContent.innerHTML = `
      <div class="briefing-step" tabindex="-1">
        <p class="briefing-overline">Evidence-aware orientation</p>
        <h3>${escapeHTML(step.title)}</h3>
        <p class="briefing-lead">${escapeHTML(step.lead)}</p>
        ${step.body}
        ${step.evidence ? `<p class="briefing-evidence">${ICONS.source}<span>${escapeHTML(step.evidence)}</span></p>` : ""}
      </div>`;
    dom.briefingPrevious.disabled = state.briefing.step === 0;
    dom.briefingNext.textContent = state.briefing.step === steps.length - 1 ? "Open project map" : "Next";
    announce(`Briefing step ${state.briefing.step + 1} of ${steps.length}: ${step.title}`);
    window.requestAnimationFrame(() => dom.briefingContent.querySelector(".briefing-step")?.focus());
  }

  async function openBriefing() {
    if (!dom.briefingDialog) return;
    if (!dom.briefingDialog.open) dom.briefingDialog.showModal();
    if (!state.cache.overview) {
      dom.briefingContent.innerHTML = '<div class="briefing-loading" role="status">Preparing an evidence-backed briefing…</div>';
      try {
        state.cache.overview = asObject(await fetchJSON(API.overview));
      } catch (error) {
        dom.briefingContent.innerHTML = `<div class="briefing-loading" role="alert">${escapeHTML(error instanceof Error ? error.message : "The project briefing is unavailable.")}</div>`;
        return;
      }
    }
    state.briefing.step = 0;
    renderBriefing();
  }

  function closeBriefing() {
    if (dom.briefingDialog?.open) dom.briefingDialog.close();
  }

  function renderOverview(data) {
    const project = projectIdentity(data.project);
    const overviewClaim = asObject(asObject(data.assertions).overview);
    const claimState = currentUseState(overviewClaim);
    const claimStatus = claimState.status;
    const claimValue = asObject(overviewClaim.value);
    const historicalSummary = typeof overviewClaim.value === "string" ? overviewClaim.value : String(claimValue.summary || "");
    const claimEvidence = asArray(overviewClaim.evidence)
      .map((item) => String(asObject(item).evidenceId || ""))
      .filter(Boolean);
    const summaryAuthority = String(data.summaryAuthority || "unknown");
    const summary =
      typeof data.summary === "string"
        ? data.summary
        : asObject(data.summary).text || asObject(data.summary).description || project.description;
    const stats = normalizeStats(data.stats);
    const risks = asArray(data.risks).map(normalizeRisk);
    const events = asArray(data.recentEvents).map(normalizeEvent);
    const orientation = asObject(data.orientation);
    const purpose = asObject(orientation.purpose);
    const architecture = asArray(orientation.architecture).slice(0, 8);
    const decisions = asArray(orientation.decisions).slice(0, 6);
    const unknowns = asArray(orientation.unknowns).slice(0, 6);
    const entryPoints = asArray(orientation.recommendedEntryPoints).slice(0, 8);
    const generatedAt = data.generatedAt;
    const orientationSignalTotal = architecture.length + decisions.length;

    if (!data.project && !summary && !stats.length && !risks.length && !events.length) {
      setViewState(
        "overview",
        "empty",
        emptyMarkup(
          "No project context yet",
          "When the local context engine has indexed evidence, this page will explain the project from first principles.",
        ),
      );
      return;
    }

    const statCards = stats.length
      ? stats
          .map(
            (stat, index) => `
          <article class="stat-card surface">
            <div class="stat-card-top"><span>${escapeHTML(titleCase(stat.label))}</span>${statIcon(index)}</div>
            <strong title="${escapeAttr(stat.value)}">${escapeHTML(stat.value)}</strong>
          </article>`,
          )
          .join("")
      : `<article class="stat-card surface"><div class="stat-card-top"><span>Indexed facts</span>${ICONS.archive}</div><strong>—</strong></article>`;

    const eventRows = events.length
      ? events
          .slice(0, 7)
          .map(
            (event) => `
          <article class="mini-event">
            <div class="event-glyph" data-tone="${escapeAttr(safeToken(event.type))}" aria-hidden="true">${escapeHTML(event.type.slice(0, 1) || "E")}</div>
            <div><h3>${escapeHTML(event.title)}</h3><p>${escapeHTML(event.summary || "No summary recorded.")}</p></div>
            <time datetime="${escapeAttr(event.timestamp)}">${escapeHTML(relativeTime(event.timestamp))}</time>
          </article>`,
          )
          .join("")
      : `<div class="empty-state"><h3>No recent events</h3><p>The API returned no recent project events.</p></div>`;

    const riskRows = risks.length
      ? risks
          .slice(0, 7)
          .map(
            (risk) => `
          <article class="risk-item">
            <span class="risk-severity" data-severity="${escapeAttr(safeToken(risk.severity))}" aria-hidden="true"></span>
            <div><h3>${escapeHTML(risk.title)}</h3><p>${escapeHTML(risk.summary || `${titleCase(risk.severity)} severity`)}</p></div>
          </article>`,
          )
          .join("")
      : `<div class="empty-state"><h3>No recorded risks</h3><p>This means no risks were returned—not that the project is risk-free.</p></div>`;

    const architectureRows = architecture.length
      ? architecture
          .map(
            (item) =>
              `<li><strong>${escapeHTML(item.title || "Untitled component")}</strong><span>${escapeHTML(item.summary || "No supported explanation yet.")}</span>${currentUseMarkup(item)}</li>`,
          )
          .join("")
      : `<li><strong>Unknown</strong><span>No component boundaries have been mapped yet.</span></li>`;
    const decisionRows = decisions.length
      ? decisions
          .map(
            (item) =>
              `<li><strong>${escapeHTML(item.title || "Untitled decision")}</strong><span>${escapeHTML(item.summary || "No rationale was recorded.")}</span>${currentUseMarkup(item)}</li>`,
          )
          .join("")
      : `<li><strong>Unknown rationale</strong><span>No decision records were found. The interface does not invent reasons.</span></li>`;
    const unknownRows = unknowns.length
      ? unknowns.map((item) => `<li>${escapeHTML(String(item))}</li>`).join("")
      : `<li>No explicit context gaps were returned; this is not a correctness guarantee.</li>`;
    const entryRows = entryPoints.length
      ? entryPoints
          .map(
            (item) =>
              `<li><span class="type-chip">${escapeHTML(item.type || "item")}</span>${escapeHTML(item.title || item.id || "Untitled")}</li>`,
          )
          .join("")
      : `<li>No recommended entry point is supported yet.</li>`;
    const claimNotice = claimState.settled
      ? ""
      : `
      <section class="claim-state-banner" data-status="${escapeAttr(safeToken(claimStatus))}" role="status" aria-live="polite" aria-labelledby="overview-claim-state-title">
        <div class="claim-state-icon" aria-hidden="true">!</div>
        <div class="claim-state-copy">
          <p class="eyebrow">Reviewed overview claim status</p>
          <h2 id="overview-claim-state-title">Reviewed overview is ${escapeHTML(claimStatus)} — do not treat it as current</h2>
          <p>${escapeHTML(claimState.reason)}</p>
          <p class="claim-state-authority"><strong>Authority:</strong> ${escapeHTML(titleCase(claimState.authority))}</p>
          ${historicalSummary ? `<details><summary>Show previously accepted overview (historical context only)</summary><p>${escapeHTML(historicalSummary)}</p></details>` : ""}
          <p class="claim-state-evidence"><strong>Supporting evidence:</strong> ${claimEvidence.length ? claimEvidence.map((id) => `<code>${escapeHTML(id)}</code>`).join(" ") : "none linked"}</p>
        </div>
      </section>`;
    const summaryLabel =
      summaryAuthority === "human-reviewed"
        ? "Current human-reviewed overview"
        : summaryAuthority === "observed"
          ? "Observed synchronized snapshot — reviewed narrative withheld"
          : "Current overview unavailable";
    const summaryProvenance =
      summaryAuthority === "human-reviewed"
        ? "This overview is human-reviewed and evidence-backed for the synchronized snapshot. It does not prove runtime correctness."
        : summaryAuthority === "observed"
          ? "This summary is limited to observed evidence from the synchronized snapshot; the reviewed narrative is withheld until it is settled again."
          : "A current summary is withheld. Treat the visible gap and any historical narrative as a prompt to revalidate, not as project guidance.";

    setViewState(
      "overview",
      "ready",
      `
      <div class="overview-page">
        ${claimNotice}
        <section class="overview-hero surface">
          <div class="hero-copy">
            <p class="eyebrow">${escapeHTML(summaryLabel)}</p>
            <h2>${escapeHTML(project.name)}</h2>
            <p class="hero-summary">${escapeHTML(summary || project.description || "A plain-language project summary has not been recorded yet.")}</p>
            <p class="summary-authority-note">${escapeHTML(data.summaryReason || "Check claim status and evidence before relying on this summary.")}</p>
            <div class="hero-actions">
              <button class="primary-button" type="button" data-open-briefing>${ICONS.source}<span>Take the 90-second briefing</span></button>
              <button class="secondary-button" type="button" data-go-view="map">Explore relationships</button>
            </div>
          </div>
          <aside class="hero-aside">
            <div class="provenance-label">${ICONS.source}<span>Provenance matters</span></div>
            <p>${escapeHTML(summaryProvenance)}</p>
            <div class="orientation-signals" aria-label="Orientation coverage">
              <span><strong>${orientationSignalTotal}</strong> mapped concepts</span>
              <span><strong>${unknowns.length}</strong> known ${unknowns.length === 1 ? "unknown" : "unknowns"}</span>
            </div>
            <time class="generated-time" datetime="${escapeAttr(generatedAt || "")}">Snapshot generated ${escapeHTML(generatedAt ? formatDate(generatedAt, { hour: "2-digit", minute: "2-digit" }) : "at an unknown time")}</time>
          </aside>
        </section>
        <section class="stat-grid" aria-label="Project statistics">${statCards}</section>
        <section class="orientation-section surface" aria-labelledby="orientation-title">
          <div class="section-heading">
            <div><p class="eyebrow">From first principles</p><h2 id="orientation-title">Project orientation</h2></div>
            <button class="text-button" type="button" data-go-view="map">Explore the evidence map</button>
          </div>
          <nav class="orientation-path" aria-label="Orientation topics">
            <button type="button" data-orientation-jump="purpose"><span>01</span> Purpose</button>
            <button type="button" data-orientation-jump="architecture"><span>02</span> Architecture</button>
            <button type="button" data-orientation-jump="decisions"><span>03</span> Decisions</button>
            <button type="button" data-orientation-jump="unknowns"><span>04</span> Unknowns</button>
            <button type="button" data-orientation-jump="entry"><span>05</span> Start here</button>
          </nav>
          <div class="orientation-grid">
            <article class="orientation-card" id="orientation-purpose" data-orientation-topic="purpose"><h3>Purpose</h3><p>${escapeHTML(purpose.text || "Project purpose is currently unknown because no supported README summary was found.")}</p>${currentUseMarkup(purpose)}${purpose.evidenceId ? `<p class="orientation-evidence"><span>Evidence</span><code>${escapeHTML(purpose.evidenceId)}</code></p>` : ""}</article>
            <article class="orientation-card" id="orientation-architecture" data-orientation-topic="architecture"><h3>Architecture</h3><ul>${architectureRows}</ul></article>
            <article class="orientation-card" id="orientation-decisions" data-orientation-topic="decisions"><h3>Decisions and rationale</h3><ul>${decisionRows}</ul></article>
            <article class="orientation-card warning-card" id="orientation-unknowns" data-orientation-topic="unknowns"><h3>Known unknowns</h3><ul>${unknownRows}</ul></article>
            <article class="orientation-card" id="orientation-entry" data-orientation-topic="entry"><h3>Indexed starting candidates</h3><p>Verify each candidate’s current-use status in the map before relying on it.</p><ul class="entry-point-list">${entryRows}</ul></article>
          </div>
        </section>
        <div class="overview-grid">
          <section class="section-card surface">
            <div class="section-heading">
              <div><p class="eyebrow">How we got here</p><h2>Recent project events</h2></div>
              <button class="text-button" type="button" data-go-view="timeline">View full timeline →</button>
            </div>
            <div class="event-list">${eventRows}</div>
          </section>
          <section class="section-card surface">
            <div class="section-heading">
              <div><p class="eyebrow">Needs attention</p><h2>Known risks</h2></div>
              <button class="text-button" type="button" data-go-view="health">Check health →</button>
            </div>
            <div class="risk-list">${riskRows}</div>
          </section>
        </div>
      </div>`,
    );
  }

  function normalizeNode(node, index) {
    const object = asObject(node);
    const presentation = currentUseState(object, "presentationStatus");
    const evidenceIds = presentation.evidenceIds;
    return {
      id: String(object.id ?? `node-${index}`),
      type: String(object.type || "component"),
      title: String(object.title || object.name || `Node ${index + 1}`),
      summary: String(object.summary || object.description || ""),
      status: String(object.status || "unknown"),
      presentationStatus: presentation.status,
      settled: presentation.settled,
      reason: presentation.reason,
      authority: presentation.authority,
      confidence: object.confidence,
      stale: !presentation.settled,
      evidenceIds,
      evidenceCount: Math.max(evidenceIds.length, evidenceCount(object.evidenceCount)),
    };
  }

  function normalizeEdge(edge) {
    const object = asObject(edge);
    const presentation = currentUseState(object);
    return {
      id: String(object.id || `${object.source || "unknown"}:${object.type || "related"}:${object.target || "unknown"}`),
      source: String(object.source ?? ""),
      target: String(object.target ?? ""),
      type: String(object.type || "related"),
      status: presentation.status,
      settled: presentation.settled,
      reason: presentation.reason,
      authority: presentation.authority,
      confidence: object.confidence,
      evidenceIds: presentation.evidenceIds,
      evidenceValidation: asObject(object.evidenceValidation),
    };
  }

  function calculateGraphLayout(nodes, edges) {
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    edges.forEach((edge) => {
      if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source) + 1);
      if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target) + 1);
    });
    const ordered = [...nodes].sort((a, b) => {
      const difference = (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
      return difference || a.title.localeCompare(b.title);
    });
    const positions = new Map();
    if (!ordered.length) return positions;
    positions.set(ordered[0].id, { x: 0, y: 0 });
    let cursor = 1;
    let ring = 1;
    while (cursor < ordered.length) {
      const capacity = Math.max(7, ring * 9);
      const count = Math.min(capacity, ordered.length - cursor);
      const radiusX = 235 * ring;
      const radiusY = 145 * ring;
      for (let index = 0; index < count; index += 1) {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count + (ring % 2 ? 0.12 : 0);
        const node = ordered[cursor + index];
        positions.set(node.id, { x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY });
      }
      cursor += count;
      ring += 1;
    }
    return positions;
  }

  function uniqueValues(items, key) {
    return [...new Set(items.map((item) => String(item[key] || "unknown")))].sort((a, b) => a.localeCompare(b));
  }

  function renderMap(data) {
    const nodes = asArray(data.nodes).map(normalizeNode);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = asArray(data.edges)
      .map(normalizeEdge)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    state.graph.nodes = nodes;
    state.graph.edges = edges;
    state.graph.positions = calculateGraphLayout(nodes, edges);
    state.graph.visibleIds = new Set(nodes.map((node) => node.id));
    state.graph.selectedId = null;
    state.graph.query = "";
    state.graph.zoom = 1;
    state.graph.panX = 0;
    state.graph.panY = 0;

    if (!nodes.length) {
      setViewState(
        "map",
        "empty",
        emptyMarkup(
          "No map nodes yet",
          "The graph endpoint returned no knowledge nodes. Once evidence is indexed, relationships will appear here.",
        ),
      );
      return;
    }

    const typeOptions = uniqueValues(nodes, "type")
      .map((type) => `<option value="${escapeAttr(type)}">${escapeHTML(titleCase(type))}</option>`)
      .join("");
    const statusOptions = uniqueValues(nodes, "presentationStatus")
      .map((status) => `<option value="${escapeAttr(status)}">${escapeHTML(titleCase(status))}</option>`)
      .join("");
    const legend = uniqueValues(nodes, "type")
      .slice(0, 8)
      .map((type) => `<span class="legend-item" data-type="${escapeAttr(safeToken(type))}">${escapeHTML(type)}</span>`)
      .join("");

    const unsettledCount = nodes.filter((node) => !node.settled).length;
    const unsettledRelationshipCount = edges.filter((edge) => !edge.settled).length;
    const mapPosture =
      unsettledCount || unsettledRelationshipCount
        ? `<strong>${plural(unsettledCount, "node")} and ${plural(unsettledRelationshipCount, "relationship")} not settled for current use.</strong><span>Dashed amber links are unsettled topology. Open a connected node for each relationship’s authority and reason.</span>`
        : `<strong>All ${plural(nodes.length, "mapped node")} and ${plural(edges.length, "relationship")} are current for the synchronized snapshot.</strong><span>This is evidence freshness, not proof of runtime correctness.</span>`;
    setViewState(
      "map",
      "ready",
      `
      <div class="map-shell surface">
        <div class="map-context-banner" data-settled="${unsettledCount === 0 && unsettledRelationshipCount === 0}" role="status">${mapPosture}</div>
        <div class="map-toolbar">
          <div class="filter-row" aria-label="Map filters">
            <label class="map-search">${ICONS.search}<span class="sr-only">Search map nodes</span><input id="map-query-filter" type="search" placeholder="Find a node…" autocomplete="off" /></label>
            <label class="select-wrap"><span class="sr-only">Filter by node type</span><select id="map-type-filter"><option value="all">All types</option>${typeOptions}</select></label>
            <label class="select-wrap"><span class="sr-only">Filter by current-use status</span><select id="map-status-filter"><option value="all">All current-use statuses</option>${statusOptions}</select></label>
            <label class="check-filter"><input id="map-stale-filter" type="checkbox" /> Unsettled only</label>
            <button class="filter-reset" type="button" data-map-action="clear-filters">Clear</button>
            <span class="result-count" id="map-result-count" role="status">${nodes.length} nodes · ${edges.length} relationships</span>
          </div>
          <div class="map-tools" aria-label="Map zoom controls">
            <button class="icon-button" type="button" data-map-action="zoom-out" aria-label="Zoom out">−</button>
            <span class="zoom-level" id="map-zoom-level">100%</span>
            <button class="icon-button" type="button" data-map-action="zoom-in" aria-label="Zoom in">+</button>
            <button class="icon-button" type="button" data-map-action="reset" aria-label="Reset map view" title="Fit map">⌂</button>
          </div>
        </div>
        <div class="map-stage" id="map-stage">
          <svg class="map-svg" id="map-svg" role="group" aria-label="Interactive project knowledge map. Use Tab to focus nodes, Enter for details, and arrow keys to pan." tabindex="0">
            <title>Project knowledge map</title>
            <desc>${nodes.length} tracked nodes and ${edges.length} relationships, including ${unsettledRelationshipCount} unsettled relationships. Current-use status and evidence posture vary independently by node and relationship. Select a node to trace its local neighborhood.</desc>
            <defs>
              <marker id="edge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(137,167,186,.42)"></path>
              </marker>
              <marker id="edge-arrow-unsettled" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(240,186,100,.82)"></path>
              </marker>
            </defs>
            <g id="map-world"></g>
          </svg>
          <div class="map-welcome" id="map-welcome">
            <p class="eyebrow">A living mental model</p>
            <strong>Follow the most connected idea</strong>
            <span>Open a node to reveal its immediate neighborhood and evidence posture.</span>
            <button class="secondary-button" type="button" data-map-action="start">Start at the center</button>
            ${unsettledCount || unsettledRelationshipCount ? `<small>${plural(unsettledCount, "unsettled node")} · ${plural(unsettledRelationshipCount, "unsettled relationship")}</small>` : ""}
          </div>
          <div class="map-empty-filter" id="map-empty-filter" role="status" hidden>
            <strong>No nodes match</strong><span>Clear or broaden the current filters.</span>
            <button type="button" class="secondary-button" data-map-action="clear-filters">Clear filters</button>
          </div>
          <div class="map-legend" aria-label="Node type legend">${legend}</div>
          <aside class="node-panel" id="node-panel" aria-label="Selected node details"></aside>
        </div>
        <details class="map-table-view">
          <summary>Browse the same map as an accessible table</summary>
          <div class="map-table-scroll" role="region" aria-label="Scrollable filtered project knowledge table" tabindex="0">
            <table>
              <caption>Filtered project knowledge nodes. Activate a node name to open its details.</caption>
              <thead><tr><th scope="col">Node</th><th scope="col">Type</th><th scope="col">Current-use status</th><th scope="col">Confidence</th><th scope="col">Evidence</th></tr></thead>
              <tbody id="map-table-body"></tbody>
            </table>
          </div>
        </details>
      </div>`,
    );

    bindMapEvents();
    applyMapFilters();
    window.requestAnimationFrame(fitGraphToStage);
  }

  function graphFilterValues() {
    return {
      query: document.querySelector("#map-query-filter")?.value.trim().toLowerCase() || "",
      type: document.querySelector("#map-type-filter")?.value || "all",
      status: document.querySelector("#map-status-filter")?.value || "all",
      unsettledOnly: Boolean(document.querySelector("#map-stale-filter")?.checked),
    };
  }

  function applyMapFilters() {
    const filters = graphFilterValues();
    state.graph.query = filters.query;
    state.graph.visibleIds = new Set(
      state.graph.nodes
        .filter((node) => {
          if (
            filters.query &&
            !`${node.title} ${node.summary} ${node.type} ${node.presentationStatus}`.toLowerCase().includes(filters.query)
          )
            return false;
          if (filters.type !== "all" && node.type !== filters.type) return false;
          if (filters.status !== "all" && node.presentationStatus !== filters.status) return false;
          if (filters.unsettledOnly && node.settled) return false;
          return true;
        })
        .map((node) => node.id),
    );

    if (state.graph.selectedId && !state.graph.visibleIds.has(state.graph.selectedId)) {
      state.graph.selectedId = null;
      closeNodePanel();
    }
    renderGraphWorld();
  }

  function graphTransform() {
    const stage = document.querySelector("#map-stage");
    if (!stage) return { centerX: 0, centerY: 0 };
    const rectangle = stage.getBoundingClientRect();
    return { centerX: rectangle.width / 2, centerY: rectangle.height / 2 };
  }

  function updateGraphTransform() {
    const world = document.querySelector("#map-world");
    if (!world) return;
    const { centerX, centerY } = graphTransform();
    world.setAttribute("transform", `translate(${centerX + state.graph.panX} ${centerY + state.graph.panY}) scale(${state.graph.zoom})`);
    const zoomLabel = document.querySelector("#map-zoom-level");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(state.graph.zoom * 100)}%`;
  }

  function renderGraphWorld() {
    const world = document.querySelector("#map-world");
    if (!world) return;
    const visibleNodes = state.graph.nodes.filter((node) => state.graph.visibleIds.has(node.id));
    const visibleEdges = state.graph.edges.filter(
      (edge) => state.graph.visibleIds.has(edge.source) && state.graph.visibleIds.has(edge.target),
    );
    const selected = state.graph.selectedId;
    const neighborhood = new Set(selected ? [selected] : []);
    if (selected) {
      visibleEdges.forEach((edge) => {
        if (edge.source === selected) neighborhood.add(edge.target);
        if (edge.target === selected) neighborhood.add(edge.source);
      });
    }

    const edgeMarkup = visibleEdges
      .map((edge) => {
        const source = state.graph.positions.get(edge.source);
        const target = state.graph.positions.get(edge.target);
        if (!source || !target) return "";
        const connected = selected && (edge.source === selected || edge.target === selected);
        const label = `${titleCase(edge.type)}; ${edge.settled ? "settled" : `${titleCase(edge.status)}, not settled`} for current use; authority ${titleCase(edge.authority)}. ${edge.reason}`;
        return `<line class="edge${edge.settled ? "" : " is-unsettled"}${connected ? " is-connected" : ""}${selected && !connected ? " is-dimmed" : ""}" data-status="${escapeAttr(safeToken(edge.status))}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" marker-end="url(#${edge.settled ? "edge-arrow" : "edge-arrow-unsettled"})"><title>${escapeHTML(label)}</title></line>`;
      })
      .join("");

    const nodeMarkup = visibleNodes
      .map((node) => {
        const position = state.graph.positions.get(node.id) || { x: 0, y: 0 };
        const confidence = confidenceInfo(node.confidence);
        const label = `${node.title}, ${titleCase(node.type)}, ${titleCase(node.presentationStatus)} current-use status, ${node.settled ? "settled" : "not settled"}, ${confidence.label}, ${plural(node.evidenceCount, "evidence source")}`;
        const rovingNodeId = selected || visibleNodes[0]?.id;
        return `
        <g class="node${node.id === selected ? " is-selected" : ""}${selected && !neighborhood.has(node.id) ? " is-dimmed" : ""}" data-node-id="${escapeAttr(node.id)}" data-type="${escapeAttr(safeToken(node.type))}" transform="translate(${position.x} ${position.y})" tabindex="${node.id === rovingNodeId ? "0" : "-1"}" role="button" aria-pressed="${node.id === selected}" aria-label="${escapeAttr(label)}">
          <rect class="node-card" x="-80" y="-34" width="160" height="68" rx="10"></rect>
          <rect class="node-accent" x="-80" y="-34" width="4" height="68" rx="2"></rect>
          <text class="node-type" x="-67" y="-17">${escapeHTML(truncate(node.type.toUpperCase(), 20))}</text>
          <text class="node-title" x="-67" y="2">${escapeHTML(truncate(node.title, 23))}</text>
          <text class="node-status" x="-67" y="20">${escapeHTML(`${confidence.short} · ${node.evidenceCount} sources`)}</text>
          ${node.settled ? "" : `<text class="node-warning" x="65" y="-17" text-anchor="end">${escapeHTML(truncate(node.presentationStatus.toUpperCase(), 12))}</text>`}
        </g>`;
      })
      .join("");

    world.innerHTML = `${edgeMarkup}${nodeMarkup}`;
    updateGraphTransform();
    const count = document.querySelector("#map-result-count");
    if (count)
      count.textContent = `${visibleNodes.length} nodes · ${visibleEdges.length} relationships · ${visibleEdges.filter((edge) => !edge.settled).length} unsettled links`;
    const empty = document.querySelector("#map-empty-filter");
    if (empty) empty.hidden = visibleNodes.length > 0;
    const tableBody = document.querySelector("#map-table-body");
    if (tableBody)
      tableBody.innerHTML =
        visibleNodes.length > 0
          ? visibleNodes
              .map((node) => {
                const confidence = confidenceInfo(node.confidence);
                return `<tr${node.id === selected ? ' aria-current="true"' : ""}>
          <th scope="row"><button type="button" class="map-table-node" data-node-jump="${escapeAttr(node.id)}">${escapeHTML(node.title)}</button><small>${escapeHTML(node.summary || "No summary recorded.")}</small></th>
          <td>${escapeHTML(titleCase(node.type))}</td>
          <td>${escapeHTML(titleCase(node.presentationStatus))}</td>
          <td>${escapeHTML(confidence.label)}</td>
          <td>${node.evidenceCount}</td>
        </tr>`;
              })
              .join("")
          : '<tr><td colspan="5">No nodes match the current filters.</td></tr>';
    if (!visibleNodes.length) {
      world.innerHTML = "";
    }
  }

  function selectNode(id, focusPanel = false) {
    const node = state.graph.nodes.find((candidate) => candidate.id === id);
    if (!node || !state.graph.visibleIds.has(id)) return;
    state.graph.selectedId = id;
    document.querySelector("#map-welcome")?.setAttribute("hidden", "");
    renderGraphWorld();
    renderNodePanel(node);
    announce(
      `${node.title} selected. ${titleCase(node.presentationStatus)} and ${node.settled ? "settled" : "not settled"} for current use. ${plural(node.evidenceCount, "evidence source")}.`,
    );
    if (focusPanel) document.querySelector("#node-panel [data-close-node]")?.focus();
  }

  function renderNodePanel(node) {
    const panel = document.querySelector("#node-panel");
    if (!panel) return;
    const confidence = confidenceInfo(node.confidence);
    const status = node.presentationStatus || "unknown";
    const relationships = state.graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const neighborRows = relationships
      .slice(0, 8)
      .map((edge) => {
        const outgoing = edge.source === node.id;
        const neighborId = outgoing ? edge.target : edge.source;
        const neighbor = state.graph.nodes.find((candidate) => candidate.id === neighborId);
        if (!neighbor) return "";
        return `<button class="neighbor-button" type="button" data-node-jump="${escapeAttr(neighbor.id)}" data-settled="${edge.settled}" aria-label="${escapeAttr(`${outgoing ? "Outgoing" : "Incoming"} ${titleCase(edge.type)} relationship to ${neighbor.title}; ${edge.settled ? "settled" : "not settled"} for current use. ${edge.reason}`)}"><span>${outgoing ? "→" : "←"} ${escapeHTML(titleCase(edge.type))}<em>${edge.settled ? "Current link" : `${titleCase(edge.status)} link`}</em></span><strong>${escapeHTML(neighbor.title)}</strong><small class="relationship-meta">Authority: ${escapeHTML(titleCase(edge.authority))} · ${plural(edge.evidenceIds.length, "evidence source")}</small>${edge.settled ? "" : `<small>${escapeHTML(edge.reason)}</small>`}</button>`;
      })
      .join("");
    panel.innerHTML = `
      <div class="node-panel-header">
        <div><p class="eyebrow">${escapeHTML(titleCase(node.type))}</p><h2>${escapeHTML(node.title)}</h2></div>
        <button class="icon-button" type="button" data-close-node aria-label="Close node details">×</button>
      </div>
      <div class="badge-row">
        <span class="badge" data-tone="${escapeAttr(statusTone(status))}">${escapeHTML(titleCase(status))}</span>
        <span class="badge" data-tone="${escapeAttr(confidence.tone)}">${escapeHTML(confidence.label)}</span>
        <span class="badge" data-tone="${node.evidenceCount ? "info" : "danger"}">${node.evidenceCount} evidence ${node.evidenceCount === 1 ? "source" : "sources"}</span>
        ${node.settled ? '<span class="badge" data-tone="good">Settled for current use</span>' : '<span class="badge" data-tone="warning">Not settled for current use</span>'}
      </div>
      <p class="node-summary">${escapeHTML(node.summary || "No plain-language explanation has been recorded for this node.")}</p>
      <div class="detail-grid">
        <div class="detail-item"><span>Node ID</span><strong title="${escapeAttr(node.id)}">${escapeHTML(node.id)}</strong></div>
        <div class="detail-item"><span>Type</span><strong>${escapeHTML(titleCase(node.type))}</strong></div>
        <div class="detail-item"><span>Current-use status</span><strong>${escapeHTML(titleCase(status))}</strong></div>
        <div class="detail-item"><span>Authority</span><strong>${escapeHTML(titleCase(node.authority))}</strong></div>
        <div class="detail-item"><span>Evidence</span><strong>${node.evidenceCount} ${node.evidenceCount === 1 ? "source" : "sources"}</strong></div>
      </div>
      <div class="provenance-callout" data-status="${escapeAttr(safeToken(status))}"><strong>Current-use status:</strong> ${escapeHTML(node.reason)}</div>
      <div class="evidence-id-list"><strong>Evidence identifiers</strong>${node.evidenceIds.length ? `<ul>${node.evidenceIds.map((id) => `<li><code>${escapeHTML(id)}</code></li>`).join("")}</ul>` : "<p>No current evidence identifier was returned for this node.</p>"}</div>
      <div class="node-neighborhood">
        <div class="node-neighborhood-heading"><span>Immediate neighborhood</span><strong>${plural(relationships.length, "relationship")}</strong></div>
        ${relationships.some((edge) => !edge.settled) ? '<div class="relationship-warning"><strong>Unsettled topology</strong><span>One or more links below are stale, conflicting, or otherwise unverified. Do not infer current architecture from those links.</span></div>' : ""}
        ${neighborRows || '<p class="node-neighborhood-empty">No relationships connect this node in the current map.</p>'}
      </div>
      <div class="provenance-callout"><strong>Evidence note:</strong> Confidence is a signal, not proof. Verify important claims against their linked source evidence before changing code.</div>`;
    panel.classList.add("is-open");
  }

  function closeNodePanel() {
    const panel = document.querySelector("#node-panel");
    if (!panel) return;
    panel.classList.remove("is-open");
    window.setTimeout(() => {
      if (!panel.classList.contains("is-open")) panel.innerHTML = "";
    }, 190);
  }

  function setGraphZoom(nextZoom, anchor) {
    const oldZoom = state.graph.zoom;
    const zoom = clamp(nextZoom, 0.3, 2.6);
    if (zoom === oldZoom) return;
    if (anchor) {
      const { centerX, centerY } = graphTransform();
      const worldX = (anchor.x - centerX - state.graph.panX) / oldZoom;
      const worldY = (anchor.y - centerY - state.graph.panY) / oldZoom;
      state.graph.panX = anchor.x - centerX - worldX * zoom;
      state.graph.panY = anchor.y - centerY - worldY * zoom;
    }
    state.graph.zoom = zoom;
    updateGraphTransform();
  }

  function centerNode(id) {
    const position = state.graph.positions.get(id);
    if (!position) return;
    state.graph.panX = -position.x * state.graph.zoom;
    state.graph.panY = -position.y * state.graph.zoom;
    updateGraphTransform();
  }

  function focusSpatialNode(id, key) {
    const origin = state.graph.positions.get(id);
    if (!origin) return false;
    const candidates = state.graph.nodes
      .filter((node) => node.id !== id && state.graph.visibleIds.has(node.id))
      .map((node) => {
        const position = state.graph.positions.get(node.id);
        if (!position) return null;
        const dx = position.x - origin.x;
        const dy = position.y - origin.y;
        const directional = key === "ArrowLeft" ? dx < 0 : key === "ArrowRight" ? dx > 0 : key === "ArrowUp" ? dy < 0 : dy > 0;
        if (!directional) return null;
        const primary = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dx) : Math.abs(dy);
        const cross = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
        return { id: node.id, score: primary + cross * 1.8 };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    const next = candidates[0];
    if (!next) return false;
    document.querySelectorAll("#map-world .node").forEach((node) => {
      node.setAttribute("tabindex", node.dataset.nodeId === next.id ? "0" : "-1");
    });
    document.querySelector(`.node[data-node-id="${CSS.escape(next.id)}"]`)?.focus();
    return true;
  }

  function fitGraphToStage() {
    const visiblePositions = state.graph.nodes
      .filter((node) => state.graph.visibleIds.has(node.id))
      .map((node) => state.graph.positions.get(node.id))
      .filter(Boolean);
    const stage = document.querySelector("#map-stage");
    if (!stage || !visiblePositions.length) return;
    const rectangle = stage.getBoundingClientRect();
    const xs = visiblePositions.map((position) => position.x);
    const ys = visiblePositions.map((position) => position.y);
    const width = Math.max(180, Math.max(...xs) - Math.min(...xs) + 220);
    const height = Math.max(100, Math.max(...ys) - Math.min(...ys) + 150);
    state.graph.zoom = clamp(Math.min((rectangle.width - 40) / width, (rectangle.height - 40) / height), 0.3, 1.15);
    state.graph.panX = -((Math.max(...xs) + Math.min(...xs)) / 2) * state.graph.zoom;
    state.graph.panY = -((Math.max(...ys) + Math.min(...ys)) / 2) * state.graph.zoom;
    updateGraphTransform();
  }

  function bindMapEvents() {
    const svg = document.querySelector("#map-svg");
    const stage = document.querySelector("#map-stage");
    if (!svg || !stage) return;

    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rectangle = svg.getBoundingClientRect();
        const anchor = { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
        setGraphZoom(state.graph.zoom * (event.deltaY < 0 ? 1.12 : 0.89), anchor);
      },
      { passive: false },
    );

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".node")) return;
      state.graph.dragging = true;
      state.graph.pointerId = event.pointerId;
      state.graph.startX = event.clientX;
      state.graph.startY = event.clientY;
      state.graph.startPanX = state.graph.panX;
      state.graph.startPanY = state.graph.panY;
      svg.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
    });

    svg.addEventListener("pointermove", (event) => {
      if (!state.graph.dragging || event.pointerId !== state.graph.pointerId) return;
      state.graph.panX = state.graph.startPanX + event.clientX - state.graph.startX;
      state.graph.panY = state.graph.startPanY + event.clientY - state.graph.startY;
      updateGraphTransform();
    });

    const endDrag = (event) => {
      if (!state.graph.dragging || event.pointerId !== state.graph.pointerId) return;
      state.graph.dragging = false;
      state.graph.pointerId = null;
      stage.classList.remove("is-dragging");
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    svg.addEventListener("click", (event) => {
      const target = event.target.closest(".node");
      if (target) selectNode(target.dataset.nodeId);
    });

    svg.addEventListener("keydown", (event) => {
      const target = event.target.closest(".node");
      if (target && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        selectNode(target.dataset.nodeId, true);
        return;
      }
      if (target && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        if (focusSpatialNode(target.dataset.nodeId, event.key)) event.preventDefault();
        return;
      }
      const movement = 35;
      if (event.key === "ArrowLeft") state.graph.panX += movement;
      else if (event.key === "ArrowRight") state.graph.panX -= movement;
      else if (event.key === "ArrowUp") state.graph.panY += movement;
      else if (event.key === "ArrowDown") state.graph.panY -= movement;
      else if (event.key === "+" || event.key === "=") setGraphZoom(state.graph.zoom * 1.12);
      else if (event.key === "-") setGraphZoom(state.graph.zoom * 0.89);
      else return;
      event.preventDefault();
      updateGraphTransform();
    });

    document.querySelector("#map-query-filter")?.addEventListener("input", applyMapFilters);
  }

  function renderTimeline(data) {
    const events = asArray(data.events)
      .map(normalizeEvent)
      .sort((a, b) => {
        const aTime = new Date(a.timestamp).getTime();
        const bTime = new Date(b.timestamp).getTime();
        if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
        return bTime - aTime;
      });
    state.timeline.query = "";
    state.timeline.type = "all";
    state.timeline.activeIndex = -1;

    if (!events.length) {
      setViewState(
        "timeline",
        "empty",
        emptyMarkup(
          "No project history yet",
          "The timeline endpoint returned no events. History will appear here without overwriting earlier decisions.",
        ),
      );
      return;
    }

    const types = uniqueValues(events, "type");
    const options = types.map((type) => `<option value="${escapeAttr(type)}">${escapeHTML(titleCase(type))}</option>`).join("");
    const validDates = events.map((event) => new Date(event.timestamp)).filter((date) => !Number.isNaN(date.getTime()));
    const newest = validDates[0];
    const oldest = validDates[validDates.length - 1];
    const spanDays = newest && oldest ? Math.max(1, Math.ceil((newest.getTime() - oldest.getTime()) / 86_400_000)) : 0;
    const evidenceTotal = events.reduce((total, event) => total + eventEvidenceTotal(event), 0);
    setViewState(
      "timeline",
      "ready",
      `
      <div class="timeline-page">
        <section class="journey-strip surface" aria-labelledby="journey-title">
          <div class="journey-copy"><p class="eyebrow">Repository story</p><h2 id="journey-title">From first recorded change to now</h2><p>${plural(events.length, "event")} across ${plural(spanDays, "day")}—with uncertainty kept visible.</p></div>
          <div class="journey-rail" aria-hidden="true"><i></i><span></span><i></i></div>
          <div class="journey-ends"><time datetime="${escapeAttr(oldest?.toISOString() || "")}"><small>Beginning</small>${escapeHTML(oldest ? formatDate(oldest) : "Unknown")}</time><time datetime="${escapeAttr(newest?.toISOString() || "")}"><small>Latest evidence</small>${escapeHTML(newest ? formatDate(newest) : "Unknown")}</time></div>
          <div class="journey-facts"><span><strong>${types.length}</strong> event types</span><span><strong>${evidenceTotal}</strong> evidence links</span></div>
        </section>
        <div class="timeline-toolbar surface">
          <label class="inline-search">
            <span class="sr-only">Search the timeline</span>${ICONS.search}
            <input id="timeline-search" type="search" placeholder="Filter events by title, summary, commit, or file…" autocomplete="off" />
          </label>
          <div class="filter-row">
            <span class="filter-label">Event type</span>
            <label class="select-wrap"><span class="sr-only">Filter timeline by event type</span><select id="timeline-type-filter"><option value="all">All types</option>${options}</select></label>
            <button class="filter-reset" type="button" data-timeline-jump="oldest">Beginning</button>
            <button class="filter-reset" type="button" data-timeline-jump="newest">Latest</button>
            <span class="result-count" id="timeline-result-count" role="status"></span>
          </div>
        </div>
        <section class="timeline-surface surface" aria-label="Project event history">
          <div class="section-heading">
            <div><p class="eyebrow">Immutable chronology</p><h2>How the project arrived here</h2><p>Events preserve what changed and the evidence available at the time.</p></div>
          </div>
          <div class="timeline-list" id="timeline-list"></div>
        </section>
      </div>`,
    );

    document.querySelector("#timeline-search")?.addEventListener("input", (event) => {
      state.timeline.query = event.target.value.trim().toLowerCase();
      renderTimelineEvents(events);
    });
    document.querySelector("#timeline-type-filter")?.addEventListener("change", (event) => {
      state.timeline.type = event.target.value;
      renderTimelineEvents(events);
    });
    renderTimelineEvents(events);
  }

  function eventSearchText(event) {
    const files = event.files.map((file) => `${file.status} ${file.path} ${file.previousPath}`).join(" ");
    const evidence = Array.isArray(event.evidence) ? event.evidence.join(" ") : String(event.evidence ?? "");
    return `${event.title} ${event.summary} ${event.type} ${event.commit} ${files} ${evidence}`.toLowerCase();
  }

  function eventEvidenceTotal(event) {
    if (Array.isArray(event.evidence)) return event.evidence.length;
    if (event.evidence && typeof event.evidence === "object") return Object.keys(event.evidence).length;
    if (typeof event.evidence === "number") return Math.max(0, Math.round(event.evidence));
    return event.evidence ? 1 : 0;
  }

  function renderTimelineEvents(events) {
    const list = document.querySelector("#timeline-list");
    const count = document.querySelector("#timeline-result-count");
    if (!list) return;
    const filtered = events.filter((event) => {
      if (state.timeline.type !== "all" && event.type !== state.timeline.type) return false;
      return !state.timeline.query || eventSearchText(event).includes(state.timeline.query);
    });
    if (count) count.textContent = `${filtered.length} of ${events.length}`;
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state"><h3>No matching events</h3><p>Try a broader phrase or choose a different event type.</p></div>`;
      return;
    }

    const chapters = new Map();
    filtered.forEach((event) => {
      const date = new Date(event.timestamp);
      const key = Number.isNaN(date.getTime())
        ? "Unknown date"
        : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long" }).format(date);
      if (!chapters.has(key)) chapters.set(key, []);
      chapters.get(key).push(event);
    });

    list.innerHTML = [...chapters.entries()]
      .map(
        ([chapter, chapterEvents]) => `<section class="timeline-chapter" aria-labelledby="chapter-${escapeAttr(safeToken(chapter))}">
      <header class="chapter-heading"><h3 id="chapter-${escapeAttr(safeToken(chapter))}">${escapeHTML(chapter)}</h3><span>${plural(chapterEvents.length, "event")}</span></header>
      ${chapterEvents
        .map((event) => {
          const evidence = eventEvidenceTotal(event);
          const files = event.files
            .slice(0, 3)
            .map((file) => {
              const label = `${file.status ? `${file.status} ` : ""}${file.path}`;
              const title = file.previousPath ? `${label} (previously ${file.previousPath})` : label;
              return `<span class="meta-chip" title="${escapeAttr(title)}">${ICONS.file}${escapeHTML(label)}</span>`;
            })
            .join("");
          const remaining = Math.max(0, event.files.length - 3);
          return `
        <article class="timeline-event" data-timeline-event="${escapeAttr(event.id)}">
          <div class="timeline-date">
            <time datetime="${escapeAttr(event.timestamp)}">${escapeHTML(formatDate(event.timestamp))}</time>
            <span>${escapeHTML(formatTime(event.timestamp))}</span>
          </div>
          <div class="timeline-card">
            <div class="timeline-card-header">
              <div class="timeline-title-wrap"><span class="type-glyph" data-tone="${escapeAttr(safeToken(event.type))}" aria-hidden="true">${escapeHTML(event.type.slice(0, 1) || "E")}</span><h3>${escapeHTML(event.title)}</h3></div>
              <span class="badge" data-tone="info">${escapeHTML(titleCase(event.type))}</span>
            </div>
            <p>${escapeHTML(event.summary || "No explanation was recorded for this event.")}</p>
            <details class="event-provenance">
              <summary><span>${ICONS.source}${evidence ? `${plural(evidence, "evidence source")}` : "Evidence gap"}</span><span>Inspect provenance</span></summary>
              <div class="event-meta" aria-label="Event provenance">
                ${event.commit ? `<span class="meta-chip" title="Commit ${escapeAttr(event.commit)}">${ICONS.commit}${escapeHTML(truncate(event.commit, 14))}</span>` : ""}
                ${files}${remaining ? `<span class="meta-chip">+${remaining} more files</span>` : ""}
                <span class="badge" data-tone="${evidence ? "good" : "danger"}">${evidence ? "Evidence linked" : "No evidence linked"}</span>
              </div>
            </details>
          </div>
        </article>`;
        })
        .join("")}
    </section>`,
      )
      .join("");
  }

  function navigateTimeline(direction) {
    const targets = [...document.querySelectorAll("#timeline-list .event-provenance > summary")];
    if (!targets.length) return;
    const focusedIndex = targets.indexOf(document.activeElement);
    const base = focusedIndex >= 0 ? focusedIndex : state.timeline.activeIndex;
    state.timeline.activeIndex = clamp(base + direction, 0, targets.length - 1);
    targets.forEach((target, index) => {
      target.closest(".timeline-event")?.classList.toggle("is-keyboard-active", index === state.timeline.activeIndex);
    });
    targets[state.timeline.activeIndex].focus();
    targets[state.timeline.activeIndex].scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
    announce(`Timeline event ${state.timeline.activeIndex + 1} of ${targets.length}.`);
  }

  function healthScoreCopy(score, verdict, criticalCount, warningCount) {
    if (verdict === "blocked" || criticalCount > 0) {
      return {
        label: "Context use blocked",
        text: `${criticalCount || 1} critical knowledge-integrity finding${criticalCount === 1 ? "" : "s"} must be resolved before this memory is used for a coding decision.`,
        tone: "danger",
      };
    }
    if (verdict === "degraded" || warningCount > 0) {
      return {
        label: "Context needs review",
        text: `${warningCount || 1} warning${warningCount === 1 ? "" : "s"} may leave project context incomplete or unsettled. Inspect the affected checks and components.`,
        tone: "warning",
      };
    }
    if (score >= 85)
      return {
        label: "Well grounded",
        text: "Most tracked context appears current and evidence-backed. Keep reviewing proposals before they become project memory.",
        tone: "good",
      };
    if (score >= 65)
      return {
        label: "Needs attention",
        text: "The project memory is useful, but gaps or stale claims could mislead a developer or coding assistant.",
        tone: "warning",
      };
    return {
      label: "Context at risk",
      text: "Important knowledge is missing, stale, or weakly evidenced. Verify claims before relying on this context for code changes.",
      tone: "danger",
    };
  }

  function normalizeCheck(check, index) {
    const object = asObject(check);
    return {
      id: String(object.id ?? `check-${index}`),
      label: String(object.label || object.title || `Health check ${index + 1}`),
      status: String(object.status || "unknown"),
      severity: String(object.severity ?? "unknown"),
      details: String(object.details || object.summary || ""),
      recommendation: String(object.recommendation || ""),
    };
  }

  function pendingProposalCount(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return Math.max(0, Math.round(safeNumber(value, 0)));
  }

  function renderHealth(data) {
    const score = Math.round(clamp(safeNumber(data.score, 0), 0, 100));
    const checks = asArray(data.checks).map(normalizeCheck);
    const components = asArray(data.components).map((component, index) => {
      const object = asObject(component);
      return {
        id: String(object.id ?? `component-${index}`),
        title: String(object.title || `Component ${index + 1}`),
        status: String(object.status || "unsupported"),
        reason: String(object.reason || "No component-health explanation was returned."),
        evidenceIds: asArray(object.evidenceIds).map(String),
        lastSeen: String(object.lastSeen || "unknown"),
      };
    });
    const proposals = pendingProposalCount(data.pendingProposals);
    updateReviewCounts(proposals);
    const criticalCount = Math.max(
      0,
      Math.round(safeNumber(data.criticalCount, checks.filter((check) => check.status === "critical").length)),
    );
    const warningCount = Math.max(
      0,
      Math.round(safeNumber(data.warningCount, checks.filter((check) => check.status === "warning").length)),
    );
    const verdict = String(data.verdict || (criticalCount > 0 ? "blocked" : warningCount > 0 ? "degraded" : "healthy"));
    const copy = healthScoreCopy(score, verdict, criticalCount, warningCount);
    state.health.filter = "all";
    const tones = checks.map((check) => statusTone(check.status, check.severity));
    const actionCount = tones.filter((tone) => tone !== "good").length;
    const passingCount = tones.filter((tone) => tone === "good").length;

    const checkRows = checks.length
      ? checks
          .map((check) => {
            const tone = statusTone(check.status, check.severity);
            const glyph = tone === "good" ? "✓" : tone === "warning" ? "!" : "×";
            return `
            <article class="health-check" data-check-tone="${escapeAttr(tone)}">
              <span class="check-icon" data-tone="${escapeAttr(tone)}" aria-hidden="true">${glyph}</span>
              <div class="check-body">
                <h3>${escapeHTML(check.label)}</h3>
                <p>${escapeHTML(check.details || `Status: ${titleCase(check.status)}`)}</p>
                ${check.recommendation ? `<div class="recommendation"><strong>Recommended:</strong> ${escapeHTML(check.recommendation)}</div>` : ""}
              </div>
              <span class="severity-label">Severity ${escapeHTML(check.severity)}</span>
            </article>`;
          })
          .join("")
      : `<div class="empty-state"><h3>No health checks returned</h3><p>A score without supporting checks is weak evidence. Inspect the local health pipeline.</p></div>`;

    const componentRows = components.length
      ? components
          .map(
            (component) => `
          <tr>
            <th scope="row">${escapeHTML(component.title)}</th>
            <td><span class="component-health-status" data-status="${escapeAttr(component.status)}">${escapeHTML(titleCase(component.status))}</span></td>
            <td>${escapeHTML(component.reason)}</td>
            <td>${component.evidenceIds.length ? component.evidenceIds.map((id) => `<code>${escapeHTML(id)}</code>`).join("<br>") : "No evidence"}</td>
            <td><time datetime="${escapeAttr(component.lastSeen)}">${escapeHTML(formatDate(component.lastSeen))}</time></td>
          </tr>`,
          )
          .join("")
      : `<tr><td colspan="5">No component snapshots are available yet. Run an explicit synchronization before relying on component coverage.</td></tr>`;

    setViewState(
      "health",
      "ready",
      `
      <div class="health-page">
        <section class="health-hero surface">
          <div class="score-ring" data-tone="${escapeAttr(copy.tone)}" role="img" aria-label="Context verdict ${escapeAttr(verdict)}; compatibility score ${score} out of 100">
            <svg class="score-ring-chart" viewBox="0 0 120 120" aria-hidden="true">
              <circle class="score-ring-track" cx="60" cy="60" r="52"></circle>
              <circle class="score-ring-progress" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${score} 100"></circle>
            </svg>
            <div class="score-value"><strong>${score}</strong><span>out of 100</span></div>
          </div>
          <div class="health-copy">
            <p class="eyebrow">Context health · evidence, freshness, coverage</p>
            <h2>${escapeHTML(copy.label)}</h2>
            <p>${escapeHTML(copy.text)}</p>
            <p class="health-verdict"><strong>${escapeHTML(titleCase(verdict))}</strong> &middot; ${criticalCount} critical &middot; ${warningCount} warning</p>
          </div>
          <button class="proposal-count" type="button" data-go-view="review" aria-label="Open ${plural(proposals, "pending proposal")} in the human review workspace">
            <span>Awaiting human review</span><strong>${proposals}</strong><small>Open pending ${proposals === 1 ? "proposal" : "proposals"} →</small>
          </button>
        </section>
        <div class="health-layout">
          <section class="section-card surface">
            <div class="section-heading"><div><p class="eyebrow">Diagnostic evidence</p><h2>Health checks</h2><p>${checks.length} checks returned by the local service</p></div></div>
            <div class="health-filters" role="group" aria-label="Filter health checks">
              <button type="button" data-health-filter="all" aria-pressed="true">All <span>${checks.length}</span></button>
              <button type="button" data-health-filter="action" aria-pressed="false">Needs action <span>${actionCount}</span></button>
              <button type="button" data-health-filter="good" aria-pressed="false">Passing <span>${passingCount}</span></button>
              <strong id="health-filter-status" role="status">Showing all checks</strong>
            </div>
            <div class="check-list">${checkRows}</div>
            <section class="component-health-section" aria-labelledby="component-health-heading">
              <div class="section-heading"><div><p class="eyebrow">Component coverage</p><h2 id="component-health-heading">Freshness and evidence by component</h2><p>Each status includes its reason and supporting evidence identifier.</p></div></div>
              <div class="component-health-scroll" role="region" aria-label="Scrollable component freshness and evidence table" tabindex="0">
                <table>
                  <caption>${components.length} tracked ${components.length === 1 ? "component" : "components"}</caption>
                  <thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col">Evidence</th><th scope="col">Last observed</th></tr></thead>
                  <tbody>${componentRows}</tbody>
                </table>
              </div>
            </section>
          </section>
          <aside class="section-card surface health-guide">
            <h3>How to read this</h3>
            <p>Health measures the quality of tracked context, not the quality or security of the code itself. A high score is not permission to skip source review.</p>
            <div class="score-key">
              <div><i></i><strong>85–100</strong><span>Well grounded</span></div>
              <div><i></i><strong>65–84</strong><span>Needs attention</span></div>
              <div><i></i><strong>0–64</strong><span>Context at risk</span></div>
            </div>
            <div class="provenance-callout"><strong>Human gate:</strong> Pending proposals should be approved or rejected before generated interpretations become durable history.</div>
          </aside>
        </div>
      </div>`,
    );
  }

  function applyHealthFilter(filter) {
    state.health.filter = ["all", "action", "good"].includes(filter) ? filter : "all";
    const rows = [...document.querySelectorAll(".health-check[data-check-tone]")];
    let visible = 0;
    rows.forEach((row) => {
      const matches =
        state.health.filter === "all" ||
        (state.health.filter === "action" && row.dataset.checkTone !== "good") ||
        row.dataset.checkTone === state.health.filter;
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    document.querySelectorAll("[data-health-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.healthFilter === state.health.filter));
    });
    const status = document.querySelector("#health-filter-status");
    if (status) status.textContent = state.health.filter === "all" ? "Showing all checks" : `Showing ${plural(visible, "check")}`;
  }

  function normalizeReviewEvidence(value, index) {
    const evidence = asObject(value);
    const validation = asObject(evidence.validation);
    const permittedForCurrentUse = evidence.permittedForCurrentUse === true && validation.outcome === "verified";
    return {
      id: String(evidence.id || `evidence-${index}`),
      kind: String(evidence.kind || "unknown"),
      locator: String(evidence.locator || "[unavailable]"),
      observedAt: String(evidence.observedAt || ""),
      permittedForCurrentUse,
      status: String(validation.status || (permittedForCurrentUse ? "verified" : "unknown")),
      details: String(
        validation.details ||
          (permittedForCurrentUse
            ? "The local service verified this evidence for the current repository snapshot."
            : "This evidence was not verified for current use."),
      ),
    };
  }

  function normalizeReviewProposal(value, index) {
    const proposal = asObject(value);
    const evidence = asArray(proposal.evidence).map(normalizeReviewEvidence);
    const declaredReady = proposal.evidenceReady === true;
    return {
      id: String(proposal.id || `proposal-${index}`),
      kind: String(proposal.kind || "context_update"),
      targetId: proposal.targetId ? String(proposal.targetId) : "",
      title: String(proposal.title || `Proposal ${index + 1}`),
      summary: String(proposal.summary || "No proposal summary was recorded."),
      evidence,
      evidenceIds: asArray(proposal.evidenceIds).map(String),
      evidenceReady: declaredReady && evidence.length > 0 && evidence.every((item) => item.permittedForCurrentUse),
      riskFlags: asArray(proposal.riskFlags).map(String),
      status: String(proposal.status || "pending"),
      createdAt: String(proposal.createdAt || ""),
      reviewedAt: String(proposal.reviewedAt || ""),
      reviewNote: String(proposal.reviewNote || ""),
      conflictGroup: proposal.conflictGroup ? String(proposal.conflictGroup) : "",
      reviewTrail: asArray(proposal.reviewTrail).map((item) => asObject(item)),
    };
  }

  function updateReviewCounts(count) {
    const pending = Math.max(0, Math.round(safeNumber(count, 0)));
    document.querySelectorAll("[data-review-count]").forEach((badge) => {
      badge.hidden = pending === 0;
      badge.textContent = pending > 99 ? "99+" : String(pending);
      badge.setAttribute("aria-label", `${plural(pending, "pending proposal")}`);
    });
  }

  async function refreshReviewBadge() {
    try {
      const pending = await fetchJSON(API.proposals);
      updateReviewCounts(asArray(pending).length);
    } catch {
      // The badge is supplementary; the selected view reports service errors.
    }
  }

  function reviewEvidenceMarkup(evidence) {
    if (!evidence.length) {
      return `<div class="review-evidence-warning" data-tone="danger"><strong>No usable evidence</strong><span>Approval is blocked until the proposal is recreated with current, verified evidence.</span></div>`;
    }
    return `<ul class="review-evidence-list">${evidence
      .map(
        (item) => `
      <li data-current="${item.permittedForCurrentUse}">
        <span class="evidence-state-dot" aria-hidden="true"></span>
        <div>
          <div class="review-evidence-title"><code>${escapeHTML(item.id)}</code><span>${escapeHTML(titleCase(item.kind))}</span></div>
          <p>${escapeHTML(item.details)}</p>
          <div class="review-evidence-meta">
            <span>${escapeHTML(item.status === "verified" ? "Verified now" : titleCase(item.status))}</span>
            <span>${escapeHTML(item.locator)}</span>
            ${item.observedAt ? `<time datetime="${escapeAttr(item.observedAt)}">Observed ${escapeHTML(formatDate(item.observedAt))}</time>` : ""}
          </div>
        </div>
      </li>`,
      )
      .join("")}</ul>`;
  }

  function reviewProposalCard(proposal, unresolvedConflict, index) {
    const approvalBlocked = !proposal.evidenceReady || unresolvedConflict;
    const approvalReason = unresolvedConflict
      ? "Reject obsolete alternatives in this conflict set before approving the remaining proposal."
      : !proposal.evidenceReady
        ? "Approval is blocked because current evidence has not been verified."
        : "Approve this proposal into durable project memory.";
    const risks = proposal.riskFlags.length
      ? proposal.riskFlags.map((flag) => `<span class="risk-flag">${escapeHTML(titleCase(flag))}</span>`).join("")
      : `<span class="risk-flag is-neutral">No additional risk flags</span>`;
    return `<article class="review-proposal-card" id="review-proposal-${index}" data-evidence-ready="${proposal.evidenceReady}">
      <header class="review-proposal-heading">
        <div>
          <div class="review-proposal-labels">
            <span class="proposal-kind">${escapeHTML(titleCase(proposal.kind))}</span>
            <span class="evidence-pill" data-current="${proposal.evidenceReady}">${proposal.evidenceReady ? "Evidence current" : "Evidence warning"}</span>
          </div>
          <h3>${escapeHTML(proposal.title)}</h3>
          <p>${escapeHTML(proposal.summary)}</p>
        </div>
        <time datetime="${escapeAttr(proposal.createdAt)}" title="${escapeAttr(proposal.createdAt)}">${escapeHTML(relativeTime(proposal.createdAt))}</time>
      </header>
      <dl class="proposal-facts">
        <div><dt>Proposal ID</dt><dd><code>${escapeHTML(proposal.id)}</code></dd></div>
        <div><dt>Target</dt><dd>${escapeHTML(proposal.targetId || "Project-wide context")}</dd></div>
      </dl>
      <div class="review-risk-flags" aria-label="Proposal risk flags">${risks}</div>
      ${proposal.evidenceReady ? "" : `<div class="review-evidence-warning" data-tone="danger"><strong>Do not approve yet</strong><span>At least one evidence record is missing, stale, policy-denied, or otherwise unverified for the current source snapshot.</span></div>`}
      ${unresolvedConflict ? `<div class="review-evidence-warning" data-tone="warning"><strong>Conflict must be narrowed</strong><span>Compare the alternatives and reject obsolete versions. Approval becomes available when one pending candidate remains.</span></div>` : ""}
      <details class="review-evidence-details">
        <summary>Inspect evidence <span>${proposal.evidence.length}</span></summary>
        ${reviewEvidenceMarkup(proposal.evidence)}
      </details>
      <footer class="review-proposal-actions">
        <p>${escapeHTML(approvalReason)}</p>
        <div>
          <button class="review-reject-button" type="button" data-proposal-action="reject" data-proposal-id="${escapeAttr(proposal.id)}" data-proposal-title="${escapeAttr(proposal.title)}">Reject proposal</button>
          <button class="review-approve-button" type="button" data-proposal-action="approve" data-proposal-id="${escapeAttr(proposal.id)}" data-proposal-title="${escapeAttr(proposal.title)}" ${approvalBlocked ? `disabled aria-disabled="true" title="${escapeAttr(approvalReason)}"` : ""}>Approve proposal</button>
        </div>
      </footer>
    </article>`;
  }

  function reviewHistoryMarkup(history) {
    if (!history.length) {
      return `<div class="review-history-empty"><strong>No review decisions yet</strong><span>Approved and rejected proposals will appear here with their rationale and attributed reviewer.</span></div>`;
    }
    const rows = history
      .map((proposal) => {
        const decisions = proposal.reviewTrail.filter((item) => String(item.action || "") !== "propose");
        const latest = decisions.at(-1) || {};
        const actor = String(latest.actor || "unattributed legacy review");
        const action = String(latest.action || proposal.status);
        return `<tr>
        <td><span class="review-history-status" data-status="${escapeAttr(safeToken(proposal.status))}">${escapeHTML(titleCase(proposal.status))}</span></td>
        <th scope="row"><strong>${escapeHTML(proposal.title)}</strong><code>${escapeHTML(proposal.id)}</code></th>
        <td><strong>${escapeHTML(actor)}</strong><span>${escapeHTML(titleCase(action))}</span></td>
        <td>${escapeHTML(proposal.reviewNote || "No rationale was recorded for this legacy decision.")}</td>
        <td><time datetime="${escapeAttr(proposal.reviewedAt)}">${escapeHTML(formatDate(proposal.reviewedAt || proposal.createdAt))}</time></td>
      </tr>`;
      })
      .join("");
    return `<div class="review-history-scroll" role="region" aria-label="Scrollable proposal decision history" tabindex="0">
      <table>
        <caption>${history.length} recent human review ${history.length === 1 ? "decision" : "decisions"}</caption>
        <thead><tr><th scope="col">Decision</th><th scope="col">Proposal</th><th scope="col">Reviewer</th><th scope="col">Rationale</th><th scope="col">Reviewed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function renderReview(data) {
    const counts = asObject(data.counts);
    const rawGroups = asArray(data.conflictGroups);
    const groups = rawGroups.map((value, groupIndex) => {
      const group = asObject(value);
      return {
        id: String(group.id || `group-${groupIndex}`),
        conflicting: group.conflicting === true,
        targetId: group.targetId ? String(group.targetId) : "",
        proposals: asArray(group.proposals).map(normalizeReviewProposal),
      };
    });
    const history = asArray(data.history).map(normalizeReviewProposal);
    const pending = groups.reduce((sum, group) => sum + group.proposals.length, 0);
    const conflictCount = Math.max(
      0,
      Math.round(safeNumber(counts.conflictGroups, groups.filter((group) => group.proposals.length > 1).length)),
    );
    const evidenceWarnings = Math.max(
      0,
      Math.round(
        safeNumber(
          counts.evidenceWarnings,
          groups.flatMap((group) => group.proposals).filter((proposal) => !proposal.evidenceReady).length,
        ),
      ),
    );
    updateReviewCounts(pending);

    const groupMarkup = groups.length
      ? groups
          .map((group, groupIndex) => {
            const unresolved = group.proposals.length > 1;
            const heading = unresolved
              ? `Conflict set · ${group.proposals.length} alternatives`
              : group.conflicting
                ? "Conflict narrowed · one candidate remains"
                : "Independent proposal";
            return `<section class="review-group" aria-labelledby="review-group-${groupIndex}">
        <header class="review-group-heading" data-conflicting="${unresolved}">
          <div>
            <p class="eyebrow">${escapeHTML(heading)}</p>
            <h2 id="review-group-${groupIndex}">${escapeHTML(group.targetId || group.proposals[0]?.title || "Project context")}</h2>
          </div>
          ${unresolved ? `<span class="conflict-count">Resolve ${group.proposals.length} candidates</span>` : `<span class="conflict-count is-calm">Ready for one decision</span>`}
        </header>
        <div class="review-proposal-grid">${group.proposals.map((proposal, proposalIndex) => reviewProposalCard(proposal, unresolved, groupIndex * 1_000 + proposalIndex)).join("")}</div>
      </section>`;
          })
          .join("")
      : `<div class="review-zero surface">
      <span class="review-zero-mark" aria-hidden="true">✓</span>
      <div><h2>Review queue clear</h2><p>No proposals are waiting for a human decision. New inferred context remains pending until someone explicitly reviews it.</p></div>
    </div>`;

    setViewState(
      "review",
      "ready",
      `<div class="review-page">
      <section class="review-hero surface">
        <div class="review-hero-copy">
          <p class="eyebrow">Human authority boundary</p>
          <h2>Turn proposals into trusted project memory</h2>
          <p>${escapeHTML(String(data.authorityNotice || "Pending proposals are never treated as project truth."))}</p>
        </div>
        <div class="review-metrics" aria-label="Review queue summary">
          <div><strong>${pending}</strong><span>Pending</span></div>
          <div data-tone="${conflictCount ? "danger" : "good"}"><strong>${conflictCount}</strong><span>Conflict groups</span></div>
          <div data-tone="${evidenceWarnings ? "warning" : "good"}"><strong>${evidenceWarnings}</strong><span>Evidence warnings</span></div>
          <div><strong>${history.length}</strong><span>Recent decisions</span></div>
        </div>
        <div class="review-boundary-note"><strong>Local human gate</strong><span>Every decision requires a confirmation dialog, an attributed <code>human:&lt;id&gt;</code>, a rationale, current in-memory session proof, and the exact same browser origin.</span></div>
        ${evidenceWarnings ? `<div class="review-global-warning" role="status"><strong>Evidence changed since proposal creation</strong><span>${plural(evidenceWarnings, "proposal")} cannot be approved until every linked record is current and verified. Rejection remains available.</span></div>` : `<div class="review-global-current"><strong>Pending evidence verified</strong><span>${escapeHTML(String(data.evidenceNotice || "Evidence is verified for the current snapshot, not runtime correctness."))}</span></div>`}
      </section>
      <div class="review-queue" aria-label="Pending proposal review queue">${groupMarkup}</div>
      <section class="review-history surface" aria-labelledby="review-history-heading">
        <div class="section-heading"><div><p class="eyebrow">Immutable accountability trail</p><h2 id="review-history-heading">Decision history</h2><p>Recent proposal outcomes, reviewers, rationale, and timestamps.</p></div></div>
        ${reviewHistoryMarkup(history)}
      </section>
    </div>`,
    );
    announce(pending ? `${plural(pending, "proposal")} awaiting human review.` : "The proposal review queue is clear.");
  }

  function findPendingProposal(proposalId) {
    return (
      asArray(asObject(state.cache.review).conflictGroups)
        .flatMap((group) => asArray(asObject(group).proposals))
        .map(normalizeReviewProposal)
        .find((proposal) => proposal.id === proposalId) || null
    );
  }

  function setReviewFormBusy(busy, message = "", lockDialog = busy) {
    state.review.submitting = busy && lockDialog;
    dom.reviewForm?.setAttribute("aria-busy", String(busy));
    dom.reviewActor.disabled = busy;
    dom.reviewRationale.disabled = busy;
    dom.reviewSubmit.disabled = busy;
    document.querySelectorAll("[data-close-proposal-review]").forEach((button) => {
      button.disabled = busy && lockDialog;
    });
    if (message) dom.reviewSubmit.textContent = message;
  }

  async function openProposalReview(button) {
    const proposalId = String(button.dataset.proposalId || "");
    const action = String(button.dataset.proposalAction || "");
    const proposal = findPendingProposal(proposalId);
    if (!proposal || !["approve", "reject"].includes(action)) {
      showToast("That proposal is no longer available for review.", "warning");
      void loadView("review", true);
      return;
    }
    if (action === "approve" && !proposal.evidenceReady) {
      showToast("Approval is blocked until every linked evidence record is current and verified.", "warning");
      return;
    }
    const existingActor = dom.reviewActor.value;
    dom.reviewForm.reset();
    dom.reviewActor.value = existingActor;
    state.review.proposalId = proposal.id;
    state.review.action = action;
    state.review.returnFocus = button;
    dom.reviewId.value = proposal.id;
    dom.reviewAction.value = action;
    dom.reviewKicker.textContent = action === "approve" ? "Approve into durable memory" : "Reject proposed context";
    dom.reviewTitle.textContent = `${titleCase(action)} “${proposal.title}”`;
    dom.reviewPreview.innerHTML = `<span class="review-preview-action" data-action="${escapeAttr(action)}">${escapeHTML(titleCase(action))}</span><div><strong>${escapeHTML(proposal.title)}</strong><p>${escapeHTML(proposal.summary)}</p></div>`;
    dom.reviewSubmit.dataset.action = action;
    dom.reviewSubmit.textContent = action === "approve" ? "Confirm approval" : "Confirm rejection";
    dom.reviewError.hidden = true;
    dom.reviewError.textContent = "";
    dom.reviewDialog.showModal();
    setReviewFormBusy(true, "Securing session…", false);
    try {
      await ensureReviewSession();
      if (!dom.reviewDialog.open || state.review.proposalId !== proposal.id) return;
      setReviewFormBusy(false, action === "approve" ? "Confirm approval" : "Confirm rejection");
      dom.reviewActor.focus();
      announce(`Confirm ${action} for ${proposal.title}.`);
    } catch (error) {
      if (!dom.reviewDialog.open || state.review.proposalId !== proposal.id) return;
      setReviewFormBusy(false, "Session unavailable");
      dom.reviewSubmit.disabled = true;
      dom.reviewError.textContent = error instanceof Error ? error.message : "A secure local review session could not be established.";
      dom.reviewError.hidden = false;
    }
  }

  function closeProposalReview() {
    if (state.review.submitting) return;
    const returnFocus = state.review.returnFocus;
    if (dom.reviewDialog.open) dom.reviewDialog.close();
    state.review.proposalId = null;
    state.review.action = null;
    state.review.returnFocus = null;
    if (returnFocus?.isConnected) window.requestAnimationFrame(() => returnFocus.focus());
  }

  async function submitProposalReview(event) {
    event.preventDefault();
    if (state.review.submitting || !dom.reviewForm.reportValidity()) return;
    const proposalId = state.review.proposalId;
    const action = state.review.action;
    if (!proposalId || !["approve", "reject"].includes(action)) {
      dom.reviewError.textContent = "The selected proposal decision is no longer valid. Close this dialog and try again.";
      dom.reviewError.hidden = false;
      return;
    }
    dom.reviewError.hidden = true;
    setReviewFormBusy(true, action === "approve" ? "Approving…" : "Rejecting…");
    try {
      const token = await ensureReviewSession();
      await postVersionedJSON(
        `/api/v1/proposals/${encodeURIComponent(proposalId)}/${action}`,
        {
          actor: dom.reviewActor.value,
          rationale: dom.reviewRationale.value.trim(),
        },
        token,
      );
      dom.reviewDialog.close();
      state.review.proposalId = null;
      state.review.action = null;
      state.review.returnFocus = null;
      state.cache.review = null;
      state.cache.health = null;
      state.cache.overview = null;
      state.cache.map = null;
      state.cache.timeline = null;
      await loadView("review", true);
      showToast(`Proposal ${action === "approve" ? "approved" : "rejected"}. Review history was updated.`, "good");
    } catch (error) {
      if (error?.code === "invalid_review_session") state.review.sessionToken = null;
      dom.reviewError.textContent = error instanceof Error ? error.message : "The proposal decision could not be completed.";
      dom.reviewError.hidden = false;
      setReviewFormBusy(false, action === "approve" ? "Confirm approval" : "Confirm rejection");
      if ([404, 409].includes(Number(error?.status))) {
        state.cache.review = null;
      }
      announce("Proposal decision was not applied.");
    }
  }

  function closeSearchResults() {
    dom.searchResults.hidden = true;
    dom.searchResults.innerHTML = "";
    dom.searchResults.setAttribute("role", "listbox");
    dom.searchResults.setAttribute("aria-label", "Project memory search results");
    dom.searchInput.setAttribute("aria-expanded", "false");
    dom.searchInput.removeAttribute("aria-activedescendant");
    state.searchActiveIndex = -1;
    setLiveText(dom.searchStatus, "");
  }

  function showSearchMessage(message) {
    dom.searchResults.hidden = false;
    dom.searchResults.setAttribute("role", "presentation");
    dom.searchResults.removeAttribute("aria-label");
    dom.searchInput.setAttribute("aria-expanded", "false");
    dom.searchInput.removeAttribute("aria-activedescendant");
    state.searchActiveIndex = -1;
    dom.searchResults.innerHTML = `<div class="search-message">${escapeHTML(message)}</div>`;
    setLiveText(dom.searchStatus, message);
  }

  function searchOptions() {
    return [...dom.searchResults.querySelectorAll("[role='option']")];
  }

  function setActiveSearchOption(index) {
    const options = searchOptions();
    if (!options.length) return null;
    state.searchActiveIndex = clamp(index, 0, options.length - 1);
    options.forEach((option, optionIndex) => {
      option.setAttribute("aria-selected", String(optionIndex === state.searchActiveIndex));
    });
    const active = options[state.searchActiveIndex];
    dom.searchInput.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
    return active;
  }

  async function searchProject(query) {
    if (state.searchController) state.searchController.abort();
    state.searchController = new AbortController();
    showSearchMessage("Searching local project memory…");
    try {
      const data = await fetchJSON(`${API.search}?q=${encodeURIComponent(query)}`, state.searchController.signal);
      if (dom.searchInput.value.trim() !== query) return;
      const results = asArray(data.results)
        .slice(0, 12)
        .map((result, index) => {
          const object = asObject(result);
          const presentation = currentUseState(object);
          return {
            id: String(object.id ?? `result-${index}`),
            kind: String(object.kind || ""),
            type: String(object.type || "result"),
            title: String(object.title || `Result ${index + 1}`),
            summary: String(object.summary || ""),
            score: safeNumber(object.score, 0),
            status: presentation.status,
            settled: presentation.settled,
            reason: presentation.reason,
            authority: presentation.authority,
          };
        });
      if (!results.length) {
        showSearchMessage(`No project context matched “${query}”.`);
        return;
      }
      dom.searchResults.hidden = false;
      dom.searchResults.setAttribute("role", "listbox");
      dom.searchResults.setAttribute("aria-label", "Project memory search results");
      dom.searchInput.setAttribute("aria-expanded", "true");
      dom.searchInput.removeAttribute("aria-activedescendant");
      state.searchActiveIndex = -1;
      dom.searchResults.innerHTML = results
        .map(
          (result, index) => `
        <div class="search-result" id="search-option-${index}" role="option" aria-selected="false" data-result-id="${escapeAttr(result.id)}" data-result-kind="${escapeAttr(result.kind)}" data-result-type="${escapeAttr(result.type)}">
          <span class="search-result-top"><strong>${escapeHTML(result.title)}</strong><span class="search-score">${escapeHTML(titleCase(result.type))} · ${escapeHTML(titleCase(result.status))}${result.score ? ` · relevance ${escapeHTML(result.score.toFixed(2))}` : ""}</span></span>
          <p>${escapeHTML(result.summary || "No result summary available.")}</p>
          <small class="search-authority ${result.settled ? "is-settled" : "is-unsettled"}">${escapeHTML(result.settled ? "Settled for current use" : "Not settled for current use")}; authority ${escapeHTML(titleCase(result.authority))}. ${escapeHTML(result.reason)}</small>
        </div>`,
        )
        .join("");
      setLiveText(dom.searchStatus, `${plural(results.length, "search result")} available. Use the arrow keys to review them.`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      showSearchMessage(error instanceof Error ? error.message : "Search is unavailable.");
    }
  }

  async function handleSearchSelection(id, kind, type) {
    closeSearchResults();
    dom.searchInput.blur();
    const normalizedType = safeToken(type);
    if (kind === "event" || id.startsWith("event_") || /event|commit|change|context_approval|context_rejection/.test(normalizedType)) {
      await activateView("timeline");
      const event = asArray(state.cache.timeline?.events).find((candidate) => String(candidate?.id) === id);
      const input = document.querySelector("#timeline-search");
      if (input && event) {
        input.value = String(event.title || id);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      }
      return;
    }
    await activateView("map");
    if (state.graph.nodes.some((node) => node.id === id)) selectNode(id, true);
    else showToast("The result is not a node in the current map filters.");
  }

  function refreshCurrentView() {
    state.cache[state.currentView] = null;
    loadView(state.currentView, true);
  }

  document.addEventListener("click", (event) => {
    const proposalAction = event.target.closest("[data-proposal-action]");
    if (proposalAction) {
      void openProposalReview(proposalAction);
      return;
    }
    if (event.target.closest("[data-open-briefing]")) {
      void openBriefing();
      return;
    }
    const orientationJump = event.target.closest("[data-orientation-jump]");
    if (orientationJump) {
      const target = document.querySelector(`[data-orientation-topic="${CSS.escape(orientationJump.dataset.orientationJump)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
        target.classList.remove("is-highlighted");
        window.requestAnimationFrame(() => target.classList.add("is-highlighted"));
        window.setTimeout(() => target.classList.remove("is-highlighted"), 1500);
      }
      return;
    }
    const viewButton = event.target.closest("[data-view], [data-go-view]");
    if (viewButton) {
      activateView(viewButton.dataset.view || viewButton.dataset.goView);
      return;
    }
    const retry = event.target.closest("[data-retry-view]");
    if (retry) {
      state.cache[retry.dataset.retryView] = null;
      loadView(retry.dataset.retryView, true);
      return;
    }
    const mapAction = event.target.closest("[data-map-action]");
    if (mapAction) {
      if (mapAction.dataset.mapAction === "zoom-in") setGraphZoom(state.graph.zoom * 1.18);
      if (mapAction.dataset.mapAction === "zoom-out") setGraphZoom(state.graph.zoom * 0.84);
      if (mapAction.dataset.mapAction === "reset") fitGraphToStage();
      if (mapAction.dataset.mapAction === "clear-filters") {
        const query = document.querySelector("#map-query-filter");
        const type = document.querySelector("#map-type-filter");
        const status = document.querySelector("#map-status-filter");
        const unsettled = document.querySelector("#map-stale-filter");
        if (query) query.value = "";
        if (type) type.value = "all";
        if (status) status.value = "all";
        if (unsettled) unsettled.checked = false;
        applyMapFilters();
        window.requestAnimationFrame(fitGraphToStage);
        announce("Map filters cleared.");
      }
      if (mapAction.dataset.mapAction === "start") {
        const center =
          state.graph.nodes.find((node) => {
            const position = state.graph.positions.get(node.id);
            return position?.x === 0 && position?.y === 0;
          }) || state.graph.nodes[0];
        if (center) {
          selectNode(center.id);
          centerNode(center.id);
          document.querySelector("#map-welcome")?.setAttribute("hidden", "");
          document.querySelector(`.node[data-node-id="${CSS.escape(center.id)}"]`)?.focus();
        }
      }
      return;
    }
    const nodeJump = event.target.closest("[data-node-jump]");
    if (nodeJump) {
      selectNode(nodeJump.dataset.nodeJump);
      centerNode(nodeJump.dataset.nodeJump);
      return;
    }
    if (event.target.closest("[data-close-node]")) {
      const previouslySelected = state.graph.selectedId;
      state.graph.selectedId = null;
      closeNodePanel();
      renderGraphWorld();
      if (previouslySelected)
        window.requestAnimationFrame(() => document.querySelector(`.node[data-node-id="${CSS.escape(previouslySelected)}"]`)?.focus());
      return;
    }
    const result = event.target.closest("[data-result-id]");
    if (result) {
      void handleSearchSelection(result.dataset.resultId, result.dataset.resultKind, result.dataset.resultType);
      return;
    }
    const healthFilter = event.target.closest("[data-health-filter]");
    if (healthFilter) {
      applyHealthFilter(healthFilter.dataset.healthFilter);
      return;
    }
    const timelineJump = event.target.closest("[data-timeline-jump]");
    if (timelineJump) {
      const targets = [...document.querySelectorAll("#timeline-list .event-provenance > summary")];
      const target = timelineJump.dataset.timelineJump === "oldest" ? targets.at(-1) : targets[0];
      target?.focus();
      target?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
      return;
    }
    if (!event.target.closest("#global-search")) closeSearchResults();
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("#map-type-filter, #map-status-filter, #map-stale-filter")) applyMapFilters();
  });

  dom.refresh.addEventListener("click", refreshCurrentView);

  dom.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = dom.searchInput.value.trim();
    if (query.length >= 2) searchProject(query);
  });

  dom.searchInput.setAttribute("aria-controls", "search-results");
  dom.searchInput.setAttribute("aria-expanded", "false");
  dom.searchInput.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    const query = dom.searchInput.value.trim();
    if (query.length < 2) {
      if (state.searchController) state.searchController.abort();
      closeSearchResults();
      return;
    }
    closeSearchResults();
    state.searchTimer = window.setTimeout(() => searchProject(query), 240);
  });

  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dom.searchResults.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeSearchResults();
      return;
    }
    if (dom.searchResults.hidden || dom.searchResults.getAttribute("role") !== "listbox") return;
    const options = searchOptions();
    if (!options.length) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? state.searchActiveIndex + 1
              : state.searchActiveIndex < 0
                ? options.length - 1
                : state.searchActiveIndex - 1;
      setActiveSearchOption(nextIndex);
      return;
    }
    if (event.key === "Enter" && state.searchActiveIndex >= 0) {
      const active = options[state.searchActiveIndex];
      event.preventDefault();
      void handleSearchSelection(active.dataset.resultId, active.dataset.resultKind, active.dataset.resultType);
    }
  });

  document.querySelector("#keyboard-help")?.addEventListener("click", () => dom.shortcutDialog.showModal());
  document.querySelector("[data-close-dialog]")?.addEventListener("click", () => dom.shortcutDialog.close());
  dom.shortcutDialog.addEventListener("click", (event) => {
    if (event.target === dom.shortcutDialog) dom.shortcutDialog.close();
  });

  dom.reviewForm?.addEventListener("submit", (event) => void submitProposalReview(event));
  document.querySelectorAll("[data-close-proposal-review]").forEach((button) => {
    button.addEventListener("click", closeProposalReview);
  });
  dom.reviewDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeProposalReview();
  });

  document.querySelector("#add-source")?.addEventListener("click", openSourceImport);
  dom.sourceImportPreviewButton?.addEventListener("click", () => void previewSourceImport());
  dom.sourceImportForm?.addEventListener("submit", (event) => void submitSourceImport(event));
  dom.sourceImportMode?.addEventListener("change", () => {
    syncSourceImportMode();
    clearSourceImportPreview();
  });
  dom.sourceImportForm?.addEventListener("input", (event) => {
    if (event.target !== dom.sourceImportConfirmation) clearSourceImportPreview();
  });
  document.querySelectorAll("[data-close-source-import]").forEach((button) => {
    button.addEventListener("click", closeSourceImport);
  });
  dom.sourceImportDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSourceImport();
  });
  dom.sourceImportDialog?.addEventListener("click", (event) => {
    if (event.target === dom.sourceImportDialog) closeSourceImport();
  });

  document.querySelector("#start-briefing")?.addEventListener("click", () => void openBriefing());
  document.querySelector("[data-close-briefing]")?.addEventListener("click", closeBriefing);
  dom.briefingDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeBriefing();
  });
  dom.briefingDialog?.addEventListener("click", (event) => {
    if (event.target === dom.briefingDialog) closeBriefing();
  });
  dom.briefingPrevious?.addEventListener("click", () => {
    state.briefing.step -= 1;
    renderBriefing();
  });
  dom.briefingNext?.addEventListener("click", () => {
    const total = state.cache.overview ? briefingSteps(state.cache.overview).length : 0;
    if (state.briefing.step >= total - 1) {
      closeBriefing();
      void activateView("map");
      return;
    }
    state.briefing.step += 1;
    renderBriefing();
  });

  document.addEventListener("keydown", (event) => {
    const typing = event.target.matches("input, textarea, select, [contenteditable='true']");
    if (event.key === "Escape") {
      closeSearchResults();
      if (dom.shortcutDialog.open) dom.shortcutDialog.close();
      if (dom.briefingDialog?.open) closeBriefing();
      if (dom.reviewDialog?.open) closeProposalReview();
      if (dom.sourceImportDialog?.open) closeSourceImport();
      if (state.graph.selectedId) {
        state.graph.selectedId = null;
        closeNodePanel();
        renderGraphWorld();
      }
      return;
    }
    if (dom.shortcutDialog?.open || dom.briefingDialog?.open || dom.reviewDialog?.open || dom.sourceImportDialog?.open) return;
    if (!typing && event.key === "/") {
      event.preventDefault();
      dom.searchInput.focus();
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (["1", "2", "3", "4", "5"].includes(event.key)) {
      activateView(["overview", "map", "timeline", "health", "review"][Number(event.key) - 1]);
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      refreshCurrentView();
    } else if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      void openBriefing();
    } else if (state.currentView === "timeline" && event.key.toLowerCase() === "j") {
      event.preventDefault();
      navigateTimeline(1);
    } else if (state.currentView === "timeline" && event.key.toLowerCase() === "k") {
      event.preventDefault();
      navigateTimeline(-1);
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.currentView === "map" && state.cache.map) updateGraphTransform();
    }, 100);
  });

  const initialView = location.hash.slice(1);
  void refreshReviewBadge();
  activateView(VIEW_META[initialView] ? initialView : "overview");
})();
