"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  readings: [],
  range: 30,          // days, 0 = all
  mode: "usage",      // usage | meter
  bucket: "auto",
};

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fmtM3 = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
function fmtLitres(l) {
  if (Math.abs(l) >= 10000) return `${(l / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} m³`;
  return `${Math.round(l).toLocaleString()} L`;
}
const fmtWhen = (d) => d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtShort = (d) => d.toLocaleString(undefined, {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  ...(d.getFullYear() !== new Date().getFullYear() && { year: "2-digit" }),
});
function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.status === 204 ? null : res.json();
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- data ----------
async function load() {
  const rows = await api("api/readings");
  state.readings = rows.map((r) => ({ ...r, t: new Date(r.ts).getTime() })).sort((a, b) => a.t - b.t || a.id - b.id);
  render();
}

// Meter value at time t, linearly interpolated between readings. null outside known span.
function valueAt(t) {
  const r = state.readings;
  if (!r.length || t < r[0].t || t > r[r.length - 1].t) return null;
  let lo = 0, hi = r.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = r[lo], b = r[hi];
  if (b.t === a.t) return b.value;
  return a.value + (b.value - a.value) * ((t - a.t) / (b.t - a.t));
}

function rangeBounds() {
  const r = state.readings;
  const now = Date.now();
  const end = Math.max(now, r.length ? r[r.length - 1].t : now);
  const start = state.range ? end - state.range * 864e5 : (r.length ? r[0].t : end - 864e5);
  return [start, end];
}

function bucketStart(t, unit) {
  const d = new Date(t);
  if (unit === "hour") d.setMinutes(0, 0, 0);
  else {
    d.setHours(0, 0, 0, 0);
    if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    if (unit === "month") d.setDate(1);
  }
  return d.getTime();
}
function bucketNext(t, unit) {
  const d = new Date(t);
  if (unit === "hour") d.setHours(d.getHours() + 1);
  else if (unit === "day") d.setDate(d.getDate() + 1);
  else if (unit === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
function autoBucket(start, end) {
  const days = (end - start) / 864e5;
  if (days <= 3) return "hour";
  if (days <= 62) return "day";
  if (days <= 370) return "week";
  return "month";
}
function bucketLabel(t, unit) {
  const d = new Date(t);
  if (unit === "hour") return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  if (unit === "day") return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (unit === "week") return `Week of ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Litres used per calendar bucket, splitting each interval between readings proportionally.
function usageBuckets(start, end, unit) {
  const r = state.readings;
  const out = [];
  if (r.length < 2) return out;
  const first = r[0].t, last = r[r.length - 1].t;
  for (let b = bucketStart(start, unit); b < end; b = bucketNext(b, unit)) {
    const e = bucketNext(b, unit);
    const s0 = Math.max(b, first), e0 = Math.min(e, last);
    const used = e0 > s0 ? Math.max(0, (valueAt(e0) - valueAt(s0)) * 1000) : null;
    out.push({ t: b, label: bucketLabel(b, unit), litres: used, partial: e0 > s0 && (s0 > b || e0 < e) });
  }
  return out;
}

// The valve state is recorded with readings and holds until a later reading records another one.
function valveIntervals() {
  const out = [];
  for (const r of state.readings) {
    if (!r.valve) continue;
    const last = out[out.length - 1];
    if (last && last.state === r.valve) continue;
    if (last) last.end = r.t;
    out.push({ state: r.valve, start: r.t, end: Infinity });
  }
  return out;
}

function valveAt(t, intervals = valveIntervals()) {
  const iv = intervals.find((i) => i.start <= t && t < i.end);
  return iv ? iv.state : null;
}

// Share of [s, e) during which the valve was recorded closed.
function closedFraction(s, e, intervals) {
  let closed = 0;
  for (const i of intervals) {
    if (i.state !== "closed") continue;
    closed += Math.max(0, Math.min(e, i.end) - Math.max(s, i.start));
  }
  return e > s ? closed / (e - s) : 0;
}

const VALVE_LABEL = { open: "Open", closed: "Closed" };

// ---------- rendering ----------
let chart;
function render() {
  renderStats();
  renderChart();
  renderTable();
}

function renderStats() {
  const r = state.readings;
  const last = r[r.length - 1];
  $("#stat-latest").textContent = last ? `${fmtM3(last.value)} m³` : "–";
  $("#stat-latest-when").textContent = last ? fmtWhen(new Date(last.t)) : "";
  const iv = valveIntervals().pop();
  $("#stat-valve").textContent = iv ? VALVE_LABEL[iv.state] : "–";
  $("#stat-valve-when").textContent = iv ? `since ${fmtWhen(new Date(iv.start))}` : "not recorded yet";
  const [start, end] = rangeBounds();
  const s0 = Math.max(start, r.length ? r[0].t : start);
  const e0 = Math.min(end, last ? last.t : end);
  if (r.length >= 2 && e0 > s0) {
    const litres = (valueAt(e0) - valueAt(s0)) * 1000;
    const days = (e0 - s0) / 864e5;
    $("#stat-used").textContent = fmtLitres(litres);
    $("#stat-used-sub").textContent = `${days < 2 ? `${(days * 24).toFixed(1)} h` : `${days.toFixed(1)} days`} of data`;
    $("#stat-avg").textContent = days >= 1 / 24 ? `${fmtLitres(litres / days)}` : "–";
  } else {
    $("#stat-used").textContent = "–";
    $("#stat-used-sub").textContent = "need two readings in range";
    $("#stat-avg").textContent = "–";
  }
}

function baseOption() {
  const text2 = cssVar("--text-secondary"), grid = cssVar("--grid"), surface = cssVar("--surface-1");
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: text2, fontFamily: "system-ui, sans-serif" },
    grid: { left: 8, right: 16, top: 16, bottom: 64, containLabel: true },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: surface,
      borderColor: cssVar("--border"),
      textStyle: { color: cssVar("--text-primary") },
    },
    dataZoom: [
      { type: "inside", filterMode: "none", zoomOnMouseWheel: true, moveOnMouseMove: true },
      { type: "slider", filterMode: "none", height: 28, bottom: 8, borderColor: grid,
        textStyle: { color: text2 }, brushSelect: false },
    ],
    yAxis: {
      type: "value",
      axisLabel: { color: text2 },
      splitLine: { lineStyle: { color: grid } },
    },
  };
}

function renderChart() {
  if (!chart) {
    chart = echarts.init($("#chart"), null, { renderer: "canvas" });
    window.addEventListener("resize", () => chart.resize());
  }
  const [start, end] = rangeBounds();
  const series1 = cssVar("--series-1"), text2 = cssVar("--text-secondary"), text1 = cssVar("--text-primary");
  const opt = baseOption();
  const sel = $("#bucket");
  sel.hidden = state.mode !== "usage";

  if (state.mode === "usage") {
    const unit = state.bucket === "auto" ? autoBucket(start, end) : state.bucket;
    const buckets = usageBuckets(start, end, unit);
    const intervals = valveIntervals();
    const now = Date.now();
    buckets.forEach((b) => {
      b.end = bucketNext(b.t, unit);
      b.closed = closedFraction(b.t, Math.min(b.end, now), intervals);
    });
    // A real time axis (not categories) so valve bands can start and end at the exact recorded times.
    const x0 = buckets.length ? buckets[0].t : start;
    const x1 = buckets.length ? buckets[buckets.length - 1].end : end;
    $("#chart-title").textContent = `Litres used ${unit === "day" ? "per day" : `per ${unit}`}`;
    Object.assign(opt, {
      xAxis: timeAxis(x0, x1, text2),
      series: [{
        type: "bar",
        name: "Used",
        data: buckets.map((b) => [(b.t + b.end) / 2, b.litres]),
        itemStyle: { color: series1, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 28,
        barCategoryGap: "20%",
        emphasis: { itemStyle: { color: series1, opacity: 0.8 } },
        markArea: valveBandStyle(closedBands(intervals, x0, x1), text2),
      }],
    });
    opt.yAxis.axisLabel.formatter = (v) => `${v} L`;
    opt.tooltip.trigger = "item";
    opt.tooltip.formatter = (p) => {
      const b = buckets[p.dataIndex];
      if (b.litres == null) return `${esc(b.label)}<br>no data`;
      return `<b style="font-size:1.1em">${fmtLitres(b.litres)}</b><br>${esc(b.label)}` +
        (b.partial ? `<br><span style="opacity:.7">partial – only part of this ${unit} has readings</span>` : "") +
        `<br><span style="opacity:.7">estimated between readings</span>` +
        (b.closed > 0 ? `<br>Valve closed ${Math.round(b.closed * 100)}% of this ${unit}` : "") +
        (b.closed > 0.99 && b.litres > 0.5 ? `<br><b>Water used while the valve was closed</b>` : "");
    };
  } else {
    // Keep one reading either side of the window so the line runs to the edges.
    const r = state.readings;
    const i0 = Math.max(0, r.findIndex((x) => x.t >= start) - 1);
    let i1 = r.findIndex((x) => x.t > end);
    i1 = i1 === -1 ? r.length : i1 + 1;
    const pts = (r.findIndex((x) => x.t >= start) === -1 ? r.slice(-1) : r.slice(i0, i1))
      .map((x) => ({ value: [x.t, x.value], valve: x.valve }));
    const intervals = valveIntervals();
    $("#chart-title").textContent = "Meter reading (m³)";
    Object.assign(opt, {
      xAxis: timeAxis(start, end, text2),
      series: [{
        type: "line",
        name: "Reading",
        data: pts,
        showSymbol: true,
        symbol: "circle",
        symbolSize: 8,
        lineStyle: { width: 2, color: series1 },
        itemStyle: { color: series1, borderColor: cssVar("--surface-1"), borderWidth: 2 },
        markArea: valveBandStyle(closedBands(intervals, start, end), text2),
      }],
    });
    opt.yAxis.scale = true;
    // Let the y-axis follow the zoomed window instead of the whole series.
    opt.dataZoom.forEach((z) => { z.filterMode = "weakFilter"; });
    opt.yAxis.axisLabel.formatter = (v) => v.toFixed(v % 1 ? 3 : 0);
    opt.tooltip.axisPointer = { type: "line", snap: true };
    opt.tooltip.formatter = (ps) => {
      const p = ps[0];
      const valve = p.data.valve || valveAt(p.value[0], intervals);
      return `<b style="font-size:1.1em;color:${text1}">${fmtM3(p.value[1])} m³</b><br>${esc(fmtWhen(new Date(p.value[0])))}` +
        (valve ? `<br>Valve ${valve}${p.data.valve ? "" : " (last recorded)"}` : "");
    };
  }

  const [lo, hi] = state.mode === "usage" ? [opt.xAxis.min, opt.xAxis.max] : [start, end];
  $("#valve-legend").hidden = !valveIntervals().some((i) => i.state === "closed" && i.end > lo && i.start < hi);

  const empty = state.mode === "usage" ? state.readings.length < 2 : state.readings.length === 0;
  opt.graphic = empty ? [{ type: "text", left: "center", top: "middle",
    style: { text: state.mode === "usage" ? "Need at least two readings" : "No readings yet", fill: text2, fontSize: 14 } }] : [];
  chart.setOption(opt, true);
}

function timeAxis(min, max, text2) {
  return {
    type: "time", min, max, splitNumber: Math.max(2, Math.floor($("#chart").clientWidth / 90)),
    axisLabel: { color: text2, hideOverlap: true,
                 formatter: { year: "{yyyy}", month: "{MMM}", day: "{d} {MMM}", hour: "{HH}:{mm}", minute: "{HH}:{mm}" } },
    axisLine: { lineStyle: { color: cssVar("--grid") } }, splitLine: { show: false },
  };
}

// Shaded spans for "valve closed", clipped to [min, max]. Only wide spans get a text label.
function closedBands(intervals, min, max) {
  const px = $("#chart").clientWidth / Math.max(1, max - min);
  const now = Date.now();
  return intervals
    .filter((i) => i.state === "closed" && i.end > min && i.start < max)
    .map((i) => {
      const s = Math.max(i.start, min), e = Math.min(i.end === Infinity ? Math.max(now, i.start) : i.end, max);
      return [{ xAxis: s, name: (e - s) * px > 80 ? "Valve closed" : "" }, { xAxis: e }];
    });
}

function valveBandStyle(bands, text2) {
  return {
    silent: true,
    itemStyle: { color: cssVar("--band") },
    label: { show: true, position: "insideTop", color: text2, fontSize: 11, distance: 4 },
    data: bands,
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTable() {
  const body = $("#rows");
  body.replaceChildren();
  const r = state.readings;
  $("#empty").hidden = r.length > 0;
  for (let i = r.length - 1; i >= 0; i--) {
    const row = r[i], prev = r[i - 1];
    const tr = document.createElement("tr");
    const delta = prev ? (row.value - prev.value) * 1000 : null;
    if (delta != null && delta < 0) tr.className = "bad";

    const tdWhen = document.createElement("td");
    tdWhen.textContent = fmtShort(new Date(row.t));
    tdWhen.title = fmtWhen(new Date(row.t));
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = { camera: "📷", upload: "🖼️", manual: "✏️", seed: "🌱" }[row.source] || "";
    src.title = row.source;
    tdWhen.append(src);
    if (row.valve) {
      const tag = document.createElement("span");
      tag.className = `valve-tag ${row.valve}`;
      tag.textContent = `valve ${row.valve}`;
      tdWhen.append(tag);
    }

    const tdVal = document.createElement("td");
    tdVal.className = "num";
    tdVal.textContent = fmtM3(row.value);

    const tdDelta = document.createElement("td");
    tdDelta.className = "num";
    tdDelta.textContent = delta == null ? "" : `${delta >= 0 ? "+" : ""}${Math.round(delta).toLocaleString()}`;
    if (delta != null && delta < 0) tdDelta.title = "Lower than the previous reading – check this value";

    const tdGo = document.createElement("td");
    tdGo.className = "go";
    tdGo.textContent = "›";

    tr.tabIndex = 0;
    tr.title = "Edit or delete";
    tr.addEventListener("click", () => openEdit(row));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openEdit(row); });
    tr.append(tdWhen, tdVal, tdDelta, tdGo);
    body.append(tr);
  }
}

// ---------- review / edit sheet ----------
const sheet = $("#sheet");
const sheetState = { mode: "new", id: null, source: "manual", image: null, ocrRaw: null, crop: null, valve: null, valveRequired: false };

// Main valve selector. null = not recorded. When required (camera photos) "Not recorded" is hidden.
function setValve(v) {
  sheetState.valve = v;
  $("#valve-field").classList.remove("missing");
  $("#valve-unknown").hidden = sheetState.valveRequired;
  document.querySelectorAll(".valve-seg button").forEach((b) => {
    const on = b.dataset.valve === (v || (sheetState.valveRequired ? "" : "unknown"));
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
}
$(".valve-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setValve(b.dataset.valve === "unknown" ? null : b.dataset.valve);
});

function valveHint() {
  const iv = valveIntervals().pop();
  $("#valve-hint").textContent = iv ? `· last recorded ${iv.state}, ${fmtShort(new Date(iv.start))}` : "";
}

function resetSheet() {
  $("#f-value").value = "";
  $("#f-note").value = "";
  $("#f-ts").value = toLocalInput(new Date());
  $("#value-warn").hidden = true;
  $("#photo-wrap").hidden = true;
  $("#box").hidden = true;
  $("#btn-delete").hidden = true;
  $("#btn-reread").disabled = true;
  $("#ocr-status").textContent = "";
  Object.assign(sheetState, { mode: "new", id: null, source: "manual", image: null, ocrRaw: null, crop: null,
                              batchRow: null, valveRequired: false });
  setValve(null);
  valveHint();
}

$("#btn-manual").addEventListener("click", () => {
  resetSheet();
  $("#sheet-title").textContent = "New reading";
  sheet.showModal();
  $("#f-value").focus();
});

function openEdit(row) {
  resetSheet();
  Object.assign(sheetState, { mode: "edit", id: row.id, source: row.source, image: row.image });
  $("#sheet-title").textContent = "Edit reading";
  $("#f-value").value = row.value.toFixed(3);
  $("#f-ts").value = toLocalInput(new Date(row.t));
  $("#f-note").value = row.note || "";
  setValve(row.valve || null);
  $("#btn-delete").hidden = false;
  if (row.image) {
    $("#photo-wrap").hidden = false;
    $("#photo").src = `api/images/${encodeURIComponent(row.image)}`;
    $("#ocr-status").textContent = row.ocr_raw ? `OCR read: ${row.ocr_raw}` : "";
  }
  sheet.showModal();
}

$("#in-camera").addEventListener("change", (e) => handlePhoto(e.target, "camera"));
$("#in-upload").addEventListener("change", (e) => handlePhoto(e.target, "upload"));

async function handlePhoto(input, source) {
  const files = [...(input.files || [])];
  input.value = "";
  if (files.length > 1) return startBatch(files);
  const file = files[0];
  if (!file) return;
  resetSheet();
  sheetState.source = source;
  if (source === "camera") {
    // The user is standing at the meter: ask what the main valve looks like right now.
    sheetState.valveRequired = true;
    setValve(null);
  }
  $("#sheet-title").textContent = source === "camera" ? "New reading from camera" : "New reading from photo";
  $("#photo-wrap").hidden = false;
  const localUrl = URL.createObjectURL(file);
  $("#photo").src = localUrl;
  // Camera shots are "now"; uploads fall back to the file's modification time until EXIF is known.
  $("#f-ts").value = toLocalInput(source === "camera" ? new Date() : new Date(file.lastModified || Date.now()));
  sheet.showModal();
  await runOcr({ file });
  URL.revokeObjectURL(localUrl);
}

async function runOcr({ file, crop }) {
  const fd = new FormData();
  if (file) fd.append("file", file);
  else fd.append("image", sheetState.image);
  if (crop) fd.append("crop", crop.map((v) => v.toFixed(4)).join(","));
  $("#ocr-status").textContent = "Reading the meter…";
  $("#btn-reread").disabled = true;
  $("#btn-save").disabled = true;
  try {
    const res = await api("api/ocr", { method: "POST", body: fd });
    sheetState.image = res.image;
    sheetState.ocrRaw = res.digits || null;
    $("#photo").src = `api/images/${encodeURIComponent(res.image)}`;
    if (res.taken_at && file) $("#f-ts").value = res.taken_at.slice(0, 19);
    if (res.box) showBox(res.box);
    if (res.value != null) {
      $("#f-value").value = res.value.toFixed(3);
      $("#ocr-status").textContent = `Read ${res.digits} → ${fmtM3(res.value)} m³. Please double-check the digits.`;
    } else {
      $("#ocr-status").textContent = "Couldn't read the counter. Drag a box around the digits and tap “Read again”, or type the value.";
    }
    checkValue();
  } catch (err) {
    $("#ocr-status").textContent = `OCR failed: ${err.message}`;
  } finally {
    $("#btn-save").disabled = false;
    $("#btn-reread").disabled = !sheetState.crop;
  }
}

function showBox([x, y, w, h]) {
  const b = $("#box");
  Object.assign(b.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
  b.hidden = false;
}

// Drag a rectangle on the photo to tell the OCR where the counter is.
(function setupCropper() {
  const stage = $("#photo-stage");
  let startPt = null;
  const rel = (e) => {
    const r = stage.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  stage.addEventListener("pointerdown", (e) => {
    if (!sheetState.image || sheetState.mode === "edit") return;
    startPt = rel(e);
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!startPt) return;
    const p = rel(e);
    const box = [Math.min(startPt[0], p[0]), Math.min(startPt[1], p[1]), Math.abs(p[0] - startPt[0]), Math.abs(p[1] - startPt[1])];
    showBox(box);
    sheetState.crop = box;
  });
  const end = () => {
    if (!startPt) return;
    startPt = null;
    const c = sheetState.crop;
    if (c && c[2] > 0.02 && c[3] > 0.01) $("#btn-reread").disabled = false;
    else sheetState.crop = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
})();

$("#btn-reread").addEventListener("click", () => {
  if (sheetState.crop) runOcr({ crop: sheetState.crop });
});

function parseValueText(text) {
  const v = text.trim().replace(",", ".");
  return /^\d+(\.\d{1,3})?$/.test(v) ? parseFloat(v) : null;
}
const parseValue = () => parseValueText($("#f-value").value);

// Warn (but allow) when a value goes backwards or jumps implausibly. `others` = [{t, value}].
function plausibilityWarning(v, ts, others) {
  const sorted = [...others].sort((a, b) => a.t - b.t);
  const before = sorted.filter((r) => r.t <= ts).pop();
  const after = sorted.find((r) => r.t > ts);
  if (before && v < before.value) {
    return `Lower than the previous reading (${fmtM3(before.value)} m³ on ${fmtWhen(new Date(before.t))}).`;
  }
  if (after && v > after.value) {
    return `Higher than the next reading (${fmtM3(after.value)} m³ on ${fmtWhen(new Date(after.t))}).`;
  }
  if (before) {
    const days = Math.max((ts - before.t) / 864e5, 1 / 24);
    const perDay = ((v - before.value) * 1000) / days;
    if (perDay > 5000) return `That is ${fmtLitres(perDay)}/day since the previous reading – is the value right?`;
  }
  return "";
}

function checkValue() {
  const v = parseValue();
  const ts = new Date($("#f-ts").value).getTime();
  const warn = $("#value-warn");
  warn.hidden = true;
  if (v == null || isNaN(ts)) return;
  const others = sheetState.mode === "batch"
    ? batchComparables(sheetState.batchRow)
    : state.readings.filter((r) => r.id !== sheetState.id);
  warn.textContent = plausibilityWarning(v, ts, others);
  warn.hidden = !warn.textContent;
}
$("#f-value").addEventListener("input", checkValue);
$("#f-ts").addEventListener("change", checkValue);

$("#btn-cancel").addEventListener("click", () => sheet.close());

$("#btn-delete").addEventListener("click", async () => {
  if (!confirm("Delete this reading?")) return;
  try {
    await api(`api/readings/${sheetState.id}`, { method: "DELETE" });
    sheet.close();
    toast("Reading deleted");
    load();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
});

$("#sheet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = parseValue();
  const ts = new Date($("#f-ts").value);
  if (value == null) return toast("Enter the reading as a number, e.g. 142.738");
  if (isNaN(ts)) return toast("Pick a date and time");
  const note = $("#f-note").value.trim();
  if (sheetState.valveRequired && !sheetState.valve) {
    $("#valve-field").classList.add("missing");
    $("#valve-field").scrollIntoView({ block: "center", behavior: "smooth" });
    return toast("Is the main valve open or closed?");
  }
  const valve = sheetState.valve;
  if (sheetState.mode === "batch") {
    // Hand the corrected values back to the batch list; nothing is saved yet.
    Object.assign(sheetState.batchRow, {
      valueText: value.toFixed(3), ts: $("#f-ts").value, note, valve,
      image: sheetState.image, ocrRaw: sheetState.ocrRaw, include: true,
    });
    sheet.close();
    renderBatch();
    return;
  }
  try {
    if (sheetState.mode === "edit") {
      await api(`api/readings/${sheetState.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, ts: ts.toISOString(), note, valve: valve || "unknown" }),
      });
    } else {
      await api("api/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value, ts: ts.toISOString(), note: note || null, valve,
          source: sheetState.source, image: sheetState.image, ocr_raw: sheetState.ocrRaw,
        }),
      });
    }
    sheet.close();
    toast("Saved");
    load();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
});

// ---------- several photos at once ----------
const batchDlg = $("#batch");
let batch = [];  // [{file, url, status: pending|reading|done|error, image, valueText, ts, ocrRaw, box, note, include, el}]

function batchComparables(except) {
  const rows = batch
    .filter((r) => r !== except && r.include && parseValueText(r.valueText || "") != null && r.ts)
    .map((r) => ({ t: new Date(r.ts).getTime(), value: parseValueText(r.valueText) }));
  return [...state.readings, ...rows];
}

async function startBatch(files) {
  batch.forEach((r) => URL.revokeObjectURL(r.url));
  batch = files.map((file) => ({
    file, url: URL.createObjectURL(file), status: "pending", image: null, valueText: "",
    ts: toLocalInput(new Date(file.lastModified || Date.now())), ocrRaw: null, box: null, note: "", valve: null, include: true,
  }));
  $("#batch-list").replaceChildren(...batch.map(batchRowEl));
  renderBatch();
  batchDlg.showModal();

  // One at a time: OCR is CPU-bound on the server.
  for (const row of batch) {
    if (!batchDlg.open) break;
    row.status = "reading";
    renderBatch();
    try {
      const fd = new FormData();
      fd.append("file", row.file);
      const res = await api("api/ocr", { method: "POST", body: fd });
      Object.assign(row, { status: "done", image: res.image, ocrRaw: res.digits || null, box: res.box });
      if (res.taken_at) row.ts = res.taken_at.slice(0, 19);
      if (res.value != null) row.valueText = res.value.toFixed(3);
      else row.include = false;  // nothing read: opt-in after fixing
    } catch (err) {
      Object.assign(row, { status: "error", error: err.message, include: false });
    }
    renderBatch();
  }
  // Review in time order.
  batch.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  $("#batch-list").replaceChildren(...batch.map((r) => r.el));
  renderBatch();
}

function batchRowEl(row) {
  const li = document.createElement("li");
  li.className = "batch-row";

  const thumb = document.createElement("button");
  thumb.type = "button";
  thumb.className = "thumb";
  thumb.title = "Open photo to fix the reading";
  const img = document.createElement("img");
  img.alt = row.file.name;
  img.src = row.url;
  thumb.append(img);
  thumb.addEventListener("click", () => openBatchRow(row));

  const fields = document.createElement("div");
  fields.className = "fields";
  const value = document.createElement("input");
  value.type = "text";
  value.inputMode = "decimal";
  value.placeholder = "m³";
  value.setAttribute("aria-label", "Reading (m³)");
  value.addEventListener("input", () => { row.valueText = value.value; if (value.value) row.include = true; renderBatch(); });
  const ts = document.createElement("input");
  ts.type = "datetime-local";
  ts.step = 1;
  ts.setAttribute("aria-label", "Date and time");
  ts.addEventListener("change", () => { row.ts = ts.value; renderBatch(); });
  const msg = document.createElement("p");
  msg.className = "msg";
  fields.append(value, ts, msg);

  const incl = document.createElement("input");
  incl.type = "checkbox";
  incl.className = "incl";
  incl.title = "Save this reading";
  incl.addEventListener("change", () => { row.include = incl.checked; renderBatch(); });

  li.append(thumb, fields, incl);
  row.el = li;
  row.ui = { value, ts, msg, incl };
  return li;
}

function renderBatch() {
  let pending = 0, ready = 0, invalid = 0;
  for (const row of batch) {
    const { value, ts, msg, incl } = row.ui;
    if (document.activeElement !== value) value.value = row.valueText;
    if (document.activeElement !== ts) ts.value = row.ts;
    incl.checked = row.include;
    row.el.classList.toggle("skip", !row.include);
    const busy = row.status === "pending" || row.status === "reading";
    value.disabled = ts.disabled = incl.disabled = busy;
    if (busy) pending++;

    const v = parseValueText(row.valueText || "");
    const t = new Date(row.ts).getTime();
    const bad = row.include && !busy && (v == null || isNaN(t));
    value.classList.toggle("invalid", bad && v == null);
    if (bad) invalid++;
    else if (row.include && !busy) ready++;

    msg.classList.remove("warn");
    if (row.status === "pending") msg.textContent = "Waiting…";
    else if (row.status === "reading") msg.textContent = "Reading the meter…";
    else if (row.status === "error") msg.textContent = `Failed: ${row.error}`;
    else if (row.include && v != null && !isNaN(t)) {
      const w = plausibilityWarning(v, t, batchComparables(row));
      msg.textContent = [w || (row.ocrRaw ? `Read ${row.ocrRaw}` : ""), row.valve && `valve ${row.valve}`]
        .filter(Boolean).join(" · ");
      if (w) msg.classList.add("warn");
    } else if (!row.valueText) msg.textContent = "Couldn't read the counter – tap the photo to fix it, or type the value.";
    else msg.textContent = "";
  }
  const total = batch.length;
  $("#batch-title").textContent = `Review ${total} photos`;
  $("#batch-status").textContent = pending
    ? `Reading ${total - pending + 1} of ${total}…`
    : `${ready} ready to save${invalid ? `, ${invalid} need a value` : ""}.`;
  const save = $("#batch-save");
  save.disabled = pending > 0 || ready === 0 || invalid > 0;
  save.textContent = ready ? `Save ${ready}` : "Save";
}

function openBatchRow(row) {
  if (row.status !== "done" && row.status !== "error") return;
  resetSheet();
  Object.assign(sheetState, { mode: "batch", batchRow: row, source: "upload", image: row.image, ocrRaw: row.ocrRaw });
  $("#sheet-title").textContent = row.file.name;
  $("#photo-wrap").hidden = false;
  $("#photo").src = row.image ? `api/images/${encodeURIComponent(row.image)}` : row.url;
  if (row.box) showBox(row.box);
  $("#ocr-status").textContent = row.ocrRaw ? `OCR read: ${row.ocrRaw}` : "";
  $("#f-value").value = row.valueText;
  $("#f-ts").value = row.ts;
  $("#f-note").value = row.note;
  setValve(row.valve);
  $("#btn-save").textContent = "Done";
  sheet.showModal();
  checkValue();
}
sheet.addEventListener("close", () => { $("#btn-save").textContent = "Save"; });

$("#batch-cancel").addEventListener("click", () => batchDlg.close());
batchDlg.addEventListener("close", () => {
  batch.forEach((r) => URL.revokeObjectURL(r.url));
  batch = [];
  $("#batch-list").replaceChildren();
});

$("#batch-save").addEventListener("click", async () => {
  const rows = batch.filter((r) => r.include && (r.status === "done" || r.status === "error"));
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  $("#batch-save").disabled = true;
  let saved = 0;
  const failed = [];
  for (const row of rows) {
    try {
      await api("api/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: parseValueText(row.valueText), ts: new Date(row.ts).toISOString(), note: row.note || null, valve: row.valve,
          source: "upload", image: row.image, ocr_raw: row.ocrRaw,
        }),
      });
      saved++;
      row.include = false;
      row.el.remove();
    } catch (err) {
      failed.push(`${row.file.name}: ${err.message}`);
    }
  }
  batch = batch.filter((r) => r.el.isConnected);
  load();
  if (failed.length) {
    toast(`Saved ${saved}, ${failed.length} failed: ${failed[0]}`, 6000);
    renderBatch();
  } else {
    batchDlg.close();
    toast(`Saved ${saved} reading${saved === 1 ? "" : "s"}`);
  }
});

// ---------- filters ----------
function segment(id, key, parse) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state[key] = parse(b.dataset[key]);
    render();
  });
}
segment("#range", "range", Number);
segment("#mode", "mode", String);
$("#bucket").addEventListener("change", (e) => { state.bucket = e.target.value; renderChart(); });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderChart());

load().catch((err) => toast(`Could not load readings: ${err.message}`, 5000));
