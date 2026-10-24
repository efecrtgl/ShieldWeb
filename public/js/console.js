// Shared helpers for the admin console: escaping, formatting, API calls, command result toasts,
// the live server status in the top bar and the game-data catalogues.
(function () {
  "use strict";

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  }

  const numberFormat = new Intl.NumberFormat("tr-TR");
  // Formats a number; null/undefined/NaN render as a grey dash (unknown), 0 renders as 0.
  function formatNumber(value, { suffix = "" } = {}) {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return '<span class="dash" title="Bilinmiyor">—</span>';
    return escapeHtml(numberFormat.format(Number(value))) + (suffix ? `<span class="unit">${escapeHtml(suffix)}</span>` : "");
  }

  function relativeTime(date) {
    if (!date) return "—";
    const ms = Date.now() - new Date(date).getTime();
    if (!Number.isFinite(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 5) return "şimdi";
    if (s < 60) return `${s} sn önce`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} dk önce`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} sa önce`;
    return `${Math.round(h / 24)} gün önce`;
  }

  function formatDateTime(date) {
    if (!date) return "—";
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // fetch + JSON with a timeout. Resolves { ok, status, data }; never throws for HTTP errors.
  async function api(url, { method = "GET", body, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: "include"
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { success: false, message: err.name === "AbortError" ? "İstek zaman aşımına uğradı." : "Sunucuya ulaşılamadı." } };
    } finally {
      clearTimeout(timer);
    }
  }

  // Toast for a FiveM command response: confirmed -> success, delivered but unconfirmed -> warning, otherwise error.
  function toastForResult(data, fallbackError) {
    const toast = window.showToast || ((msg) => console.log(msg));
    if (!data) return toast(fallbackError || "İşlem başarısız.", "error");
    if (data.success && data.confirmed !== false) return toast(data.message || "İşlem tamamlandı.", "success");
    if (data.success) return toast(data.message || "Komut iletildi; sonucu doğrulanamadı.", "warning", "Doğrulanamadı");
    return toast(data.message || fallbackError || "İşlem başarısız.", "error");
  }

  // Marks a button busy for the duration of an async action, preventing double submits.
  async function withBusy(button, action) {
    if (button && button.disabled) return undefined;
    const original = button ? button.innerHTML : "";
    if (button) {
      button.disabled = true;
      button.classList.add("is-busy");
      button.setAttribute("aria-busy", "true");
    }
    try {
      return await action();
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove("is-busy");
        button.removeAttribute("aria-busy");
        button.innerHTML = original;
      }
    }
  }

  /* ---- Live server status (top bar) ---------------------------------------------------- */

  const bridgeListeners = new Set();
  let lastBridge = null;

  function renderTopbarStatus(bridge, failed) {
    const el = document.getElementById("topbar-server-status");
    if (!el) return;
    const dot = el.querySelector(".status-dot");
    const text = el.querySelector(".server-status-text");
    let cls = "is-unknown";
    let label = "durum alınamadı";
    if (!failed && bridge) {
      if (bridge.online) {
        cls = "is-online";
        label = bridge.maxPlayers ? `${bridge.playersCount} / ${bridge.maxPlayers} oyuncu` : `${bridge.playersCount} oyuncu`;
      } else {
        cls = "is-offline";
        label = bridge.lastPollAt ? `çevrimdışı · son veri ${relativeTime(bridge.lastPollAt)}` : "çevrimdışı";
      }
    }
    dot.className = `status-dot ${cls}`;
    text.innerHTML = `FiveM: <strong>${escapeHtml(label)}</strong>`;
    el.title = bridge && bridge.lastPollAt ? `Son köprü verisi: ${formatDateTime(bridge.lastPollAt)}` : "FiveM köprüsü henüz veri göndermedi";
  }

  async function pollBridge() {
    if (document.hidden) return;
    const res = await api("/api/fivem/bridge/status", { timeoutMs: 8000 });
    const bridge = res.ok && res.data ? res.data.bridge : null;
    lastBridge = bridge;
    renderTopbarStatus(bridge, !bridge);
    bridgeListeners.forEach(fn => { try { fn(bridge); } catch (e) { console.error(e); } });
  }

  function onBridgeStatus(fn) {
    bridgeListeners.add(fn);
    if (lastBridge) fn(lastBridge);
  }

  /* ---- Game data catalogues (items, jobs, gangs, vehicles) --------------------------------- */

  let sharedDataRequest = null;
  // One request shared by all four catalogue views; refreshed when asked explicitly.
  function loadSharedData(force) {
    if (!sharedDataRequest || force) sharedDataRequest = api("/api/fivem/shared-data");
    return sharedDataRequest;
  }

  const CATALOGS = {
    jobs: {
      noun: "meslek",
      search: (code, v) => [code, v.label],
      card: (code, v) => {
        const grades = v && v.grades ? Object.entries(v.grades) : [];
        const rows = grades.map(([level, g]) => `<div class="kv"><span>${escapeHtml(level)} · ${escapeHtml((g && (g.name || g.label)) || "—")}</span><span>${g && g.payment !== undefined ? "$" + formatNumber(g.payment) : '<span class="dash">—</span>'}</span></div>`).join("");
        return `<h4>${escapeHtml((v && v.label) || code)}</h4><div class="code">${escapeHtml(code)}</div><div style="margin-top:10px">${rows || '<div class="kv"><span>Kademe bilgisi gönderilmedi</span><span></span></div>'}</div>`;
      }
    },
    gangs: {
      noun: "çete",
      search: (code, v) => [code, v.label],
      card: (code, v) => CATALOGS.jobs.card(code, v)
    },
    items: {
      noun: "eşya",
      search: (code, v) => [code, v.label, v.description],
      card: (code, v) => `<h4>${escapeHtml((v && v.label) || code)}</h4><div class="code">${escapeHtml(code)}</div>
        <div style="margin-top:10px"><div class="kv"><span>Ağırlık</span><span>${v && v.weight !== undefined && v.weight !== null ? formatNumber(v.weight) + '<span class="unit">g</span>' : '<span class="dash">—</span>'}</span></div>
        ${v && v.description ? `<div class="kv"><span>${escapeHtml(v.description)}</span><span></span></div>` : ""}</div>`
    },
    vehicles: {
      noun: "araç",
      search: (code, v) => [code, v.name, v.brand, v.category],
      card: (code, v) => `<h4>${escapeHtml([v && v.brand, v && v.name].filter(Boolean).join(" ") || code)}</h4><div class="code">${escapeHtml(code)}</div>
        <div style="margin-top:10px"><div class="kv"><span>Kategori</span><span>${escapeHtml((v && v.category) || "—")}</span></div>
        <div class="kv"><span>Fiyat</span><span>${v && v.price !== undefined && v.price !== null ? "$" + formatNumber(v.price) : '<span class="dash">—</span>'}</span></div></div>`
    }
  };

  async function renderCatalog(kind, { force = false } = {}) {
    const spec = CATALOGS[kind];
    const root = document.querySelector(`[data-catalog="${kind}"]`);
    if (!spec || !root) return;
    const grid = root.querySelector(".catalog-grid");
    const status = root.querySelector("[data-catalog-status]");
    const count = root.querySelector("[data-catalog-count]");
    const search = root.querySelector("input[type=search]");
    status.innerHTML = "";
    if (!root.dataset.loaded || force) {
      grid.innerHTML = Array.from({ length: 6 }, () => '<div class="catalog-card"><span class="skeleton-block" style="width:60%"></span><span class="skeleton-block" style="width:35%"></span><span class="skeleton-block"></span></div>').join("");
    }

    const res = await loadSharedData(force);
    root.dataset.loaded = "1";
    if (!res.ok || !res.data || !res.data.success) {
      count.textContent = "";
      grid.innerHTML = "";
      status.innerHTML = `<div class="state-error"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><div><strong>Oyun verisi okunamadı.</strong> ${escapeHtml((res.data && res.data.message) || "")} <button type="button" class="btn-text" data-catalog-retry>Tekrar dene</button></div></div>`;
      return;
    }
    const data = res.data;
    if (!data.available || !data[kind]) {
      count.textContent = "";
      grid.innerHTML = "";
      status.innerHTML = `<div class="state-empty"><strong>${data.available ? `FiveM sunucusu ${spec.noun} listesini göndermedi.` : "FiveM sunucusu henüz oyun verisi göndermedi."}</strong>
        <span>Liste, shield-software resource'u sunucuda çalıştığında otomatik olarak gelir (10 dakikada bir). Panel bu listeyi tahmin etmez veya varsayılan değerlerle doldurmaz.</span></div>`;
      return;
    }

    if (data.stale) {
      status.innerHTML = `<div class="notice"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>Bu liste ${escapeHtml(formatDateTime(data.syncedAt))} tarihinde alındı ve güncel olmayabilir${data.bridgeOnline ? "" : "; FiveM sunucusu şu anda çevrimdışı"}.</span></div>`;
    } else {
      status.innerHTML = `<div class="freshness">Son senkronizasyon: ${escapeHtml(formatDateTime(data.syncedAt))}</div>`;
    }

    const entries = Object.entries(data[kind]);
    const query = (search ? search.value : "").toLocaleLowerCase("tr-TR").trim();
    const filtered = query
      ? entries.filter(([code, v]) => spec.search(code, v || {}).some(f => f && String(f).toLocaleLowerCase("tr-TR").includes(query)))
      : entries;
    count.textContent = query ? `${numberFormat.format(filtered.length)} / ${numberFormat.format(entries.length)} ${spec.noun}` : `${numberFormat.format(entries.length)} ${spec.noun}`;
    const LIMIT = 300;
    grid.innerHTML = filtered.length
      ? filtered.slice(0, LIMIT).map(([code, v]) => `<article class="catalog-card">${spec.card(code, v || {})}</article>`).join("") +
        (filtered.length > LIMIT ? `<div class="state-empty span-all">İlk ${LIMIT} sonuç gösteriliyor; aramayı daraltın.</div>` : "")
      : `<div class="state-empty span-all">"${escapeHtml(query)}" ile eşleşen ${spec.noun} yok.</div>`;
  }

  function initCatalogs() {
    document.querySelectorAll("[data-catalog]").forEach(root => {
      const kind = root.dataset.catalog;
      const search = root.querySelector("input[type=search]");
      let t = null;
      if (search) search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => renderCatalog(kind), 150); });
      root.addEventListener("click", e => {
        if (e.target.closest("[data-catalog-retry]") || e.target.closest("[data-catalog-refresh]")) renderCatalog(kind, { force: true });
      });
      const section = root.closest(".admin-section");
      const load = () => { if (section && section.classList.contains("active") && !root.dataset.loaded) renderCatalog(kind); };
      if (section) new MutationObserver(load).observe(section, { attributes: true, attributeFilter: ["class"] });
      load();
    });
  }

  /* ---- Shell behaviour ------------------------------------------------------------------- */

  function initShell() {
    // In-page links to another section ("Tümünü gör") go through the sidebar link so the section switches.
    document.addEventListener("click", e => {
      const a = e.target.closest("a[href^=\"#\"]");
      if (!a || a.classList.contains("sidebar-link") || a.getAttribute("href") === "#admin-canvas") return;
      const target = document.querySelector(`.sidebar-link[href="${a.getAttribute("href")}"]`);
      if (target) { e.preventDefault(); target.click(); }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && typeof window.closeMobileSidebar === "function") window.closeMobileSidebar();
    });
    pollBridge();
    setInterval(pollBridge, 15000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollBridge(); });
    initCatalogs();
  }

  window.Console = { escapeHtml, formatNumber, relativeTime, formatDateTime, api, toastForResult, withBusy, onBridgeStatus, pollBridge, renderCatalog };
  // A value passed as a string argument inside an inline handler (onclick="fn(${jsArg(x)})"): JSON-quoted, then HTML-escaped.
  function jsArg(value) {
    return escapeHtml(JSON.stringify(value === undefined || value === null ? "" : String(value)));
  }

  window.toastForResult = toastForResult;
  window.jsArg = jsArg;
  window.escapeHtml = escapeHtml;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initShell);
  else initShell();
})();
