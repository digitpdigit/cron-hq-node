(function () {
  /** @global moment loaded from CDN (index.html) */
  /** @returns {string} */
  function formatDisplayTs(raw) {
    if (raw == null || raw === "") return "";
    const m = typeof moment !== "undefined" ? moment(raw) : null;
    if (m && m.isValid()) return m.format("YYYY-MM-DD HH:mm:ss");
    return String(raw);
  }

  const settingsTa = document.getElementById("settingsJson");
  const saveBtn = document.getElementById("saveBtn");
  const copyEnvBtn = document.getElementById("copyEnvBtn");
  const saveStatus = document.getElementById("saveStatus");
  const clearBtn = document.getElementById("clearBtn");
  const streamStatus = document.getElementById("streamStatus");

  const summaryTbody = document.getElementById("summaryTbody");
  const summarySearch = document.getElementById("summarySearch");
  const flatTbody = document.getElementById("flatTbody");
  const flatSearch = document.getElementById("flatSearch");
  const callerFilter = document.getElementById("callerFilter");
  const pageSizeEl = document.getElementById("pageSize");
  const flatPrev = document.getElementById("flatPrev");
  const flatNext = document.getElementById("flatNext");
  const flatPageMeta = document.getElementById("flatPageMeta");

  let pollTimer = null;
  let sseRetryTimer = null;

  let lastPayload = { summaries: [], flat: [] };
  /** @type {Set<string>} */
  const expandedCallers = new Set();
  let flatPageIndex = 0;

  /** From GET /api/callers/informations (caller.getInfo()); fills url/cron for legacy SSE + UI merge. */
  let callerMetaByName = {};

  async function refreshCallerMeta() {
    try {
      const r = await fetch("/api/callers/informations", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!r.ok) return;
      const arr = await r.json();
      if (!Array.isArray(arr)) return;
      callerMetaByName = Object.fromEntries(
        arr.map((row) => [row.name, row])
      );
    } catch (_) {
      /* keep previous cache */
    }
  }

  function metaPickForCaller(caller) {
    const fromApi = callerMetaByName[caller];
    let url = fromApi && fromApi.url != null ? String(fromApi.url) : "";
    let cron = fromApi && fromApi.cron != null ? String(fromApi.cron) : "";
    for (const s of lastPayload.summaries) {
      if (s.caller !== caller) continue;
      if (!url && s.url != null && String(s.url) !== "") url = String(s.url);
      if (!cron && s.cron != null && String(s.cron) !== "") cron = String(s.cron);
      break;
    }
    return { url, cron };
  }

  function setStreamStatus(text, isError) {
    streamStatus.textContent = text;
    streamStatus.className = "status" + (isError ? " err" : "");
  }

  function formatData(val) {
    if (val == null || val === "") return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  }

  function norm(q) {
    return (q || "").trim().toLowerCase();
  }

  function jobsFromParsed(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)) {
      return parsed.jobs;
    }
    throw new Error("Expected JSON array of jobs or { jobs: [...] }");
  }
  function seedSummariesFromSettings(settingsRows) {
    if (!Array.isArray(settingsRows)) return [];
    return settingsRows.map((s) => ({
      caller: s.jobs ?? "",
      url: s.url ?? "",
      cron: s.cron ?? "",
      lastTag: null,
      latestStatus: null,
      lastTimestamp: null,
      lastMessage: null,
      recentThree: [],
    }));
  }

  function parseSseJsonString(dataStr) {
    const s = String(dataStr).trim().replace(/^\uFEFF/, "");
    if (!s) throw new Error("empty SSE data");
    return JSON.parse(s);
  }

  /** Normalize GET / SSE body to { summaries, flat }. Supports legacy grouped map (caller → entries). */
  function coerceDashboardPayload(parsed) {
    if (!parsed || typeof parsed !== "object") {
      return { summaries: [], flat: [] };
    }

    const hasModernShape =
      Array.isArray(parsed.summaries) && Array.isArray(parsed.flat);

    if (hasModernShape) {
      const flatRaw = parsed.flat.map((r) => ({
        ...r,
        caller:
          r.caller != null && String(r.caller) !== ""
            ? r.caller
            : r.name ?? "",
      }));
      return { summaries: parsed.summaries, flat: flatRaw };
    }

    const groupedKeys = Object.keys(parsed).filter(
      (k) => Array.isArray(parsed[k])
    );
    const everyTopLevelIsGroupedArray =
      groupedKeys.length > 0 &&
      Object.keys(parsed).every((k) => Array.isArray(parsed[k]));

    if (!everyTopLevelIsGroupedArray) {
      return { summaries: [], flat: [] };
    }

    /** @type {Record<string, any[]>} */
    const byCaller = {};
    for (const caller of groupedKeys) {
      const mu = metaPickForCaller(caller);
      byCaller[caller] = parsed[caller].map((e) => ({
        ...e,
        caller,
        url: mu.url ?? "",
        cron: mu.cron ?? "",
      }));
    }

    const flat = Object.values(byCaller)
      .flat()
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    const callerOrder = [];
    const seen = new Set();
    for (const s of lastPayload.summaries) {
      if (seen.has(s.caller)) continue;
      callerOrder.push(s.caller);
      seen.add(s.caller);
    }
    for (const c of [...groupedKeys].sort()) {
      if (!seen.has(c)) {
        callerOrder.push(c);
        seen.add(c);
      }
    }

    const summaries = callerOrder.map((caller) => {
      const mu = metaPickForCaller(caller);
      const entries = byCaller[caller] || [];
      const last = entries.length ? entries[entries.length - 1] : null;
      const slice = entries.slice(-3).reverse();
      return {
        caller,
        url: mu.url ?? "",
        cron: mu.cron ?? "",
        lastTag: last ? last.tag : null,
        latestStatus: last ? last.status : null,
        lastTimestamp: last ? last.timestamp : null,
        lastMessage: last ? last.message : null,
        recentThree: slice.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          tag: e.tag,
          data: e.data,
          message: e.message,
          status: e.status,
          error: e.error,
        })),
      };
    });

    return { summaries, flat };
  }

  function applyDashboardInbound(parsed) {
    applyPayload(coerceDashboardPayload(parsed));
  }

  function summaryMatches(s, q) {
    if (!q) return true;
    const hay = [
      s.caller,
      s.url,
      s.cron,
      s.lastTag,
      s.latestStatus,
      s.lastTimestamp,
      formatDisplayTs(s.lastTimestamp),
      s.lastMessage,
    ]
      .map((x) => (x == null ? "" : String(x)))
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function flatMatches(row, q) {
    if (!q) return true;
    const hay = [
      row.message,
      row.tag,
      row.id,
      row.caller,
      row.url,
      row.timestamp,
      formatDisplayTs(row.timestamp),
    ]
      .map((x) => (x == null ? "" : String(x)))
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function filterFlatRows() {
    const q = norm(flatSearch.value);
    const caller = callerFilter.value;
    return lastPayload.flat.filter((row) => {
      const okCaller = !caller || row.caller === caller;
      return okCaller && flatMatches(row, q);
    });
  }

  function refreshCallerFilterOptions() {
    const names = [...new Set(lastPayload.summaries.map((s) => s.caller))];
    const prev = callerFilter.value;
    callerFilter.innerHTML = '<option value="">All</option>';
    names.sort().forEach((n) => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      callerFilter.appendChild(opt);
    });
    if (names.includes(prev)) callerFilter.value = prev;
  }

  function renderSummaryRows() {
    const q = norm(summarySearch.value);
    summaryTbody.textContent = "";
    const filtered = lastPayload.summaries.filter((s) => summaryMatches(s, q));

    for (const s of filtered) {
      const expanded = expandedCallers.has(s.caller);

      const sumTr = document.createElement("tr");
      sumTr.className = "summary-row";
      sumTr.dataset.caller = s.caller;
      const cells = [
        s.caller,
        s.url,
        s.cron,
        s.lastTag ?? "",
        s.latestStatus ?? "",
        formatDisplayTs(s.lastTimestamp),
        s.lastMessage ?? "",
      ];
      cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        sumTr.appendChild(td);
      });
      sumTr.addEventListener("click", () => {
        if (expandedCallers.has(s.caller)) expandedCallers.delete(s.caller);
        else expandedCallers.add(s.caller);
        renderSummaryRows();
      });
      summaryTbody.appendChild(sumTr);

      if (expanded) {
        const detTr = document.createElement("tr");
        detTr.className = "detail-row";
        const td = document.createElement("td");
        td.colSpan = 7;
        const wrap = document.createElement("div");
        wrap.className = "nested-wrap";
        wrap.addEventListener("click", (e) => e.stopPropagation());

        const nested = document.createElement("table");
        nested.className = "log-table nested-table";
        const thead = document.createElement("thead");
        thead.innerHTML =
          "<tr><th>ID</th><th>Timestamp</th><th>Tag</th><th>Data</th><th>Message</th><th>Status</th></tr>";
        nested.appendChild(thead);
        const nbody = document.createElement("tbody");
        const rows =
          Array.isArray(s.recentThree) && s.recentThree.length ? s.recentThree : [];
        if (!rows.length) {
          const tr = document.createElement("tr");
          const lone = document.createElement("td");
          lone.colSpan = 6;
          lone.textContent = "No log lines yet.";
          tr.appendChild(lone);
          nbody.appendChild(tr);
        } else {
          for (const r of rows) {
            const tr = document.createElement("tr");
            [
              r.id,
              formatDisplayTs(r.timestamp),
              r.tag,
              formatData(r.data),
              r.message,
              r.status,
            ].forEach((txt) => {
              const cel = document.createElement("td");
              cel.textContent = txt == null ? "" : String(txt);
              tr.appendChild(cel);
            });
            nbody.appendChild(tr);
          }
        }
        nested.appendChild(nbody);
        wrap.appendChild(nested);
        td.appendChild(wrap);
        detTr.appendChild(td);
        summaryTbody.appendChild(detTr);
      }
    }

    if (!filtered.length && lastPayload.summaries.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "No jobs configured.";
      tr.appendChild(td);
      summaryTbody.appendChild(tr);
    } else if (!filtered.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "No rows match summary filter.";
      tr.appendChild(td);
      summaryTbody.appendChild(tr);
    }
  }

  function renderFlatRows() {
    const filtered = filterFlatRows();
    const pageSize = Math.max(5, Number(pageSizeEl.value) || 10);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
    if (flatPageIndex >= totalPages) flatPageIndex = Math.max(0, totalPages - 1);

    flatTbody.textContent = "";
    const start = flatPageIndex * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);

    for (const r of pageRows) {
      const tr = document.createElement("tr");
      [
        r.caller,
        r.id,
        formatDisplayTs(r.timestamp),
        r.tag,
        formatData(r.data),
        r.message,
        r.url,
      ].forEach((txt) => {
        const td = document.createElement("td");
        td.textContent = txt == null ? "" : String(txt);
        tr.appendChild(td);
      });
      flatTbody.appendChild(tr);
    }

    if (!pageRows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = total === 0 ? "No logs yet." : "No rows match filter.";
      tr.appendChild(td);
      flatTbody.appendChild(tr);
    }

    flatPrev.disabled = flatPageIndex <= 0;
    flatNext.disabled = flatPageIndex >= totalPages - 1;
    const shownFrom = total ? start + 1 : 0;
    const shownTo = total ? Math.min(start + pageRows.length, total) : 0;
    flatPageMeta.textContent =
      total === 0 ? "Page 1 of 1" :
      `Page ${flatPageIndex + 1} of ${totalPages} (showing ${shownFrom}-${shownTo} of ${total})`;
  }

  function applyPayload(payload) {
    let summaries = Array.isArray(payload.summaries) ? payload.summaries : [];
    let flat = Array.isArray(payload.flat) ? payload.flat : [];

    summaries = summaries.map((s) => {
      const api = callerMetaByName[s.caller];
      if (!api) return s;
      return {
        ...s,
        url: s.url != null && String(s.url) !== "" ? s.url : api.url ?? "",
        cron: s.cron != null && String(s.cron) !== "" ? s.cron : api.cron ?? "",
      };
    });

    flat = flat.map((r) => {
      const api = callerMetaByName[r.caller];
      if (!api) return r;
      return {
        ...r,
        url: r.url != null && String(r.url) !== "" ? r.url : api.url ?? "",
        cron:
          r.cron != null && String(r.cron) !== ""
            ? r.cron
            : (api.cron ?? ""),
      };
    });

    lastPayload = { summaries, flat };

    for (const c of [...expandedCallers]) {
      if (!summaries.some((s) => s.caller === c)) expandedCallers.delete(c);
    }

    refreshCallerFilterOptions();

    const filtered = filterFlatRows();
    const pageSize = Math.max(5, Number(pageSizeEl.value) || 10);
    const totalPages =
      filtered.length === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
    if (flatPageIndex >= totalPages) flatPageIndex = Math.max(0, totalPages - 1);

    renderSummaryRows();
    renderFlatRows();
  }

  summarySearch.addEventListener("input", () => renderSummaryRows());
  flatSearch.addEventListener("input", () => {
    flatPageIndex = 0;
    renderFlatRows();
  });
  callerFilter.addEventListener("change", () => {
    flatPageIndex = 0;
    renderFlatRows();
  });
  pageSizeEl.addEventListener("change", () => {
    flatPageIndex = 0;
    renderFlatRows();
  });
  flatPrev.addEventListener("click", () => {
    if (flatPageIndex > 0) {
      flatPageIndex--;
      renderFlatRows();
    }
  });
  flatNext.addEventListener("click", () => {
    const filtered = filterFlatRows();
    const pageSize = Math.max(5, Number(pageSizeEl.value) || 10);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize) || 1);
    if (flatPageIndex < totalPages - 1) {
      flatPageIndex++;
      renderFlatRows();
    }
  });

  async function fetchLogsPoll() {
    try {
      const r = await fetch("/api/logs", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!r.ok) throw new Error(r.status + " " + r.statusText);
      applyDashboardInbound(await r.json());
    } catch (e) {
      setStreamStatus("Poll error: " + e.message, true);
    }
  }
  function startPoll() {
    if (pollTimer) return;
    setStreamStatus("SSE down — polling every 1s", true);
    fetchLogsPoll();
    pollTimer = setInterval(fetchLogsPoll, 1000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  let es = null;

  function connectSSE() {
    if (es) {
      try {
        es.close();
      } catch (_) {}
      es = null;
    }

    es = new EventSource("/api/events");

    function sseIngest(ev) {
      stopPoll();
      setStreamStatus("Live (SSE)", false);
      try {
        applyDashboardInbound(parseSseJsonString(ev.data));
      } catch (e) {
        setStreamStatus("Bad SSE payload: " + e.message, true);
      }
    }

    es.addEventListener("logs", sseIngest);
    es.addEventListener("message", sseIngest);

    es.onerror = () => {
      es.close();
      es = null;
      startPoll();
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
      sseRetryTimer = setTimeout(() => {
        sseRetryTimer = null;
        stopPoll();
        connectSSE();
      }, 3000);
    };
  }

  async function loadSettings() {
    const r = await fetch("/api/settings", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    const data = await r.json();
    const rows = jobsFromParsed(data);
    settingsTa.value = JSON.stringify(rows, null, 2);
    if (
      Array.isArray(rows) &&
      rows.length > 0 &&
      lastPayload.summaries.length === 0
    ) {
      lastPayload = {
        summaries: seedSummariesFromSettings(rows),
        flat: lastPayload.flat,
      };
      refreshCallerFilterOptions();
      renderSummaryRows();
      renderFlatRows();
    }
  }

  copyEnvBtn.addEventListener("click", async () => {
    saveStatus.textContent = "";
    saveStatus.className = "status";
    let parsed;
    try {
      parsed = JSON.parse(settingsTa.value);
    } catch (e) {
      saveStatus.textContent = "Invalid JSON: " + e.message;
      saveStatus.className = "status err";
      return;
    }
    let rows;
    try {
      rows = jobsFromParsed(parsed);
    } catch (e) {
      saveStatus.textContent = String(e.message || e);
      saveStatus.className = "status err";
      return;
    }
    const compact = JSON.stringify(rows);
    const line = `SETTINGS='${compact}'`;
    try {
      await navigator.clipboard.writeText(line);
      saveStatus.textContent = "Copied: SETTINGS='…' (one line)";
      saveStatus.className = "status ok";
    } catch (e) {
      saveStatus.textContent = "Clipboard failed: " + (e.message || String(e));
      saveStatus.className = "status err";
    }
  });

  saveBtn.addEventListener("click", async () => {
    saveStatus.textContent = "";
    saveStatus.className = "status";
    let parsed;
    try {
      parsed = JSON.parse(settingsTa.value);
    } catch (e) {
      saveStatus.textContent = "Invalid JSON: " + e.message;
      saveStatus.className = "status err";
      return;
    }
    let rows;
    try {
      rows = jobsFromParsed(parsed);
      settingsTa.value = JSON.stringify(rows, null, 2);
    } catch (e) {
      saveStatus.textContent = String(e.message || e);
      saveStatus.className = "status err";
      return;
    }
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rows),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        saveStatus.textContent = body.error || r.statusText;
        saveStatus.className = "status err";
        return;
      }
      saveStatus.textContent = "Saved and HQ reloaded.";
      saveStatus.className = "status ok";
      await loadSettings();
      await refreshCallerMeta();
      await fetchLogsPoll();
    } catch (e) {
      saveStatus.textContent = String(e.message);
      saveStatus.className = "status err";
    }
  });

  clearBtn.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/logs/clear", { method: "POST" });
      if (!r.ok && r.status !== 204) throw new Error(r.statusText);
      await refreshCallerMeta();
      await fetchLogsPoll();
    } catch (e) {
      setStreamStatus("Clear failed: " + e.message, true);
    }
  });

  const settingsLoad = loadSettings().catch((e) => {
    saveStatus.textContent = "Load settings failed: " + e.message;
    saveStatus.className = "status err";
  });

  Promise.all([refreshCallerMeta(), settingsLoad])
    .then(() => fetchLogsPoll())
    .then(() => connectSSE());
})();
