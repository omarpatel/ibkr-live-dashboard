/* IBKR Live Dashboard — browser client */
"use strict";

const $ = (id) => document.getElementById(id);

let state = null;
let sortKey = "absValue";
let sortDir = -1; // -1 desc, 1 asc

/* ---------- formatting ---------- */

const CCY_SYMBOL = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CHF: "Fr ", CAD: "C$", AUD: "A$" };

function ccy() {
  return CCY_SYMBOL[state?.currency] ?? "$";
}

function fmtMoney(v, { sign = false, compact = false, dp = 2 } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v < 0 ? "-" : sign ? "+" : "";
  const a = Math.abs(v);
  if (compact && a >= 1_000_000) return `${s}${ccy()}${(a / 1_000_000).toFixed(2)}M`;
  if (compact && a >= 10_000) return `${s}${ccy()}${(a / 1_000).toFixed(1)}K`;
  return `${s}${ccy()}${a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtNum(v, dp = 2) {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtQty(v) {
  if (v == null) return "—";
  return Number.isInteger(v) ? v.toLocaleString("en-US") : fmtNum(v, 2);
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pnlClass(v) {
  if (v == null) return "";
  return v > 0 ? "up" : v < 0 ? "down" : "";
}

function fmtTime(epoch) {
  return new Date(epoch * 1000).toLocaleTimeString("en-US", { hour12: false });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- websocket ---------- */

let ws = null;
let lastMsg = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    lastMsg = Date.now();
    render();
  };
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onerror = () => ws.close();
}
connect();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
}, 15000);

setInterval(() => {
  $("clock").textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
  if (!state) return;
  const age = (Date.now() - lastMsg) / 1000;
  $("foot-updated").textContent =
    lastMsg === 0 ? "" : age < 4 ? "live" : `last update ${Math.round(age)}s ago`;
}, 1000);

/* ---------- render ---------- */

const TILE_DEFS = [
  ["NetLiquidation", "Net liquidation"],
  ["BuyingPower", "Buying power"],
  ["ExcessLiquidity", "Excess liquidity"],
  ["TotalCashValue", "Cash"],
  ["GrossPositionValue", "Gross positions"],
  ["FullMaintMarginReq", "Maint. margin"],
];

function render() {
  const st = state;

  // top bar
  $("account").textContent = st.account ?? "";
  const chip = $("mode-chip");
  chip.textContent = st.mode ? st.mode.toUpperCase() : "";
  chip.className = `chip ${st.mode ?? ""}`;
  chip.classList.toggle("hidden", !st.mode);

  const connected = st.status === "connected" || st.status === "demo";
  $("conn-dot").className = `dot ${connected ? "ok" : "bad"}`;
  $("conn-text").textContent =
    st.status === "demo" ? "demo feed" :
    st.status === "connected" ? `TWS :${st.port}` : "waiting for TWS";
  $("banner").classList.toggle("hidden", st.status !== "connecting");

  // hero
  const daily = st.pnl.daily;
  const hero = $("hero-pnl");
  hero.textContent = fmtMoney(daily, { sign: true });
  hero.className = `hero-value ${pnlClass(daily)}`;
  $("hero-sub").innerHTML =
    `Unrealized <b class="${pnlClass(st.pnl.unrealized)}">${fmtMoney(st.pnl.unrealized, { sign: true })}</b>
     &nbsp;·&nbsp; Realized <b class="${pnlClass(st.pnl.realized)}">${fmtMoney(st.pnl.realized, { sign: true })}</b>`;

  // tiles
  $("tiles").innerHTML = TILE_DEFS.map(([tag, label]) => `
    <div class="tile">
      <div class="stat-label">${label}</div>
      <div class="tile-value">${fmtMoney(st.summary[tag], { compact: true })}</div>
    </div>`).join("");

  renderChart();
  renderTable();

  $("foot-status").textContent =
    st.status === "demo" ? "Demo mode — start without --demo to connect to TWS." :
    st.status === "connected" ? `Connected read-only to ${st.mode} account via port ${st.port}.` :
    "Not connected.";
}

/* ---------- chart ---------- */

const chartEl = $("chart");
let chartGeom = null; // {x0,x1,y0,y1,t0,t1,vmin,vmax,pts}

function renderChart() {
  const hist = state.history ?? [];
  $("chart-current").textContent = "";
  if (hist.length < 2) {
    chartEl.innerHTML = `<div class="chart-empty">collecting data…</div>`;
    chartGeom = null;
    return;
  }

  const W = 1100, H = 240;
  const PAD = { l: 56, r: 76, t: 12, b: 24 };
  const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;

  const t0 = hist[0][0], t1 = hist[hist.length - 1][0];
  let vmin = Math.min(0, ...hist.map((p) => p[1]));
  let vmax = Math.max(0, ...hist.map((p) => p[1]));
  if (vmax === vmin) { vmax += 1; vmin -= 1; }
  const spread = vmax - vmin;
  vmax += spread * 0.08;
  vmin -= spread * 0.08;

  const X = (t) => x0 + ((t - t0) / Math.max(t1 - t0, 1)) * (x1 - x0);
  const Y = (v) => y1 - ((v - vmin) / (vmax - vmin)) * (y1 - y0);

  const pts = hist.map(([t, v]) => [X(t), Y(v), t, v]);
  chartGeom = { x0, x1, y0, y1, t0, t1, vmin, vmax, pts, W, H };

  // y ticks: 3 clean values + zero baseline
  const ticks = niceTicks(vmin, vmax, 4);
  const gridLines = ticks.map((v) =>
    `<line x1="${x0}" y1="${Y(v)}" x2="${x1}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>
     <text x="${x0 - 8}" y="${Y(v) + 4}" text-anchor="end" class="axis-txt">${fmtMoney(v, { compact: true, dp: 0 })}</text>`
  ).join("");

  const zeroY = Y(0);
  const zeroLine = `<line x1="${x0}" y1="${zeroY}" x2="${x1}" y2="${zeroY}" stroke="var(--baseline)" stroke-width="1"/>`;

  // x ticks: hours
  let xTicks = "";
  const startHour = Math.ceil(t0 / 3600) * 3600;
  for (let t = startHour; t <= t1; t += 3600) {
    const d = new Date(t * 1000);
    xTicks += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle" class="axis-txt">${String(d.getHours()).padStart(2, "0")}:00</text>`;
  }

  const linePath = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const areaPath = `${linePath}L${pts[pts.length - 1][0].toFixed(1)},${zeroY}L${pts[0][0].toFixed(1)},${zeroY}Z`;

  const last = pts[pts.length - 1];
  const cur = hist[hist.length - 1][1];
  $("chart-current").innerHTML = `<span class="${pnlClass(cur)}">${fmtMoney(cur, { sign: true })}</span>`;

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Intraday P&L">
      <style>.axis-txt{fill:var(--ink-muted);font-size:11px;font-family:var(--font);font-variant-numeric:tabular-nums}</style>
      ${gridLines}${zeroLine}${xTicks}
      <path d="${areaPath}" fill="var(--accent)" opacity="0.10"/>
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${last[0] + 10}" y="${last[1] + 4}" class="axis-txt" style="fill:var(--ink-2)">${fmtMoney(cur, { sign: true, compact: true })}</text>
      <g id="xhair" style="display:none">
        <line id="xhair-line" y1="${y0}" y2="${y1}" stroke="var(--baseline)" stroke-width="1"/>
        <circle id="xhair-dot" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      </g>
    </svg>`;
}

function niceTicks(min, max, n) {
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks = [];
  for (let v = Math.ceil(min / s) * s; v <= max; v += s) {
    if (Math.abs(v) > s / 2) ticks.push(v); // zero gets its own baseline
  }
  return ticks;
}

chartEl.addEventListener("mousemove", (ev) => {
  if (!chartGeom) return;
  const svg = chartEl.querySelector("svg");
  const rect = svg.getBoundingClientRect();
  const mx = ((ev.clientX - rect.left) / rect.width) * chartGeom.W;

  // nearest point by x
  let best = chartGeom.pts[0];
  for (const p of chartGeom.pts) if (Math.abs(p[0] - mx) < Math.abs(best[0] - mx)) best = p;

  const g = svg.querySelector("#xhair");
  g.style.display = "";
  const line = svg.querySelector("#xhair-line");
  line.setAttribute("x1", best[0]);
  line.setAttribute("x2", best[0]);
  const dot = svg.querySelector("#xhair-dot");
  dot.setAttribute("cx", best[0]);
  dot.setAttribute("cy", best[1]);

  const tip = $("tooltip");
  tip.classList.remove("hidden");
  tip.innerHTML = `<b class="${pnlClass(best[3])}">${fmtMoney(best[3], { sign: true })}</b>${fmtTime(best[2])}`;
  const card = chartEl.closest(".chart-card").getBoundingClientRect();
  const px = rect.left - card.left + (best[0] / chartGeom.W) * rect.width;
  const py = rect.top - card.top + (best[1] / chartGeom.H) * rect.height;
  tip.style.left = `${Math.min(px + 14, card.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(py - 44, 4)}px`;
});

chartEl.addEventListener("mouseleave", () => {
  $("tooltip").classList.add("hidden");
  chartEl.querySelector("#xhair")?.style.setProperty("display", "none");
});

/* ---------- positions table ---------- */

const COLS = [
  ["symbol", "Symbol"],
  ["qty", "Qty"],
  ["avgCost", "Avg cost"],
  ["price", "Last"],
  ["value", "Mkt value"],
  ["dayPnl", "Day P&L"],
  ["unrlPnl", "Unrl P&L"],
  ["unrlPct", "Unrl %"],
  ["absValue", "Weight"],
];

function renderTable() {
  const rows = (state.positions ?? []).map((p) => {
    const basis = p.qty && p.avgCost ? Math.abs(p.qty * p.avgCost) : null;
    return {
      ...p,
      absValue: Math.abs(p.value ?? 0),
      unrlPct: basis ? (p.unrlPnl / basis) * 100 : null,
    };
  });

  const gross = rows.reduce((s, r) => s + r.absValue, 0);
  $("pos-count").textContent = rows.length ? `(${rows.length})` : "";
  $("gross-note").textContent = gross ? `Gross exposure ${fmtMoney(gross, { compact: true })}` : "";

  $("pos-head").innerHTML = COLS.map(([key, label]) =>
    `<th data-key="${key}" class="${key === sortKey ? "sorted" : ""}">${label}${key === sortKey ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`
  ).join("");

  if (!rows.length) {
    $("pos-body").innerHTML = `<tr class="empty-row"><td colspan="${COLS.length}">No open positions</td></tr>`;
    return;
  }

  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
  });

  $("pos-body").innerHTML = rows.map((p) => {
    const w = gross ? (p.absValue / gross) * 100 : 0;
    const tag = p.secType !== "STK" ? `<span class="sec-tag">${esc(p.secType)}</span>` : "";
    const name = p.secType === "STK" ? p.symbol : (p.local || p.symbol);
    return `<tr>
      <td class="sym">${esc(name)}${tag}</td>
      <td>${fmtQty(p.qty)}</td>
      <td>${fmtNum(p.avgCost)}</td>
      <td>${fmtNum(p.price)}</td>
      <td>${fmtMoney(p.value)}</td>
      <td class="${pnlClass(p.dayPnl)}">${fmtMoney(p.dayPnl, { sign: true })}</td>
      <td class="${pnlClass(p.unrlPnl)}">${fmtMoney(p.unrlPnl, { sign: true })}</td>
      <td class="${pnlClass(p.unrlPct)}">${fmtPct(p.unrlPct)}</td>
      <td class="weight-cell">${w.toFixed(1)}%<span class="wbar"><i style="width:${Math.min(w, 100)}%"></i></span></td>
    </tr>`;
  }).join("");
}

$("pos-head").addEventListener("click", (ev) => {
  const th = ev.target.closest("th");
  if (!th) return;
  const key = th.dataset.key;
  if (key === sortKey) sortDir *= -1;
  else { sortKey = key; sortDir = key === "symbol" ? 1 : -1; }
  if (state) renderTable();
});
