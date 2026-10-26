"use strict";

(function () {
  const REFRESH_MS = 5000;
  const PAGE_SIZE = 20;
  const TOKEN_KEY = "taskflow.token";
  const THEME_KEY = "taskflow.theme";

  const $ = (id) => document.getElementById(id);

  const state = {
    token: null,
    page: 1,
    total: 0,
    status: "",
    type: "",
    timer: null,
    openJobId: null,
    lastStats: null,
  };

  // ---------- storage (best-effort; may be unavailable) ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  // ---------- DOM helpers (textContent only: job data is user-supplied) ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const fmt = new Intl.NumberFormat();
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function ago(iso) {
    if (!iso) return "—";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return dateTimeFmt.format(new Date(iso));
  }

  const STATUS_LABEL = {
    CREATED: "Created", QUEUED: "Queued", PROCESSING: "Processing", COMPLETED: "Completed",
    FAILED: "Failed", RETRY_SCHEDULED: "Retry scheduled", DEAD: "Dead",
  };
  const statusPill = (s) => el("span", { class: `pill s-${s}` }, el("span", { class: "dot" }), STATUS_LABEL[s] || s);

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- theme ----------
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  applyTheme(store.get(THEME_KEY));
  $("theme-btn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme")
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    store.set(THEME_KEY, next);
    if (state.lastStats) renderChart(state.lastStats.throughput);
  });

  // ---------- API ----------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401 && state.token) {
      logout("Session expired — please sign in again.");
      throw new Error("unauthorized");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
    return { body, headers: res.headers, status: res.status };
  }

  // ---------- auth ----------
  function tokenValid(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.exp * 1000 > Date.now() + 30_000;
    } catch { return false; }
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    $("login-error").textContent = "";
    try {
      const headers = form.get("apiKey") ? { "x-api-key": form.get("apiKey") } : {};
      const { body } = await api("/auth/token", {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: form.get("userId") }),
      });
      state.token = body.token;
      store.set(TOKEN_KEY, body.token);
      showApp();
    } catch (err) {
      $("login-error").textContent = err.message;
    }
  });

  function logout(message) {
    state.token = null;
    store.del(TOKEN_KEY);
    clearInterval(state.timer);
    $("app-view").hidden = true;
    $("drawer").hidden = true;
    $("login-view").hidden = false;
    $("login-error").textContent = message || "";
  }
  $("logout-btn").addEventListener("click", () => logout());

  function showApp() {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    refresh();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearInterval(state.timer);
    if ($("auto-refresh").checked) state.timer = setInterval(refresh, REFRESH_MS);
  }
  $("auto-refresh").addEventListener("change", scheduleRefresh);
  $("refresh-btn").addEventListener("click", refresh);

  // ---------- refresh ----------
  let refreshing = false;
  async function refresh() {
    if (refreshing || !state.token || document.hidden) return;
    refreshing = true;
    try {
      const params = new URLSearchParams({ page: state.page, limit: PAGE_SIZE });
      if (state.status) params.set("status", state.status);
      if (state.type) params.set("type", state.type);

      const [health, stats, jobs] = await Promise.all([
        fetch("/health").then((r) => r.json()).catch(() => ({ mongo: "unavailable", redis: "unavailable" })),
        api("/stats"),
        api(`/jobs?${params}`),
      ]);

      state.lastStats = stats.body;
      state.total = Number(jobs.headers.get("X-Total-Count") || 0);

      renderHealth(health);
      renderKpis(stats.body);
      renderChart(stats.body.throughput);
      renderTypes(stats.body.topTypes);
      renderWorkers(stats.body.workers);
      renderJobs(jobs.body);
      if (state.openJobId) loadJob(state.openJobId, true);
      $("updated-at").textContent = `Updated ${timeFmt.format(new Date())}`;
    } catch (err) {
      if (err.message !== "unauthorized") toast(`Refresh failed: ${err.message}`);
    } finally {
      refreshing = false;
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // ---------- renderers ----------
  function renderHealth(h) {
    const pill = (name, status) =>
      el("span", { class: "pill" }, el("span", { class: `dot ${status === "ok" ? "good" : "critical"}` }), `${name} ${status === "ok" ? "OK" : "down"}`);
    $("health").replaceChildren(pill("MongoDB", h.mongo), pill("Redis", h.redis));
  }

  function renderKpis(s) {
    const finished = s.byStatus.COMPLETED + s.byStatus.DEAD;
    const successRate = finished ? `${((s.byStatus.COMPLETED / finished) * 100).toFixed(1)}% success` : "no finished jobs yet";
    const busy = s.workers.filter((w) => w.currentJobId).length;
    const tiles = [
      { label: "Queued", dot: "neutral", value: s.queues.ready, sub: "ready in Redis" },
      { label: "Processing", dot: "active", value: s.byStatus.PROCESSING, sub: `${busy} worker${busy === 1 ? "" : "s"} busy` },
      { label: "Retry scheduled", dot: "warning", value: s.queues.delayed, sub: "waiting on backoff" },
      { label: "Completed", dot: "good", value: s.byStatus.COMPLETED, sub: successRate },
      { label: "Dead letter", dot: "critical", value: s.queues.dlq, sub: `${fmt.format(s.byStatus.DEAD)} marked DEAD` },
      { label: "Workers online", dot: s.workers.length ? "good" : "critical", value: s.workers.length, sub: `${fmt.format(s.total)} jobs total` },
    ];
    $("kpis").replaceChildren(...tiles.map((t) =>
      el("div", { class: "kpi" },
        el("div", { class: "label" }, el("span", { class: `dot ${t.dot}` }), t.label),
        el("div", { class: "value" }, fmt.format(t.value)),
        el("div", { class: "sub" }, t.sub))));
  }

  // Line chart: two series on one axis, crosshair + tooltip on hover.
  const SERIES = [
    { key: "completed", label: "Completed", color: "var(--series-1)" },
    { key: "failed", label: "Failed attempts", color: "var(--series-2)" },
  ];
  $("chart-legend").replaceChildren(...SERIES.map((s) =>
    el("span", {}, el("i", { style: `background:${s.color}` }), s.label)));

  // Integer tick step of 1/2/5 x 10^n giving at most 4 intervals.
  function niceStep(maxValue) {
    const raw = Math.max(1, maxValue / 4);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
  }

  function renderChart(points) {
    const wrap = $("chart");
    const W = wrap.clientWidth || 600;
    const H = wrap.clientHeight || 240;
    const m = { top: 8, right: 12, bottom: 24, left: 36 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const NS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    const peak = Math.max(1, ...points.flatMap((p) => [p.completed, p.failed]));
    const step = niceStep(peak);
    const ticks = Math.ceil(peak / step);
    const max = step * ticks;
    const x = (i) => m.left + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
    const y = (v) => m.top + ih - (v / max) * ih;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Jobs finished per minute over the last hour" });

    // Gridlines + y ticks
    for (let i = 0; i <= ticks; i++) {
      const v = step * i;
      const yy = y(v);
      svg.append(svgEl("line", { x1: m.left, x2: W - m.right, y1: yy, y2: yy, stroke: i === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const label = svgEl("text", { x: m.left - 8, y: yy + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)" });
      label.textContent = fmt.format(Math.round(v));
      svg.append(label);
    }
    // X ticks every 15 minutes (30 on narrow screens); skip the one that would crowd "now".
    const every = iw < 480 ? 30 : 15;
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      if (!last && (i % every !== 0 || points.length - 1 - i < every / 2)) return;
      const t = svgEl("text", { x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle", "font-size": 11, fill: "var(--muted)" });
      t.textContent = i === points.length - 1 ? "now" : timeFmt.format(new Date(p.minute));
      svg.append(t);
    });

    // Lines
    for (const s of SERIES) {
      const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join("");
      svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }

    // Hover layer
    const cross = svgEl("line", { y1: m.top, y2: m.top + ih, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
    const markers = SERIES.map((s) => svgEl("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
    svg.append(cross, ...markers);
    const hit = svgEl("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent" });
    svg.append(hit);

    const tip = el("div", { class: "tooltip", hidden: true });
    const move = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.left) / iw) * (points.length - 1))));
      const p = points[i];
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      SERIES.forEach((s, k) => {
        markers[k].setAttribute("cx", x(i)); markers[k].setAttribute("cy", y(p[s.key])); markers[k].setAttribute("visibility", "visible");
      });
      tip.replaceChildren(
        el("div", { class: "t-title" }, timeFmt.format(new Date(p.minute))),
        ...SERIES.map((s) => el("div", { class: "t-row" }, el("span", { class: "dot", style: `background:${s.color}` }), s.label, el("b", {}, fmt.format(p[s.key])))));
      tip.hidden = false;
      const left = (x(i) / W) * rect.width;
      const tipW = tip.offsetWidth;
      tip.style.left = `${left + 12 + tipW > rect.width ? left - tipW - 12 : left + 12}px`;
      tip.style.top = `${m.top}px`;
    };
    const leave = () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      markers.forEach((mk) => mk.setAttribute("visibility", "hidden"));
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", leave);

    wrap.replaceChildren(svg, tip);
  }
  new ResizeObserver(() => { if (state.lastStats) renderChart(state.lastStats.throughput); }).observe($("chart"));

  function renderTypes(types) {
    if (!types.length) {
      $("types").replaceChildren(el("p", { class: "empty" }, "No jobs yet"));
      return;
    }
    const max = Math.max(...types.map((t) => t.count));
    $("types").replaceChildren(...types.map((t) =>
      el("div", { class: "type-row" },
        el("span", { class: "name", title: t.type }, t.type),
        el("span", { class: "val" }, fmt.format(t.count)),
        el("div", { class: "bar" }, el("i", { style: `width:${Math.max(2, (t.count / max) * 100)}%` })))));
  }

  function renderWorkers(workers) {
    $("worker-count").textContent = workers.length;
    if (!workers.length) {
      $("workers").replaceChildren(el("tr", {}, el("td", { colspan: 7, class: "empty" }, "No workers online — start one with npm run worker or docker compose up")));
      return;
    }
    $("workers").replaceChildren(...workers.map((w) =>
      el("tr", {},
        el("td", { class: "mono" }, w.id),
        el("td", {}, w.currentJobId ? statusPill("PROCESSING") : el("span", { class: "pill" }, el("span", { class: "dot neutral" }), "Idle")),
        el("td", { class: "mono" }, w.currentJobId
          ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openJob(w.currentJobId); } }, w.currentJobId)
          : "—"),
        el("td", { class: "num" }, fmt.format(w.processed)),
        el("td", { class: "num" }, fmt.format(w.failed)),
        el("td", {}, ago(w.startedAt)),
        el("td", {}, ago(w.lastSeenAt)))));
  }

  function renderJobs(jobs) {
    $("job-count").textContent = fmt.format(state.total);
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    $("page-label").textContent = `Page ${state.page} of ${pages}`;
    $("prev-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page >= pages;

    if (!jobs.length) {
      $("jobs").replaceChildren(el("tr", {}, el("td", { colspan: 8, class: "empty" }, "No jobs match these filters")));
      return;
    }
    $("jobs").replaceChildren(...jobs.map((j) => {
      const retryable = j.status === "DEAD" || j.status === "FAILED";
      return el("tr", {
        tabindex: 0,
        onclick: () => openJob(j._id),
        onkeydown: (e) => { if (e.key === "Enter") openJob(j._id); },
      },
        el("td", { class: "mono", title: j._id }, j._id.slice(-8)),
        el("td", {}, j.type),
        el("td", {}, el("span", { class: `prio ${j.priority}` }, j.priority)),
        el("td", {}, statusPill(j.status)),
        el("td", { class: "num" }, `${j.attempts}/${j.maxAttempts}`),
        el("td", { title: j.createdAt }, ago(j.createdAt)),
        el("td", { title: j.updatedAt }, ago(j.updatedAt)),
        el("td", {}, retryable
          ? el("button", { class: "btn sm", type: "button", onclick: (e) => { e.stopPropagation(); retry(j._id); } }, "Retry")
          : ""));
    }));
  }

  // ---------- filters & paging ----------
  $("status-filter").addEventListener("change", (e) => { state.status = e.target.value; state.page = 1; refresh(); });
  let typeTimer;
  $("type-filter").addEventListener("input", (e) => {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => { state.type = e.target.value.trim(); state.page = 1; refresh(); }, 300);
  });
  $("prev-page").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); refresh(); });
  $("next-page").addEventListener("click", () => { state.page += 1; refresh(); });

  // ---------- job drawer ----------
  function openJob(id) {
    state.openJobId = id;
    $("drawer").hidden = false;
    $("drawer-body").replaceChildren(el("p", { class: "muted" }, "Loading…"));
    loadJob(id);
  }
  $("drawer-close").addEventListener("click", () => { state.openJobId = null; $("drawer").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("drawer").hidden) $("drawer-close").click();
  });

  async function loadJob(id, quiet) {
    try {
      const { body: j } = await api(`/jobs/${encodeURIComponent(id)}`);
      if (state.openJobId !== id) return;
      const retryable = j.status === "DEAD" || j.status === "FAILED";
      const json = (v) => el("pre", { class: "json" }, JSON.stringify(v, null, 2));
      const parts = [
        el("dl", { class: "kv" },
          el("dt", {}, "ID"), el("dd", { class: "mono" }, j._id),
          el("dt", {}, "Status"), el("dd", {}, statusPill(j.status)),
          el("dt", {}, "Type"), el("dd", {}, j.type),
          el("dt", {}, "Priority"), el("dd", {}, j.priority),
          el("dt", {}, "Attempts"), el("dd", {}, `${j.attempts} of ${j.maxAttempts}`),
          el("dt", {}, "Worker"), el("dd", { class: "mono" }, j.workerId || "—"),
          el("dt", {}, "Last heartbeat"), el("dd", {}, j.lastHeartbeatAt ? ago(j.lastHeartbeatAt) : "—"),
          el("dt", {}, "Idempotency key"), el("dd", { class: "mono" }, j.idempotencyKey || "—"),
          el("dt", {}, "Created"), el("dd", {}, dateTimeFmt.format(new Date(j.createdAt))),
          el("dt", {}, "Updated"), el("dd", {}, dateTimeFmt.format(new Date(j.updatedAt)))),
        j.error ? [el("div", { class: "section-label" }, "Last error"), el("pre", { class: "json error" }, j.error)] : null,
        el("div", { class: "section-label" }, "Payload"), json(j.payload),
        j.result !== undefined ? [el("div", { class: "section-label" }, "Result"), json(j.result)] : null,
        retryable ? el("button", { class: "btn primary", type: "button", onclick: () => retry(j._id) }, "Retry job") : null,
      ];
      $("drawer-body").replaceChildren(...parts.flat().filter(Boolean));
    } catch (err) {
      if (!quiet) $("drawer-body").replaceChildren(el("p", { class: "error" }, err.message));
    }
  }

  async function retry(id) {
    try {
      await api(`/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
      toast("Job re-queued");
      refresh();
    } catch (err) {
      toast(`Retry failed: ${err.message}`);
    }
  }

  // ---------- new job dialog ----------
  $("new-job-btn").addEventListener("click", () => {
    $("new-job-error").textContent = "";
    $("new-job-dialog").showModal();
  });

  $("new-job-submit").addEventListener("click", async () => {
    const form = $("new-job-form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const errorEl = $("new-job-error");
    errorEl.textContent = "";

    let payload;
    try {
      payload = data.get("payload").trim() ? JSON.parse(data.get("payload")) : {};
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    } catch {
      errorEl.textContent = "Payload must be a JSON object";
      return;
    }

    const count = Math.min(200, Math.max(1, Number(data.get("count")) || 1));
    const idempotencyKey = data.get("idempotencyKey").trim();
    const body = {
      type: data.get("type").trim(),
      priority: data.get("priority"),
      maxAttempts: Number(data.get("maxAttempts")) || 3,
      payload,
      ...(idempotencyKey && count === 1 ? { idempotencyKey } : {}),
    };

    const btn = $("new-job-submit");
    btn.disabled = true;
    try {
      let created = 0;
      // Send in small parallel batches to stay friendly with the rate limiter.
      for (let i = 0; i < count; i += 10) {
        const batch = Array.from({ length: Math.min(10, count - i) }, () =>
          api("/jobs", { method: "POST", body: JSON.stringify(body) }));
        const results = await Promise.all(batch);
        created += results.filter((r) => r.status === 201).length;
      }
      $("new-job-dialog").close();
      toast(created === count ? `Enqueued ${count} job${count === 1 ? "" : "s"}` : "Duplicate idempotency key — existing job returned");
      state.page = 1;
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- boot ----------
  const saved = store.get(TOKEN_KEY);
  if (saved && tokenValid(saved)) {
    state.token = saved;
    showApp();
  } else {
    $("login-view").hidden = false;
  }
})();
