"use strict";

const INDEX_HTML = "";
const CHART_WIDGET_HTML = "";
const MANIFEST = { version: 1, charts: [], tables: [], blocks: [], sources: [] };
const SNAPSHOT = { version: 1, datasets: [] };
const PACKAGE_INFO = {"artifactId":"e6497af57eaa9be1023561524b451d8a19526273b85e56c919657882a9885f90","artifactRuntime":"datascience-artifact-widget.html","deliveryMode":"site_creator","exportedAt":"2026-08-06T05:58:16.699Z","handoffPluginName":"Data Analytics","hostedEditing":"presentation","hostedReadOnly":true,"controls":{"delete":true,"edit":true,"export":true,"exportHostedLink":false,"refresh":true,"hostedLink":false,"html":true,"pdf":true,"document":true,"slides":true}};
const SOURCE_TEXT = new Map();
const ARTIFACT_ID = PACKAGE_INFO.artifactId;
const PRESENTATION_EDITING_ENABLED = true;
const EDITOR_EMAIL_HASH = "c6aaddba27c7836406ea807aaaec2377084e5587da4887eedc628c00c30e55ab";
const PRESENTATION_KEY = "current";
const PRESENTATION_SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS data_analytics_presentation_v1 (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, overrides_json TEXT NOT NULL)";
const MAX_PRESENTATION_BYTES = 250000;
const MAX_PRESENTATION_TEXT = 20000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function normalizedEmail(request) {
  return String(request.headers.get("oai-authenticated-user-email") || "").trim().toLowerCase();
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function canEditPresentation(request) {
  if (!PRESENTATION_EDITING_ENABLED) return false;
  const email = normalizedEmail(request);
  if (!email || !EDITOR_EMAIL_HASH) return false;
  try {
    return await sha256Hex(email) === EDITOR_EMAIL_HASH;
  } catch {
    return false;
  }
}

function knownIds(items) {
  return new Set((Array.isArray(items) ? items : []).map((item) => item && item.id).filter((id) => typeof id === "string"));
}

const CHART_IDS = knownIds(MANIFEST.charts);
const CHARTS_BY_ID = new Map((Array.isArray(MANIFEST.charts) ? MANIFEST.charts : [])
  .filter((chart) => chart && typeof chart.id === "string")
  .map((chart) => [chart.id, chart]));
const TABLE_IDS = knownIds(MANIFEST.tables);
const BLOCK_TEXT_IDS = new Set((Array.isArray(MANIFEST.blocks) ? MANIFEST.blocks : [])
  .filter((block) => block && block.type === "markdown" && typeof block.id === "string")
  .map((block) => block.id));
const PRESENTATION_CHART_TYPES = new Set([
  "line",
  "area",
  "stackedArea",
  "bar",
  "horizontalBar",
  "stackedBar",
  "stackedBar100",
  "horizontalStackedBar",
  "horizontalStackedBar100",
  "histogram",
  "scatter",
  "heatmap",
  "pie",
  "leaderboard",
  "sparkline",
  "funnel",
  "waterfall",
  "boxPlot",
]);
const PRESENTATION_SERIES_COLORS = new Set([
  "blue",
  "purple",
  "green",
  "neutral",
  "orange",
  "yellow",
  "pink",
  "red",
]);
const PRESENTATION_SERIES_LINE_STYLES = new Set(["solid", "dashed", "dotted"]);
const PRESENTATION_SERIES_ROLES = new Set([
  "actual",
  "baseline",
  "target",
  "forecast",
  "plan",
  "comparison",
]);
const LAYOUT_IDS = new Set();
for (const block of Array.isArray(MANIFEST.blocks) ? MANIFEST.blocks : []) {
  if (!block || typeof block.id !== "string") continue;
  LAYOUT_IDS.add(block.id);
  if (block.type === "metric-strip" && Array.isArray(block.cardIds)) {
    for (const cardId of block.cardIds) {
      if (typeof cardId === "string") LAYOUT_IDS.add("metric:" + block.id + ":" + cardId);
    }
  }
}

function sanitizeTextMap(value, allowedIds, allowedFields, strict) {
  if (value == null) return {};
  if (!isPlainObject(value)) validationError("presentation text overrides must be objects");
  const output = {};
  for (const [id, rawOverride] of Object.entries(value)) {
    if (!allowedIds.has(id)) {
      if (strict) validationError("presentation override references an unknown id");
      continue;
    }
    if (!isPlainObject(rawOverride)) {
      if (strict) validationError("presentation text override must be an object");
      continue;
    }
    const nextOverride = {};
    for (const [field, rawText] of Object.entries(rawOverride)) {
      if (!allowedFields.includes(field)) {
        if (strict) validationError("presentation override contains an unsupported field");
        continue;
      }
      if (typeof rawText !== "string" || rawText.length > MAX_PRESENTATION_TEXT) {
        if (strict) validationError("presentation text is invalid or too large");
        continue;
      }
      nextOverride[field] = rawText;
    }
    if (Object.keys(nextOverride).length) output[id] = nextOverride;
  }
  return output;
}

function sanitizeLayout(value, strict) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) validationError("presentation layout must be a bounded array");
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const id = item && item.id;
    const layout = item && item.layout;
    if (typeof id !== "string" || !LAYOUT_IDS.has(id) || seen.has(id) || (layout !== "full" && layout !== "half")) {
      if (strict) validationError("presentation layout contains an invalid item");
      continue;
    }
    seen.add(id);
    output.push({ id, layout });
  }
  return output;
}

function sanitizeDeletedIds(value, strict) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) validationError("deleted presentation blocks must be a bounded array");
  const seen = new Set();
  const output = [];
  for (const id of value) {
    if (typeof id !== "string" || !LAYOUT_IDS.has(id) || seen.has(id)) {
      if (strict) validationError("deleted presentation blocks contain an invalid id");
      continue;
    }
    seen.add(id);
    output.push(id);
  }
  return output;
}

function knownChartFields(chart) {
  const fields = new Set();
  const addField = (field) => {
    if (typeof field === "string" && field) fields.add(field);
  };
  addField(chart && chart.xField);
  for (const series of Array.isArray(chart && chart.series) ? chart.series : []) {
    addField(series && series.field);
  }
  const encodings = isPlainObject(chart && chart.encodings) ? chart.encodings : {};
  for (const role of ["x", "y", "color", "lineStyle", "size", "facet", "label"]) {
    const encoding = isPlainObject(encodings[role]) ? encodings[role] : {};
    addField(encoding.field);
    for (const field of Array.isArray(encoding.fields) ? encoding.fields : []) addField(field);
  }
  for (const tooltip of Array.isArray(encodings.tooltip) ? encodings.tooltip : []) {
    addField(tooltip && tooltip.field);
  }
  return fields;
}

function sanitizeChartSpecOverrides(value, strict) {
  if (value == null) return {};
  if (!isPlainObject(value)) validationError("chart spec overrides must be an object");
  const output = {};
  const allowedFields = new Set(["type", "xField", "series", "encodings", "settings"]);
  for (const [chartId, rawOverride] of Object.entries(value)) {
    const chart = CHARTS_BY_ID.get(chartId);
    if (!chart) {
      if (strict) validationError("chart spec override references an unknown chart");
      continue;
    }
    if (!isPlainObject(rawOverride)) {
      if (strict) validationError("chart spec override must be an object");
      continue;
    }
    if (strict) {
      for (const field of Object.keys(rawOverride)) {
        if (!allowedFields.has(field)) validationError("chart spec override contains an unsupported field");
      }
    }
    const chartFields = knownChartFields(chart);
    const nextOverride = {};
    if (rawOverride.type != null) {
      if (typeof rawOverride.type === "string" && PRESENTATION_CHART_TYPES.has(rawOverride.type)) {
        nextOverride.type = rawOverride.type;
      } else if (strict) {
        validationError("chart spec override contains an invalid chart type");
      }
    }
    if (rawOverride.xField != null) {
      if (typeof rawOverride.xField === "string" && chartFields.has(rawOverride.xField)) {
        nextOverride.xField = rawOverride.xField;
      } else if (strict) {
        validationError("chart spec override contains an invalid x field");
      }
    }
    if (rawOverride.series != null) {
      if (!Array.isArray(rawOverride.series) || rawOverride.series.length > 50) {
        if (strict) validationError("chart spec override series must be a bounded array");
      } else {
        const series = [];
        for (const rawSeries of rawOverride.series) {
          if (!isPlainObject(rawSeries) || typeof rawSeries.field !== "string" || !chartFields.has(rawSeries.field)) {
            if (strict) validationError("chart spec override contains an invalid series field");
            continue;
          }
          const nextSeries = { field: rawSeries.field };
          if (rawSeries.label != null) {
            if (typeof rawSeries.label === "string" && rawSeries.label.length <= 500) nextSeries.label = rawSeries.label;
            else if (strict) validationError("chart spec override contains an invalid series label");
          }
          if (rawSeries.color != null) {
            if (typeof rawSeries.color === "string" && PRESENTATION_SERIES_COLORS.has(rawSeries.color)) nextSeries.color = rawSeries.color;
            else if (strict) validationError("chart spec override contains an invalid series color");
          }
          if (rawSeries.lineStyle != null) {
            if (typeof rawSeries.lineStyle === "string" && PRESENTATION_SERIES_LINE_STYLES.has(rawSeries.lineStyle)) nextSeries.lineStyle = rawSeries.lineStyle;
            else if (strict) validationError("chart spec override contains an invalid series line style");
          }
          for (const roleField of ["role", "semanticRole"]) {
            if (rawSeries[roleField] == null) continue;
            if (typeof rawSeries[roleField] === "string" && PRESENTATION_SERIES_ROLES.has(rawSeries[roleField])) {
              nextSeries[roleField] = rawSeries[roleField];
            } else if (strict) {
              validationError("chart spec override contains an invalid series role");
            }
          }
          series.push(nextSeries);
        }
        if (series.length) nextOverride.series = series;
      }
    }
    if (rawOverride.encodings != null) {
      if (!isPlainObject(rawOverride.encodings)) {
        if (strict) validationError("chart spec override encodings must be an object");
      } else {
        const size = rawOverride.encodings.size;
        if (size != null) {
          if (isPlainObject(size) && typeof size.field === "string" && chartFields.has(size.field)) {
            nextOverride.encodings = { size: { field: size.field } };
          } else if (strict) {
            validationError("chart spec override contains an invalid size field");
          }
        }
      }
    }
    if (rawOverride.settings != null) {
      if (!isPlainObject(rawOverride.settings)) {
        if (strict) validationError("chart spec override settings must be an object");
      } else {
        const settings = {};
        if (rawOverride.settings.orientation === "horizontal" || rawOverride.settings.orientation === "vertical") {
          settings.orientation = rawOverride.settings.orientation;
        } else if (rawOverride.settings.orientation != null && strict) {
          validationError("chart spec override contains an invalid orientation");
        }
        if (["grouped", "stacked", "stacked100"].includes(rawOverride.settings.groupMode)) {
          settings.groupMode = rawOverride.settings.groupMode;
        } else if (rawOverride.settings.groupMode != null && strict) {
          validationError("chart spec override contains an invalid group mode");
        }
        if (Object.keys(settings).length) nextOverride.settings = settings;
      }
    }
    if (Object.keys(nextOverride).length) output[chartId] = nextOverride;
  }
  return output;
}

function sanitizePresentationOverrides(value, strict = true) {
  if (!isPlainObject(value)) validationError("presentation overrides must be an object");
  const allowedFields = new Set([
    "pageTitle",
    "chartSpecOverrides",
    "chartTextOverrides",
    "tableTextOverrides",
    "blockTextOverrides",
    "dashboardLayout",
    "reportLayout",
    "deletedReportBlockIds",
  ]);
  if (strict) {
    for (const field of Object.keys(value)) {
      if (!allowedFields.has(field)) validationError("presentation overrides contain an unsupported field");
    }
  }
  const output = {};
  if (typeof value.pageTitle === "string" && value.pageTitle.length <= 500) output.pageTitle = value.pageTitle;
  else if (value.pageTitle != null && strict) validationError("presentation title is invalid or too large");
  const chartTextOverrides = sanitizeTextMap(value.chartTextOverrides, CHART_IDS, ["headerMarkdown"], strict);
  const chartSpecOverrides = sanitizeChartSpecOverrides(value.chartSpecOverrides, strict);
  const tableTextOverrides = sanitizeTextMap(value.tableTextOverrides, TABLE_IDS, ["headerMarkdown"], strict);
  const blockTextOverrides = sanitizeTextMap(value.blockTextOverrides, BLOCK_TEXT_IDS, ["bodyMarkdown"], strict);
  const dashboardLayout = sanitizeLayout(value.dashboardLayout, strict);
  const reportLayout = sanitizeLayout(value.reportLayout, strict);
  const deletedReportBlockIds = sanitizeDeletedIds(value.deletedReportBlockIds, strict);
  if (Object.keys(chartSpecOverrides).length) output.chartSpecOverrides = chartSpecOverrides;
  if (Object.keys(chartTextOverrides).length) output.chartTextOverrides = chartTextOverrides;
  if (Object.keys(tableTextOverrides).length) output.tableTextOverrides = tableTextOverrides;
  if (Object.keys(blockTextOverrides).length) output.blockTextOverrides = blockTextOverrides;
  if (dashboardLayout.length) output.dashboardLayout = dashboardLayout;
  if (reportLayout.length) output.reportLayout = reportLayout;
  if (deletedReportBlockIds.length) output.deletedReportBlockIds = deletedReportBlockIds;
  return output;
}

function storedOverrides(row) {
  if (!row || typeof row.overrides_json !== "string") return {};
  try {
    return sanitizePresentationOverrides(JSON.parse(row.overrides_json), false);
  } catch {
    return {};
  }
}

async function ensurePresentationTable(db) {
  if (!db || typeof db.prepare !== "function") throw new Error("Sites database binding is unavailable");
  await db.prepare(PRESENTATION_SCHEMA_SQL).run();
}

async function presentationRow(db) {
  return db.prepare("SELECT revision, overrides_json FROM data_analytics_presentation_v1 WHERE key = ?")
    .bind(PRESENTATION_KEY)
    .first();
}

async function initializePresentation(db) {
  await db.prepare("INSERT OR IGNORE INTO data_analytics_presentation_v1 (key, revision, overrides_json) VALUES (?, 0, '{}')")
    .bind(PRESENTATION_KEY)
    .run();
  return presentationRow(db);
}

function presentationPayload(row, canEdit) {
  return {
    artifactId: ARTIFACT_ID,
    revision: Number.isInteger(row && row.revision) ? row.revision : Number(row && row.revision) || 0,
    overrides: storedOverrides(row),
    canEdit: Boolean(canEdit),
  };
}

async function getPresentation(request, env) {
  const canEdit = await canEditPresentation(request);
  try {
    await ensurePresentationTable(env && env.DB);
    const row = await initializePresentation(env.DB);
    return jsonResponse(presentationPayload(row, canEdit));
  } catch {
    return jsonResponse(presentationPayload(null, false));
  }
}

async function putPresentation(request, env) {
  const email = normalizedEmail(request);
  if (!email) return jsonResponse({ error: "Sign in to edit this Site." }, { status: 401 });
  if (!await canEditPresentation(request)) {
    return jsonResponse({ error: "Only the Site creator can edit this presentation." }, { status: 403 });
  }
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: "Could not read presentation changes." }, { status: 400 });
  }
  if (rawBody.length > MAX_PRESENTATION_BYTES) return jsonResponse({ error: "Presentation changes are too large." }, { status: 413 });
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return jsonResponse({ error: "Presentation changes must be valid JSON." }, { status: 400 });
  }
  if (!isPlainObject(body) || body.artifactId !== ARTIFACT_ID || !Number.isInteger(body.revision) || body.revision < 0) {
    return jsonResponse({ error: "This Site changed. Reload before saving." }, { status: 409 });
  }
  let overrides;
  try {
    overrides = sanitizePresentationOverrides(body.overrides);
  } catch (error) {
    return jsonResponse({ error: error.message }, { status: error.status || 400 });
  }
  try {
    await ensurePresentationTable(env && env.DB);
    const row = await initializePresentation(env.DB);
    const currentRevision = Number(row.revision) || 0;
    if (currentRevision !== body.revision) {
      return jsonResponse({ ...presentationPayload(row, true), error: "This Site changed. Reload before saving." }, { status: 409 });
    }
    const nextRevision = currentRevision + 1;
    const result = await env.DB.prepare("UPDATE data_analytics_presentation_v1 SET revision = ?, overrides_json = ? WHERE key = ? AND revision = ?")
      .bind(nextRevision, JSON.stringify(overrides), PRESENTATION_KEY, currentRevision)
      .run();
    if (!result || !result.meta || Number(result.meta.changes) !== 1) {
      const latestRow = await presentationRow(env.DB);
      return jsonResponse({ ...presentationPayload(latestRow, true), error: "This Site changed. Reload before saving." }, { status: 409 });
    }
    const savedRow = await presentationRow(env.DB);
    return jsonResponse(presentationPayload(savedRow, true));
  } catch {
    return jsonResponse({ error: "Presentation editing is temporarily unavailable." }, { status: 503 });
  }
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function textResponse(body, init = {}) {
  return new Response(String(body == null ? "" : body), {
    status: init.status || 200,
    headers: {
      "content-type": init.contentType || "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function sourceTextFor(url) {
  const key =
    url.searchParams.get("path") ||
    url.searchParams.get("id") ||
    url.searchParams.get("source") ||
    url.searchParams.get("sourceId") ||
    "";
  return SOURCE_TEXT.get(key) || null;
}

const SOURCING_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>CPO Direct Sourcing</title>
  <style>
    :root {
      --ink:#172033; --muted:#657087; --line:#dce2ec; --soft:#f4f6fa; --paper:#fff;
      --navy:#172a4d; --blue:#225eea; --blue-soft:#edf3ff; --green:#13795b;
      --green-soft:#eaf8f2; --amber:#a45c00; --amber-soft:#fff5df; --red:#b42318;
      --red-soft:#fff0ee; --shadow:0 16px 48px rgba(27,39,67,.10);
    }
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;background:#eef1f6;color:var(--ink);font-family:Inter,Pretendard,"Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    button,input,textarea,select{font:inherit}
    button,a{touch-action:manipulation}
    a{color:inherit}
    .topbar{position:sticky;top:0;z-index:30;height:72px;padding:0 28px;background:rgba(255,255,255,.94);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
    .brand{display:flex;align-items:center;gap:12px;text-decoration:none}
    .brand-mark{width:38px;height:38px;border-radius:12px;background:var(--navy);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:900}
    .brand strong{display:block;font-size:16px}.brand span{display:block;margin-top:3px;color:var(--muted);font-size:11px}
    .top-actions{display:flex;align-items:center;gap:8px}
    .btn{border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);padding:10px 13px;font-weight:750;cursor:pointer;text-decoration:none;white-space:nowrap}
    .btn:hover{border-color:#aeb9cb;background:#f9fafc}.btn:disabled{opacity:.55;cursor:not-allowed}
    .btn.primary{border-color:var(--blue);background:var(--blue);color:#fff;box-shadow:0 8px 20px rgba(34,94,234,.22)}
    .btn.danger{color:var(--red);border-color:#f1b7b1}
    .layout{width:min(1540px,calc(100% - 32px));margin:22px auto 56px;display:grid;grid-template-columns:360px minmax(0,1fr);gap:22px;align-items:start}
    .panel{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
    .sidebar{position:sticky;top:94px;padding:22px}
    .eyebrow{font-size:11px;letter-spacing:.12em;font-weight:900;color:var(--blue);text-transform:uppercase}
    h1,h2,h3,p{margin-top:0}
    .sidebar h1{margin:8px 0 7px;font-size:26px}.muted{color:var(--muted)}
    .runtime{margin:17px 0;padding:13px;border-radius:12px;background:var(--blue-soft);border:1px solid #cad9ff;font-size:12px;line-height:1.55}
    .status-row{display:flex;align-items:center;gap:8px;margin-top:8px;font-weight:800}
    .dot{width:8px;height:8px;border-radius:50%;background:#98a2b3}.dot.ok{background:#1aa57a}.dot.warn{background:#f0a020}.dot.bad{background:#d92d20}
    .field{margin-top:14px}.field label{display:block;margin-bottom:7px;font-size:12px;font-weight:850}
    .field input,.field textarea,.field select{width:100%;border:1px solid #cbd3df;border-radius:10px;background:#fff;color:var(--ink);padding:11px 12px;outline:none}
    .field textarea{min-height:92px;resize:vertical;line-height:1.45}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(34,94,234,.12)}
    .cta-stack{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:18px}
    .legal-note{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;line-height:1.55;color:var(--muted)}
    .content{display:grid;gap:18px;min-width:0}
    .hero{padding:28px;background:linear-gradient(135deg,#172a4d 0%,#24487e 55%,#225eea 135%);color:#fff;overflow:hidden;position:relative}
    .hero:after{content:"";position:absolute;width:340px;height:340px;border-radius:50%;right:-140px;top:-180px;border:1px solid rgba(255,255,255,.18)}
    .hero h2{margin:10px 0 9px;font-size:36px;line-height:1.12}.hero p{max-width:750px;color:#dce7ff;line-height:1.65}
    .flow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:22px}.flow span{padding:10px 8px;border:1px solid rgba(255,255,255,.20);border-radius:10px;background:rgba(255,255,255,.08);font-size:11px;text-align:center}.flow b{display:block;margin-bottom:4px;color:#9fc1ff}
    .parity{padding:18px 20px}.parity summary{cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:space-between;font-weight:900;list-style:none}.parity summary::-webkit-details-marker{display:none}
    .parity-count{font-size:11px;border-radius:999px;padding:7px 10px;background:var(--soft);color:var(--muted)}
    .parity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}
    .parity-item{display:grid;grid-template-columns:58px 1fr auto;gap:8px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;font-size:11px}.parity-item b{font-size:10px;color:var(--muted)}
    .state{border-radius:999px;padding:5px 7px;font-size:9px;font-weight:900;white-space:nowrap}.state.same,.state.expanded{background:var(--green-soft);color:var(--green)}.state.partial,.state.ready,.state.separated{background:var(--amber-soft);color:var(--amber)}.state.missing{background:var(--red-soft);color:var(--red)}
    .search-output{padding:22px}.search-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.search-head h2{margin:4px 0 5px;font-size:20px}
    .ephemeral{display:inline-flex;padding:6px 9px;border-radius:999px;background:var(--amber-soft);color:var(--amber);font-size:10px;font-weight:900}
    .search-message{margin-top:15px;padding:14px;border-radius:12px;background:var(--soft);white-space:pre-wrap;line-height:1.65;font-size:13px;max-height:430px;overflow:auto}
    .sources{display:grid;gap:7px;margin-top:14px}.source{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border:1px solid var(--line);border-radius:9px;text-decoration:none;font-size:11px}.source:hover{background:#f8faff}
    .suggestions{margin-top:12px;overflow:auto}.suggestions iframe{display:block;width:100%;height:170px;border:1px solid var(--line);border-radius:10px;background:#fff}.fallback{display:inline-block;margin-top:12px;color:var(--blue);font-weight:850;font-size:12px}
    .pool{padding:22px}.pool-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.pool-head h2{margin:4px 0 5px}
    .pills{display:flex;gap:6px;flex-wrap:wrap}.pill{display:inline-flex;border-radius:999px;padding:6px 8px;background:var(--soft);color:var(--muted);font-size:10px;font-weight:800}.pill.blue{background:var(--blue-soft);color:var(--blue)}.pill.green{background:var(--green-soft);color:var(--green)}.pill.amber{background:var(--amber-soft);color:var(--amber)}
    .cards{display:grid;gap:10px;margin-top:17px}.candidate{position:relative;display:grid;grid-template-columns:68px minmax(0,1fr);gap:14px;padding:16px;border:1px solid var(--line);border-radius:14px;background:#fff}.rank{position:absolute;top:10px;right:12px;color:#9aa4b5;font-size:10px;font-weight:900}
    .score{width:64px;height:64px;border-radius:18px;background:var(--navy);color:#fff;display:grid;place-items:center;text-align:center}.score strong{display:block;font-size:22px}.score span{font-size:8px;color:#bcd0f8}
    .candidate h3{margin:2px 0 5px;font-size:17px}.role{font-size:12px;color:var(--muted)}.summary{margin:9px 0 8px;font-size:12px;line-height:1.55}
    .tags{display:flex;gap:5px;flex-wrap:wrap}.tag{padding:5px 7px;border-radius:7px;background:var(--soft);font-size:9px;font-weight:800}.tag.strong{background:var(--blue-soft);color:var(--blue)}
    .card-foot{grid-column:2;display:flex;justify-content:space-between;align-items:center;gap:8px}.profile{font-size:11px;color:var(--blue);font-weight:900;text-decoration:none}
    .pool-actions{display:flex;justify-content:center;gap:8px;margin-top:16px;flex-wrap:wrap}
    .manual{margin-top:16px;border-top:1px solid var(--line);padding-top:16px}.manual summary{cursor:pointer;font-size:12px;font-weight:900}.manual-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}.manual-grid .field{margin:0}.manual-grid .full{grid-column:1/-1}.check{display:flex;align-items:flex-start;gap:8px;font-size:11px;color:var(--muted);line-height:1.45}
    dialog{width:min(620px,calc(100% - 28px));border:0;border-radius:18px;padding:0;box-shadow:0 28px 90px rgba(9,18,37,.30)}dialog::backdrop{background:rgba(13,23,42,.55);backdrop-filter:blur(4px)}
    .dialog-head{display:flex;justify-content:space-between;align-items:center;padding:20px 22px;border-bottom:1px solid var(--line)}.dialog-body{padding:22px}.dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:16px 22px;border-top:1px solid var(--line)}
    .security-box{padding:13px;border-radius:12px;background:var(--green-soft);color:#145c49;font-size:11px;line-height:1.55}.key-meta{margin-top:12px;padding:11px;border:1px solid var(--line);border-radius:10px;font-size:12px}
    .toast{position:fixed;right:22px;bottom:22px;z-index:60;max-width:380px;padding:12px 15px;border-radius:11px;background:#172033;color:#fff;box-shadow:var(--shadow);font-size:12px;opacity:0;transform:translateY(10px);pointer-events:none;transition:.2s}.toast.show{opacity:1;transform:none}
    .hidden{display:none!important}
    @media(max-width:980px){.layout{grid-template-columns:1fr}.sidebar{position:static}.flow{grid-template-columns:repeat(3,1fr)}.parity-grid{grid-template-columns:1fr}}
    @media(max-width:640px){.topbar{height:auto;min-height:68px;padding:11px 14px}.brand>span:not(.brand-mark){display:none}.brand-mark{display:grid}.top-actions{gap:4px}.top-actions .btn{padding:8px 9px;font-size:11px}.top-actions .label{display:none}.layout{width:min(100% - 18px,1540px);margin-top:10px}.hero,.sidebar,.pool,.search-output{padding:18px}.hero h2{font-size:28px}.flow{grid-template-columns:repeat(2,1fr)}.manual-grid{grid-template-columns:1fr}.manual-grid .full{grid-column:auto}.candidate{grid-template-columns:58px minmax(0,1fr);padding:13px}.score{width:54px;height:54px;border-radius:15px}.card-foot{grid-column:1/-1}.parity-item{grid-template-columns:52px 1fr}}
  </style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/"><span class="brand-mark">AI</span><span><strong>CPO Direct Sourcing</strong><span>Reference workflow · button-triggered search</span></span></a>
    <div class="top-actions">
      <a class="btn" href="/workflow"><span class="label">기준·워크플로우</span> ↗</a>
      <button class="btn" id="mask-toggle" type="button">공유 가림</button>
      <button class="btn" id="settings-open" type="button">설정</button>
    </div>
  </header>

  <main class="layout">
    <aside class="panel sidebar">
      <div class="eyebrow">Step 1 · Input</div>
      <h1>검색 조건</h1>
      <p class="muted">프리셋과 자유입력이 실제 CTA 요청에 함께 들어갑니다.</p>
      <div class="runtime">
        <strong>실행 방식</strong><br>
        예약 실행 없음 · 버튼을 누를 때만 Gemini + Google Search Grounding 1회 호출
        <div class="status-row"><span class="dot" id="api-dot"></span><span id="api-status">BYOK 상태 확인 중</span></div>
      </div>
      <div class="field"><label for="preset">반복 채용 프리셋</label><select id="preset"><option value="cpo">CPO · 테스트 베드</option><option value="custom">자유 입력</option></select></div>
      <div class="field"><label for="job">직무</label><input id="job" value="CPO (Chief Privacy Officer)" maxlength="120"></div>
      <div class="field"><label for="location">지역</label><input id="location" value="대한민국 · 서울/수도권" maxlength="120"></div>
      <div class="field"><label for="required">필수 조건</label><textarea id="required" maxlength="1200">정보보호·개인정보보호 경력 10년 이상
팀장급 이상 조직 리딩
AWS 등 클라우드 운영 또는 보안 거버넌스
ISMS 인증·심사 대응</textarea></div>
      <div class="field"><label for="preferred">우대 조건</label><textarea id="preferred" maxlength="1200">CPO/CISO 또는 이에 준하는 역할
플랫폼·IT·SaaS·콘텐츠 기업
AWS Security, CISSP, CISM, CISA, CCSP</textarea></div>
      <div class="field"><label for="additional">자유 입력</label><textarea id="additional" maxlength="800" placeholder="예: 글로벌 데이터 이전 또는 Privacy by Design 경험을 우선 탐색"></textarea></div>
      <div class="cta-stack">
        <button class="btn primary" id="search-button" type="button">Gemini로 후보 찾기</button>
        <button class="btn" id="fallback-button" type="button" title="Google X-ray 검색 열기">Google ↗</button>
      </div>
      <div class="legal-note">
        연령·출생연도·졸업연도는 입력·검색·추론·점수·정렬에 사용하지 않습니다. 요청된 연령 cutoff는 정책 레지스트리에 LEGAL_HOLD_INACTIVE로만 보존됩니다. 실제 후보의 비공개·민감정보를 무료 API에 보내지 않습니다.
      </div>
    </aside>

    <section class="content">
      <section class="panel hero">
        <div class="eyebrow" style="color:#9fc1ff">Step 2–6 · Search → Review → Merge</div>
        <h2>AI는 찾고,<br>사람은 원문을 검증합니다.</h2>
        <p>CTA가 공개 웹 근거를 일회성으로 보여줍니다. 사용자가 원문을 직접 확인한 후보만 후보 풀에 추가되고, URL 중복 제거 후 전체 점수로 다시 정렬됩니다.</p>
        <div class="flow"><span><b>1</b>프리셋·입력</span><span><b>2</b>CTA 검색</span><span><b>3</b>근거·출처</span><span><b>4</b>사람 검증</span><span><b>5</b>후보 추가</span><span><b>6</b>전체 재정렬</span></div>
      </section>

      <details class="panel parity" open>
        <summary><span>REFERENCE PARITY · 지속 검증판</span><span class="parity-count" id="parity-count">상태 계산 중</span></summary>
        <div class="parity-grid" id="parity-grid"></div>
      </details>

      <section class="panel search-output" id="search-output">
        <div class="search-head">
          <div><div class="eyebrow">Live search result</div><h2 id="search-title">CTA 검색 대기</h2><p class="muted" id="search-subtitle">검색 버튼을 누르면 이 영역에 동일 사용자를 위한 일회성 Grounded Result가 표시됩니다.</p></div>
          <span class="ephemeral">저장 안 함 · EPHEMERAL</span>
        </div>
        <div class="search-message" id="search-message">BYOK 설정에서 Gemini API 키를 저장하면 CLI 없이 이 사이트에서 바로 호출됩니다.</div>
        <div class="sources" id="search-sources"></div>
        <div class="suggestions" id="search-suggestions"></div>
        <a class="fallback hidden" id="fallback-link" target="_blank" rel="noopener noreferrer">Google X-ray 검색으로 열기 ↗</a>
      </section>

      <section class="panel pool">
        <div class="pool-head">
          <div><div class="eyebrow">Verified candidate pool</div><h2 id="pool-title">검증 snapshot 후보 8명</h2><p class="muted" id="pool-subtitle">2026-08-06 공개 웹 snapshot · 고득점순 · 모든 hard gate는 VERIFY</p></div>
          <div class="pills"><span class="pill green">사람 검토 필수</span><span class="pill amber">합격확률 아님</span><span class="pill blue" id="manual-count">수동 추가 0</span></div>
        </div>
        <div class="cards" id="candidate-grid"></div>
        <div class="pool-actions">
          <button class="btn primary" id="more-button" type="button">후보 더 찾기</button>
          <button class="btn" id="reset-button" type="button">수동 추가 초기화</button>
        </div>
        <details class="manual" id="manual-add">
          <summary>원문을 직접 검증한 후보를 풀에 추가</summary>
          <div class="manual-grid">
            <div class="field"><label for="candidate-name">이름</label><input id="candidate-name" maxlength="100"></div>
            <div class="field"><label for="candidate-company">회사·소속</label><input id="candidate-company" maxlength="160"></div>
            <div class="field full"><label for="candidate-title">역할</label><input id="candidate-title" maxlength="180"></div>
            <div class="field full"><label for="candidate-url">직접 확인한 공개 원문 URL</label><input id="candidate-url" type="url" placeholder="https://" maxlength="600"></div>
            <div class="field full"><label for="candidate-evidence">원문에서 확인한 직무 관련 근거</label><textarea id="candidate-evidence" maxlength="1200"></textarea></div>
            <div class="field"><label for="candidate-score">우선검토점수 0–100</label><input id="candidate-score" type="number" min="0" max="100" value="50"></div>
            <div class="field"><label for="candidate-coverage">Coverage</label><select id="candidate-coverage"><option>Low</option><option selected>Medium</option><option>High</option></select></div>
            <label class="check full"><input id="candidate-reviewed" type="checkbox"> <span>Gemini 결과 문구를 복사한 것이 아니라 공개 원문을 직접 열어 확인했고, 직무 관련 정보만 입력했습니다.</span></label>
            <div class="full"><button class="btn primary" id="candidate-add" type="button">중복 제거 후 전체 풀에 추가</button></div>
          </div>
        </details>
      </section>
    </section>
  </main>

  <dialog id="settings-dialog">
    <div class="dialog-head"><div><div class="eyebrow">Settings · BYOK</div><h2 style="margin:5px 0 0">Gemini API 키</h2></div><button class="btn" id="settings-close" type="button">닫기</button></div>
    <div class="dialog-body">
      <div class="security-box"><strong>서버 암호화 저장</strong><br>입력한 키는 TLS로 서버에 전달되고 AES-256-GCM으로 암호화되어 D1에는 암호문만 저장됩니다. 복호화 마스터 키는 Sites 비밀 환경변수에 분리되어 있습니다. 원문 키는 응답·로그·Git·브라우저 저장소에 남지 않습니다.</div>
      <div class="key-meta" id="key-meta">저장 상태 확인 중</div>
      <div class="field"><label for="gemini-key">새 Gemini API 키</label><input id="gemini-key" type="password" autocomplete="off" spellcheck="false" placeholder="AQ.Ab8… 또는 AIza…" maxlength="512"></div>
      <p class="muted" style="font-size:11px;line-height:1.55">Google AI Studio의 신규 <code>AQ.…</code> Authorization Key와 제한된 기존 <code>AIza…</code> Standard Key를 모두 지원합니다. 모델은 <code>Gemini 3.5 Flash-Lite</code>를 먼저 호출하고, 모델 404 또는 무료 티어 Grounding 제한이 있으면 <code>Gemini 2.5 Flash-Lite</code>로 한 번 전환합니다. 실제 Grounded Result는 일회성으로만 표시하며 키는 저장 후 다시 화면에 표시되지 않습니다.</p>
      <div id="settings-message" class="search-message hidden"></div>
    </div>
    <div class="dialog-foot">
      <button class="btn danger" id="key-delete" type="button">저장 키 삭제</button>
      <button class="btn" id="key-test" type="button">연결 테스트</button>
      <button class="btn primary" id="key-save" type="button">암호화 저장</button>
    </div>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    (function(){
      "use strict";
      var snapshotCandidates = [
        {id:"s1",name:"최광희",company:"공개 소개문상 골프존 · 소속 재확인",title:"CISO/CPO · 정보보호·개인정보 전문가",location:"대한민국",score:86,coverage:"High",summary:"25년+ 경력, CISO/CPO, ISMS-P·ISO 27001/27701·CSAP와 규제·점검·사고분석 신호.",tags:["CISO/CPO","25년+","ISMS-P","ISO 27701"],verify:"현재 소속·AWS·조직권한 확인",url:"https://kr.linkedin.com/in/%EA%B4%91%ED%9D%AC-%EC%B5%9C-599a9a56",manual:false},
        {id:"s2",name:"신현민 (Frank Shin)",company:"교촌에프앤비",title:"정보보호센터장 · CIO/CISO/CPO",location:"성남",score:84,coverage:"Medium",summary:"복수 최고책임자와 센터장 역할, ISMS-P 선임심사원·ISO 27001·CISSP 공개 신호.",tags:["CIO/CISO/CPO","조직 리딩","ISMS-P","CISSP"],verify:"AWS·개인정보 프로그램 범위 확인",url:"https://kr.linkedin.com/in/frankshin",manual:false},
        {id:"s3",name:"김재귀",company:"Lotte Hotels and Resorts",title:"전문임원 CISO/CPO · 정보보호부문장",location:"대한민국",score:83,coverage:"Medium",summary:"임원·부문장·팀장 리딩과 ISMS-P 선임심사, ISO 27001/27701, APEC CBPR 신호.",tags:["임원 CISO/CPO","부문장","ISMS-P","ISO 27701"],verify:"AWS·사고/규제 대응 범위 확인",url:"https://kr.linkedin.com/in/%EC%9E%AC%EA%B7%80-%EA%B9%80-566511139",manual:false},
        {id:"s4",name:"장세인",company:"토스증권",title:"CISO/CPO",location:"대한민국 · 서울",score:82,coverage:"Medium",summary:"핀테크 CISO/CPO로 기술·관리 방어체계와 조직 리딩의 공개 신호.",tags:["CISO/CPO","Fintech","조직 리딩","규제 산업"],verify:"ISMS cycle·AWS·이사회 보고 확인",url:"https://kr.linkedin.com/in/%EC%84%B8%EC%9D%B8-%EC%9E%A5-82525a77",manual:false},
        {id:"s5",name:"Minjoo Kim",company:"Hyperconnect / Match Group",title:"CISO · Security Director",location:"대한민국 · 서울",score:80,coverage:"Medium",summary:"글로벌 대규모 플랫폼, CISO/security director, 팀 리딩, compliance와 AWS 공개 활동.",tags:["CISO","Security Director","Global platform","AWS"],verify:"CPO/privacy·ISMS 총괄 확인",url:"https://kr.linkedin.com/in/rootnix",manual:false},
        {id:"s6",name:"김동현",company:"전 우아한형제들 · 현재 역할 확인 필요",title:"전 임원 CISO/CPO · 정보보호실 리더",location:"대한민국",score:79,coverage:"High",summary:"22년+ 보안, 임원 CISO/CPO, 개인정보 조직 리딩, ISMS/PIMS·플랫폼 경험 신호.",tags:["전 CISO/CPO","22년+","Platform","ISMS/PIMS"],verify:"현재 역할·AWS 확인",url:"https://kr.linkedin.com/in/dhyun-kim",manual:false},
        {id:"s7",name:"yoonsang shin",company:"무신사",title:"Cloud Native & Security Architect · 전 CISO/CPO",location:"대한민국 · 서울",score:75,coverage:"Medium",summary:"20년차 cloud-native 보안·플랫폼 리더, 전 CISO/CPO와 ISMS-P 심사 경험.",tags:["20년","전 CISO/CPO","Cloud Native","ISMS-P"],verify:"AWS 깊이·privacy 운영 확인",url:"https://kr.linkedin.com/in/yoonsang-shin-859b8b1a2",manual:false},
        {id:"s8",name:"Young-ik Oh",company:"보맵 / BOMAPP",title:"CISO · ISMS-P 인증심사원",location:"서울·인천",score:69,coverage:"Medium",summary:"핀테크 CISO, ISMS-P 인증심사원, CISSP와 인프라 기반 공개 신호.",tags:["CISO","Fintech","ISMS-P","CISSP"],verify:"10년+·people leadership·AWS 확인",url:"https://kr.linkedin.com/in/%EC%98%81%EC%9D%B5-%EC%98%A4-5925775b/en",manual:false}
      ];
      var candidates = snapshotCandidates.slice();
      var masked = false;
      var busy = false;
      var successfulSearch = false;
      var fallbackUrl = "";
      var parity = [
        {id:"RP-01",label:"메인 과업 우선순위",state:"same"},
        {id:"RP-02",label:"프리셋·자유입력 실제 결합",state:"same"},
        {id:"RP-03",label:"온디맨드 사이트 검색 CTA",state:"ready"},
        {id:"RP-04",label:"후보 카드·점수순 정렬",state:"same"},
        {id:"RP-05",label:"추가 검색 merge·전체 재정렬",state:"separated"},
        {id:"RP-06",label:"공유용 식별정보 마스킹",state:"same"},
        {id:"RP-07",label:"검색 최신성·출처 투명성",state:"partial"},
        {id:"RP-08",label:"AI 우선순위 + 사람 판단",state:"expanded"},
        {id:"RP-09",label:"메인 범위의 단순성",state:"same"},
        {id:"RP-10",label:"CLI 없는 self-contained 흐름",state:"partial"}
      ];
      var stateLabels = {same:"같음",expanded:"확장됨",partial:"부분",ready:"연결 대기",separated:"제약 분리",missing:"누락"};
      function byId(id){return document.getElementById(id)}
      function esc(value){return String(value == null ? "" : value).replace(/[&<>"']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]})}
      function toast(message){var el=byId("toast");el.textContent=message;el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(function(){el.classList.remove("show")},2400)}
      function setBusy(value){busy=value;byId("search-button").disabled=value;byId("more-button").disabled=value;byId("search-button").textContent=value?"검색 중…":"Gemini로 후보 찾기";byId("more-button").textContent=value?"검색 중…":"후보 더 찾기"}
      function setApiStatus(kind,text){byId("api-dot").className="dot "+kind;byId("api-status").textContent=text}
      function setParity(id,state){for(var i=0;i<parity.length;i++){if(parity[i].id===id)parity[i].state=state}renderParity()}
      function renderParity(){
        var grid=byId("parity-grid");grid.innerHTML="";
        var pass=0, separated=0, pending=0;
        parity.forEach(function(item){
          if(item.state==="same"||item.state==="expanded")pass++; else if(item.state==="separated")separated++; else pending++;
          var row=document.createElement("div");row.className="parity-item";
          row.innerHTML="<b>"+esc(item.id)+"</b><span>"+esc(item.label)+"</span><span class='state "+esc(item.state)+"'>"+esc(stateLabels[item.state])+"</span>";
          grid.appendChild(row);
        });
        byId("parity-count").textContent=pass+" 통과 · "+separated+" 제약분리 · "+pending+" 확인대기";
      }
      function canonicalUrl(value){try{var u=new URL(value);if(u.protocol!=="https:")return "";u.hash="";["utm_source","utm_medium","utm_campaign","trk"].forEach(function(k){u.searchParams.delete(k)});return u.toString().replace(/\/$/,"").toLowerCase()}catch(e){return ""}}
      function safeHttpUrl(value){try{var u=new URL(value);return u.protocol==="https:"?u.toString():""}catch(e){return ""}}
      function renderGoogleSuggestions(markup){
        var frame=document.createElement("iframe");
        frame.setAttribute("sandbox","allow-popups allow-popups-to-escape-sandbox");
        frame.setAttribute("referrerpolicy","no-referrer");
        frame.setAttribute("title","Google Search Suggestions");
        var remote=String(markup||"").replace(/<base\b[^>]*>/gi,"").replace(/<meta\b[^>]*http-equiv\s*=\s*[\"']?refresh[\s\S]*?>/gi,"");
        var csp="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src https: data:; navigate-to 'none'\">";
        byId("search-suggestions").replaceChildren(frame);
        frame.srcdoc="<!doctype html><html><head><meta charset=\"utf-8\">"+csp+"</head><body>"+remote+"</body></html>";
      }
      function renderCandidates(){
        var sorted=candidates.slice().sort(function(a,b){return b.score-a.score});
        var grid=byId("candidate-grid");grid.innerHTML="";
        sorted.forEach(function(item,index){
          var card=document.createElement("article");card.className="candidate";
          var name=masked?"후보 "+String(index+1).padStart(2,"0"):item.name;
          var role=masked?"회사·역할·지역 가림":item.title+" · "+item.company+" · "+item.location;
          var tags=(item.tags||[]).map(function(tag,i){return "<span class='tag "+(i<2?"strong":"")+"'>"+esc(tag)+"</span>"}).join("");
          var link=masked?"<span class='pill'>프로필 가림</span>":"<a class='profile' href='"+esc(item.url)+"' target='_blank' rel='noopener noreferrer'>공개 원문 ↗</a>";
          card.innerHTML="<span class='rank'>#"+(index+1)+"</span><div class='score'><div><strong>"+esc(item.score)+"</strong><span>우선검토</span></div></div><div><h3>"+esc(name)+"</h3><div class='role'>"+esc(role)+"</div><p class='summary'>"+esc(item.summary)+"</p><div class='tags'>"+tags+"</div></div><div class='card-foot'><div class='pills'><span class='pill blue'>Coverage "+esc(item.coverage)+"</span><span class='pill amber'>VERIFY · "+esc(item.verify)+"</span>"+(item.manual?"<span class='pill green'>원문 확인 수동추가</span>":"")+"</div>"+link+"</div>";
          grid.appendChild(card);
        });
        var manual=candidates.filter(function(x){return x.manual}).length;
        byId("manual-count").textContent="수동 추가 "+manual;
        byId("pool-title").textContent="검증 후보 "+candidates.length+"명";
        byId("pool-subtitle").textContent=manual?"수동 검증 후보를 URL 중복 제거 후 병합하고 전체 재정렬했습니다.":"2026-08-06 공개 웹 snapshot · 고득점순 · 모든 hard gate는 VERIFY";
      }
      function formPayload(mode){
        return {mode:mode||"initial",preset:byId("preset").value,job:byId("job").value,location:byId("location").value,required:byId("required").value,preferred:byId("preferred").value,additional:byId("additional").value};
      }
      function showSearchResult(data){
        byId("search-sources").innerHTML="";byId("search-suggestions").innerHTML="";
        fallbackUrl=data.fallbackUrl||fallbackUrl||"";byId("fallback-link").href=fallbackUrl;byId("fallback-link").classList.toggle("hidden",!fallbackUrl);
        if(data.status==="ok"){
          successfulSearch=true;setParity("RP-03","same");setParity("RP-07","same");setParity("RP-10","same");
          byId("search-title").textContent="Grounded Result · 지금 검색 완료";
          byId("search-subtitle").textContent="실행 모델 · "+(data.model||"확인 불가")+(data.fallbackUsed?" · 2순위 fallback":"")+" · 이 응답은 후보 DB에 저장되지 않습니다.";
          byId("search-message").textContent=data.text||"검색 결과 본문이 없습니다.";
          var queries=data.groundingMetadata&&data.groundingMetadata.webSearchQueries||[];
          queries.forEach(function(query){var row=document.createElement("div");row.className="source";row.textContent="실행 검색어 · "+query;byId("search-sources").appendChild(row)});
          var chunks=data.groundingMetadata&&data.groundingMetadata.groundingChunks||[];
          chunks.forEach(function(chunk,index){
            if(!chunk.web||!chunk.web.uri)return;
            var href=safeHttpUrl(chunk.web.uri);if(!href)return;
            var a=document.createElement("a");a.className="source";a.target="_blank";a.rel="noopener noreferrer";a.href=href;
            a.textContent=(index+1)+". "+(chunk.web.title||chunk.web.uri);byId("search-sources").appendChild(a);
          });
          var rendered=data.groundingMetadata&&data.groundingMetadata.searchEntryPoint&&data.groundingMetadata.searchEntryPoint.renderedContent;
          if(rendered)renderGoogleSuggestions(rendered);
          toast("사이트에서 Google Grounded Search를 실행했습니다.");
        }else{
          byId("search-title").textContent=data.status==="setup_required"?"BYOK 키 설정 필요":"검색 결과 확인 필요";
          byId("search-subtitle").textContent="서버 응답 상태: "+(data.status||"error");
          byId("search-message").textContent=data.message||"검색을 완료하지 못했습니다.";
          if(data.status==="setup_required"){setApiStatus("warn","BYOK 키 미설정");byId("settings-dialog").showModal()}
        }
      }
      async function runSearch(mode){
        if(busy)return;setBusy(true);
        byId("search-title").textContent=mode==="more"?"다른 검색 cluster 탐색 중":"Google Grounded Search 실행 중";
        byId("search-message").textContent="버튼 요청 1회가 실행되고 있습니다. 후보명·기존 풀은 API 입력으로 보내지 않습니다.";
        try{
          var response=await fetch("/api/search",{method:"POST",headers:{"content-type":"application/json","x-cpo-search":"1"},body:JSON.stringify(formPayload(mode))});
          var data=await response.json();showSearchResult(data);
        }catch(error){showSearchResult({status:"network_error",message:"네트워크 요청을 완료하지 못했습니다. 잠시 후 다시 시도하거나 Google X-ray fallback을 사용하세요.",fallbackUrl:fallbackUrl})}
        finally{setBusy(false)}
      }
      async function loadKeyStatus(){
        try{
          var response=await fetch("/api/settings/gemini",{headers:{"x-cpo-settings":"1"}});
          var data=await response.json();
          if(data.configured){setApiStatus("ok","BYOK 저장됨 · "+data.masked);byId("key-meta").textContent="암호화 저장됨 · "+data.masked+" · 갱신 "+(data.updatedAt||"확인 불가");setParity("RP-03",successfulSearch?"same":"ready")}
          else{setApiStatus("warn","BYOK 키 미설정");byId("key-meta").textContent="저장된 Gemini API 키가 없습니다.";setParity("RP-03","ready")}
          byId("key-delete").disabled=!data.configured;byId("key-test").disabled=!data.configured;
        }catch(error){setApiStatus("bad","BYOK 상태 확인 실패");byId("key-meta").textContent="설정 상태를 확인하지 못했습니다."}
      }
      function settingsMessage(message,bad){var el=byId("settings-message");el.classList.remove("hidden");el.textContent=message;el.style.background=bad?"var(--red-soft)":"var(--green-soft)"}
      async function saveKey(){
        var key=byId("gemini-key").value.trim();if(!key){settingsMessage("새 API 키를 입력하세요.",true);return}
        byId("key-save").disabled=true;
        try{
          var response=await fetch("/api/settings/gemini",{method:"PUT",headers:{"content-type":"application/json","x-cpo-settings":"1"},body:JSON.stringify({apiKey:key})});
          var data=await response.json();
          if(!response.ok)throw new Error(data.message||"저장 실패");
          byId("gemini-key").value="";settingsMessage("키를 AES-256-GCM으로 암호화해 저장했습니다. 이제 연결 테스트를 실행하세요.",false);toast("BYOK 키를 암호화 저장했습니다.");await loadKeyStatus();
        }catch(error){settingsMessage(error.message||"키 저장에 실패했습니다.",true)}
        finally{byId("key-save").disabled=false}
      }
      async function testKey(){
        byId("key-test").disabled=true;settingsMessage("저장된 키로 Gemini 연결을 테스트하고 있습니다.",false);
        try{
          var response=await fetch("/api/settings/gemini/test",{method:"POST",headers:{"content-type":"application/json","x-cpo-settings":"1"},body:"{}"});
          var data=await response.json();if(!response.ok)throw new Error(data.message||"연결 실패");
          settingsMessage("연결 성공 · "+data.model+(data.fallbackUsed?" · 2순위 fallback":"")+" · "+data.latencyMs+"ms",false);setApiStatus("ok","BYOK 연결 테스트 성공");toast("Gemini API 연결을 확인했습니다.");
        }catch(error){settingsMessage(error.message||"연결 테스트에 실패했습니다.",true)}
        finally{await loadKeyStatus()}
      }
      async function deleteKey(){
        if(!confirm("저장된 Gemini API 키 암호문을 삭제할까요?"))return;
        try{
          var response=await fetch("/api/settings/gemini",{method:"DELETE",headers:{"x-cpo-settings":"1"}});
          var data=await response.json();if(!response.ok)throw new Error(data.message||"삭제 실패");
          settingsMessage("저장된 키를 삭제했습니다.",false);toast("BYOK 키를 삭제했습니다.");await loadKeyStatus();
        }catch(error){settingsMessage(error.message||"키 삭제에 실패했습니다.",true)}
      }
      function addCandidate(){
        var name=byId("candidate-name").value.trim(),company=byId("candidate-company").value.trim(),title=byId("candidate-title").value.trim(),url=canonicalUrl(byId("candidate-url").value),evidence=byId("candidate-evidence").value.trim();
        var score=Math.max(0,Math.min(100,Number(byId("candidate-score").value)||0));
        if(!name||!company||!title||!url||!evidence){toast("이름·회사·역할·원문 URL·근거를 모두 입력하세요.");return}
        if(!byId("candidate-reviewed").checked){toast("공개 원문 직접 확인 체크가 필요합니다.");return}
        var existing=candidates.find(function(item){return canonicalUrl(item.url)===url});
        var item={id:existing?existing.id:"m"+Date.now(),name:name,company:company,title:title,location:"원문 확인",score:score,coverage:byId("candidate-coverage").value,summary:evidence,tags:["원문 확인","수동 추가"],verify:"구조화 검증·독립 리뷰",url:url,manual:true};
        if(existing){candidates=candidates.map(function(x){return x.id===existing.id?item:x});toast("같은 URL의 후보를 갱신하고 전체 재정렬했습니다.")}
        else{candidates.push(item);toast("검증 후보를 병합하고 전체 재정렬했습니다.")}
        ["candidate-name","candidate-company","candidate-title","candidate-url","candidate-evidence"].forEach(function(id){byId(id).value=""});byId("candidate-reviewed").checked=false;
        setParity("RP-05","expanded");renderCandidates();
      }
      function openFallback(){var query=["site:linkedin.com/in",byId("job").value,byId("location").value,byId("required").value].join(" ");window.open("https://www.google.com/search?q="+encodeURIComponent(query),"_blank","noopener")}
      byId("search-button").addEventListener("click",function(){runSearch("initial")});
      byId("more-button").addEventListener("click",function(){runSearch("more")});
      byId("fallback-button").addEventListener("click",openFallback);
      byId("mask-toggle").addEventListener("click",function(){masked=!masked;this.textContent=masked?"가림 해제":"공유 가림";renderCandidates();toast(masked?"이름·회사·지역·링크를 가렸습니다.":"내부 검토 보기를 복원했습니다.")});
      byId("reset-button").addEventListener("click",function(){candidates=snapshotCandidates.slice();renderCandidates();setParity("RP-05","separated");toast("수동 추가 후보를 초기화했습니다.")});
      byId("candidate-add").addEventListener("click",addCandidate);
      byId("settings-open").addEventListener("click",function(){byId("settings-dialog").showModal();loadKeyStatus()});
      byId("settings-close").addEventListener("click",function(){byId("settings-dialog").close()});
      byId("key-save").addEventListener("click",saveKey);
      byId("key-test").addEventListener("click",testKey);
      byId("key-delete").addEventListener("click",deleteKey);
      byId("preset").addEventListener("change",function(){
        if(this.value==="cpo"){byId("job").value="CPO (Chief Privacy Officer)";byId("location").value="대한민국 · 서울/수도권"}
        else{byId("job").value="";byId("location").value="";byId("required").value="";byId("preferred").value="";byId("additional").focus()}
      });
      renderParity();renderCandidates();loadKeyStatus();
      if(new URLSearchParams(window.location.search).get("settings")==="1")byId("settings-dialog").showModal();
    })();
  </script>
</body>
</html>`;

const BYOK_SECRET_ID = "gemini_api_key";
const BYOK_AAD = new TextEncoder().encode("direct-xray-searching:gemini:v1");
const BLOCKED_SEARCH_PATTERN = /(년생|년대생|생년|출생|나이|연령|졸업\s*연도|입학\s*연도|첫\s*직장\s*연도|birth\s*year|date\s*of\s*birth|\bage\b|graduation\s*year)/i;
const GEMINI_MODEL_PRIORITY = Object.freeze(["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"]);
const GEMINI_API_VERSION_PRIORITY = Object.freeze(["v1", "v1beta"]);

async function ownerActionAllowed(request, env, headerName, requireOrigin) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (requireOrigin ? origin !== url.origin : Boolean(origin) && origin !== url.origin) return false;
  if (request.headers.get(headerName) !== "1") return false;
  const email = normalizedEmail(request);
  const expectedHash = String(env.CPO_OWNER_EMAIL_HASH || EDITOR_EMAIL_HASH || "").toLowerCase();
  if (!email || !expectedHash) return false;
  try { return await sha256Hex(email) === expectedHash; } catch (_) { return false; }
}

function compactText(value, limit) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || "")) throw new Error("BYOK master key is not configured.");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importByokKey(env) {
  return crypto.subtle.importKey("raw", hexToBytes(env.BYOK_MASTER_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptByokSecret(plaintext, env) {
  const key = await importByokKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: BYOK_AAD }, key, encoded);
  return { cipherB64: bytesToBase64(cipher), ivB64: bytesToBase64(iv) };
}

async function decryptByokSecret(row, env) {
  const key = await importByokKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(row.iv_b64), additionalData: BYOK_AAD },
    key,
    base64ToBytes(row.cipher_b64),
  );
  return new TextDecoder().decode(plain);
}

async function ensureByokTable(env) {
  if (!env.DB) throw new Error("D1 storage is unavailable.");
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cpo_byok_secrets_v1 (secret_id TEXT PRIMARY KEY, cipher_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, last4 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cpo_gemini_usage_v1 (usage_day TEXT PRIMARY KEY, request_count INTEGER NOT NULL, updated_at TEXT NOT NULL)",
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cpo_gemini_lock_v1 (lock_id TEXT PRIMARY KEY, lease_until TEXT NOT NULL, updated_at TEXT NOT NULL)",
  ).run();
}

async function readByokRow(env) {
  await ensureByokTable(env);
  return env.DB.prepare(
    "SELECT secret_id, cipher_b64, iv_b64, last4, created_at, updated_at FROM cpo_byok_secrets_v1 WHERE secret_id = ?",
  ).bind(BYOK_SECRET_ID).first();
}

async function storedGeminiKey(env) {
  const row = await readByokRow(env);
  return row ? decryptByokSecret(row, env) : null;
}

async function reserveDailyGeminiSearch(env, limit = 450) {
  await ensureByokTable(env);
  const now = new Date().toISOString();
  // Gemini RPD quotas reset at midnight Pacific Time, including DST changes.
  const quotaParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const quotaPart = (type) => quotaParts.find((part) => part.type === type)?.value || "00";
  const day = quotaPart("year") + "-" + quotaPart("month") + "-" + quotaPart("day");
  await env.DB.prepare(
    "INSERT INTO cpo_gemini_usage_v1 (usage_day, request_count, updated_at) VALUES (?, 0, ?) ON CONFLICT(usage_day) DO NOTHING",
  ).bind(day, now).run();
  const result = await env.DB.prepare(
    "UPDATE cpo_gemini_usage_v1 SET request_count = request_count + 1, updated_at = ? WHERE usage_day = ? AND request_count < ?",
  ).bind(now, day, limit).run();
  return Number(result && result.meta && result.meta.changes || result && result.changes || 0) === 1;
}

async function acquireGeminiSearchLock(env) {
  await ensureByokTable(env);
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 45000).toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO cpo_gemini_lock_v1 (lock_id, lease_until, updated_at) VALUES ('search', ?, ?) ON CONFLICT(lock_id) DO UPDATE SET lease_until = excluded.lease_until, updated_at = excluded.updated_at WHERE cpo_gemini_lock_v1.lease_until < ?",
  ).bind(leaseUntil, nowIso, nowIso).run();
  return Number(result && result.meta && result.meta.changes || result && result.changes || 0) === 1;
}

async function releaseGeminiSearchLock(env, cooldownMs = 8000) {
  const now = new Date();
  const nextAllowed = new Date(now.getTime() + cooldownMs).toISOString();
  await env.DB.prepare(
    "UPDATE cpo_gemini_lock_v1 SET lease_until = ?, updated_at = ? WHERE lock_id = 'search'",
  ).bind(nextAllowed, now.toISOString()).run();
}

function validateGeminiKey(value) {
  const key = String(value || "").trim();
  // Google does not publish a stable prefix/length contract. Accept both the
  // current AQ.* auth keys and restricted legacy AIza* keys, while allowing
  // only printable ASCII so the value is always safe in an HTTP header.
  if (!/^[\x21-\x7E]{20,512}$/.test(key)) return null;
  return key;
}

async function handleGeminiSettings(request, env) {
  const requireOrigin = request.method !== "GET";
  if (!await ownerActionAllowed(request, env, "x-cpo-settings", requireOrigin)) {
    return jsonResponse({ status: "forbidden", message: "Same-origin settings request required." }, { status: 403 });
  }
  try {
    if (request.method === "GET") {
      const row = await readByokRow(env);
      return jsonResponse({
        status: "ok",
        configured: Boolean(row),
        masked: row ? "••••" + row.last4 : null,
        updatedAt: row ? row.updated_at : null,
      });
    }
    if (request.method === "PUT") {
      const raw = await request.text();
      if (raw.length > 1024) return jsonResponse({ status: "payload_too_large", message: "API 키 요청이 너무 큽니다." }, { status: 413 });
      let body;
      try { body = JSON.parse(raw); } catch (_) { return jsonResponse({ status: "invalid_json", message: "API 키 요청을 읽지 못했습니다." }, { status: 400 }); }
      const apiKey = validateGeminiKey(body && body.apiKey);
      if (!apiKey) return jsonResponse({ status: "invalid_key", message: "Google AI Studio에서 복사한 전체 AQ.… 또는 AIza… 키를 입력하세요." }, { status: 400 });
      await ensureByokTable(env);
      const encrypted = await encryptByokSecret(apiKey, env);
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO cpo_byok_secrets_v1 (secret_id, cipher_b64, iv_b64, last4, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(secret_id) DO UPDATE SET cipher_b64 = excluded.cipher_b64, iv_b64 = excluded.iv_b64, last4 = excluded.last4, updated_at = excluded.updated_at",
      ).bind(BYOK_SECRET_ID, encrypted.cipherB64, encrypted.ivB64, apiKey.slice(-4), now, now).run();
      return jsonResponse({ status: "saved", configured: true, masked: "••••" + apiKey.slice(-4), updatedAt: now });
    }
    if (request.method === "DELETE") {
      await ensureByokTable(env);
      await env.DB.prepare("DELETE FROM cpo_byok_secrets_v1 WHERE secret_id = ?").bind(BYOK_SECRET_ID).run();
      return jsonResponse({ status: "deleted", configured: false });
    }
    return jsonResponse({ status: "method_not_allowed" }, { status: 405, headers: { allow: "GET, PUT, DELETE" } });
  } catch (error) {
    return jsonResponse({ status: "settings_error", message: "암호화 키 저장소를 처리하지 못했습니다." }, { status: 500 });
  }
}

async function discoverGeminiModels(apiKey) {
  const started = Date.now();
  for (const apiVersion of GEMINI_API_VERSION_PRIORITY) {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/" + apiVersion + "/models?pageSize=1000", {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        redirect: "error",
        cache: "no-store",
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(10000) : undefined,
      });
      let payload = null;
      try { payload = await response.json(); } catch (_) {}
      const available = new Set();
      if (response.ok && payload && Array.isArray(payload.models)) {
        for (const item of payload.models) {
          const methods = Array.isArray(item && item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
          if (!methods.some((method) => String(method).toLowerCase() === "generatecontent")) continue;
          const names = [item && item.name, item && item.baseModelId];
          for (const value of names) {
            const model = String(value || "").replace(/^models\//, "");
            if (/^[A-Za-z0-9._-]+$/.test(model)) available.add(model);
          }
        }
      }
      if (response.status !== 404 || apiVersion === GEMINI_API_VERSION_PRIORITY[GEMINI_API_VERSION_PRIORITY.length - 1]) {
        return { response, payload, available, apiVersion, elapsed: Date.now() - started };
      }
    } catch (_) {
      if (apiVersion === GEMINI_API_VERSION_PRIORITY[GEMINI_API_VERSION_PRIORITY.length - 1]) {
        return { response: null, payload: null, available: null, apiVersion: null, elapsed: Date.now() - started };
      }
    }
  }
  return { response: null, payload: null, available: null, apiVersion: null, elapsed: Date.now() - started };
}

async function callGeminiModel(apiKey, model, apiVersion, prompt, useSearch) {
  if (!GEMINI_MODEL_PRIORITY.includes(model)) throw new Error("Unsupported Gemini model.");
  if (!GEMINI_API_VERSION_PRIORITY.includes(apiVersion)) throw new Error("Unsupported Gemini API version.");
  const endpoint = "https://generativelanguage.googleapis.com/" + apiVersion + "/models/" + model + ":generateContent";
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (useSearch) body.tools = [{ google_search: {} }];
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
  });
  const elapsed = Date.now() - started;
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  return { response, payload, elapsed, model, apiVersion };
}

function geminiFallbackAllowed(result, useSearch) {
  const status = result && result.response && result.response.status;
  if (status === 404) return true;
  if (!useSearch) return false;
  const error = result && result.payload && result.payload.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  const reason = details.map((item) => item && item.reason).filter(Boolean).join(" ");
  const diagnosticText = [error.code, error.status, reason, compactText(error.message, 1200)].filter(Boolean).join(" ").toLowerCase();
  if (/(api_key_invalid|api_key_service_blocked|service_disabled|authentication|unauthenticated)/.test(diagnosticText)) return false;
  if (status === 429) return true;
  return [400, 403, 501].includes(status) && /(google[_ ]?search|grounding|tool|model[_ ]?not[_ ]?found|not supported|unsupported|unimplemented)/.test(diagnosticText);
}

async function callGemini(apiKey, prompt, useSearch) {
  const catalog = await discoverGeminiModels(apiKey);
  if (catalog.response && catalog.response.status === 401) {
    return { response: catalog.response, payload: catalog.payload, elapsed: catalog.elapsed, model: null, attempts: [], catalogStatus: 401 };
  }
  let models = GEMINI_MODEL_PRIORITY.slice();
  if (catalog.response && catalog.response.ok && catalog.available) {
    models = models.filter((model) => catalog.available.has(model));
    if (!models.length) {
      const payload = { error: { code: 404, status: "NOT_FOUND" } };
      return {
        response: new Response(JSON.stringify(payload), { status: 404, headers: { "content-type": "application/json" } }),
        payload,
        elapsed: catalog.elapsed,
        model: null,
        attempts: GEMINI_MODEL_PRIORITY.map((model) => ({ model, status: "NOT_LISTED" })),
        catalogStatus: 200,
      };
    }
  }
  const attempts = [];
  let lastResult = null;
  for (let index = 0; index < models.length; index += 1) {
    for (const apiVersion of GEMINI_API_VERSION_PRIORITY) {
      const result = await callGeminiModel(apiKey, models[index], apiVersion, prompt, useSearch);
      attempts.push({ model: result.model, apiVersion: result.apiVersion, status: result.response.status });
      lastResult = { ...result, attempts: attempts.slice(), catalogStatus: catalog.response ? catalog.response.status : null };
      if (result.response.ok) return lastResult;
      if (result.response.status !== 404) break;
    }
    if (!geminiFallbackAllowed(lastResult, useSearch)) break;
  }
  return lastResult;
}

function safeGeminiError(result) {
  const error = result && result.payload && result.payload.error || {};
  const upstreamStatus = /^[A-Z0-9_]{2,80}$/.test(String(error.status || "")) ? String(error.status) : null;
  const details = Array.isArray(error.details) ? error.details : [];
  const foundReason = details.map((item) => item && item.reason).find((value) => /^[A-Z0-9_]{2,100}$/.test(String(value || "")));
  const code = typeof error.code === "number" || /^[A-Za-z0-9_]{2,80}$/.test(String(error.code || "")) ? error.code : null;
  return { upstreamStatus, reason: foundReason ? String(foundReason) : null, code };
}

function geminiAttemptSummary(result) {
  const attempts = Array.isArray(result && result.attempts) ? result.attempts : [];
  return attempts.map((item) => item.model + (item.apiVersion ? "@" + item.apiVersion : "") + "(" + item.status + ")").join(" → ");
}

async function handleGeminiKeyTest(request, env) {
  if (request.method !== "POST") return jsonResponse({ status: "method_not_allowed" }, { status: 405 });
  if (!await ownerActionAllowed(request, env, "x-cpo-settings", true)) return jsonResponse({ status: "forbidden" }, { status: 403 });
  try {
    const apiKey = await storedGeminiKey(env);
    if (!apiKey) return jsonResponse({ status: "setup_required", message: "저장된 Gemini API 키가 없습니다." }, { status: 409 });
    const result = await callGemini(apiKey, "Respond with the exact ASCII text OK and nothing else.", false);
    if (!result.response.ok) {
      const status = result.response.status;
      const safeError = safeGeminiError(result);
      const attemptSummary = geminiAttemptSummary(result);
      const baseMessage = status === 401
        ? "HTTP 401: 키가 인증되지 않았습니다. Google AI Studio에서 발급한 전체 AQ.… 또는 AIza… 키인지 확인하세요."
        : status === 403
          ? "HTTP 403: Gemini API 권한 또는 프로젝트 설정을 확인하세요."
          : status === 429
            ? "HTTP 429: 무료 티어가 0으로 설정됐거나 프로젝트 호출 한도를 초과했습니다."
            : status === 404
              ? "HTTP 404: 이 키의 프로젝트에서 우선순위 모델을 찾지 못했습니다. " + attemptSummary
              : "HTTP " + status + ": Gemini 연결 테스트에 실패했습니다. " + attemptSummary;
      const diagnostic = [safeError.upstreamStatus, safeError.reason, safeError.code].filter((value) => value != null).join("/");
      const message = baseMessage + (diagnostic ? " · Google " + diagnostic : "");
      return jsonResponse({ status: "test_failed", message, httpStatus: status, errorCode: safeError.code, upstreamStatus: safeError.upstreamStatus, reason: safeError.reason, attemptedModels: result.attempts || [] }, { status: status === 429 ? 429 : 502 });
    }
    return jsonResponse({ status: "ok", model: result.model, fallbackUsed: result.model !== GEMINI_MODEL_PRIORITY[0], attemptedModels: result.attempts, latencyMs: result.elapsed });
  } catch (error) {
    return jsonResponse({ status: "test_error", message: "저장 키를 복호화하거나 Gemini에 연결하지 못했습니다." }, { status: 500 });
  }
}

function xrayQueryFor(input) {
  const role = compactText(input.job, 120) || "CPO Chief Privacy Officer";
  const location = compactText(input.location, 120);
  const required = compactText(input.required, 500);
  return ["site:linkedin.com/in", '"' + role + '"', location, required].filter(Boolean).join(" ");
}

function sourcingPrompt(input) {
  const mode = input.mode === "more" ? "Explore a different title and industry cluster from the first search." : "Run the initial broad search.";
  return [
    "You assist a human recruiter with public-web research for a CPO role.",
    "Use Google Search now and return a concise Korean Grounded Result for up to eight relevant professionals.",
    "Prioritize public professional profiles, conference speaker bios, corporate leadership pages, and official publications.",
    "Search intent: " + xrayQueryFor(input),
    "Required evidence: " + compactText(input.required, 1200),
    "Preferred evidence: " + compactText(input.preferred, 1200),
    "Additional user direction: " + compactText(input.additional, 800),
    mode,
    "For each person, state the public current or recent role and exact job-related evidence. Preserve source citations.",
    "Do not infer or mention age, birth year, graduation year, gender, family status, health, religion, ethnicity, or other protected traits.",
    "Do not make a hiring decision, reject anyone, calculate a score, or claim that a person is qualified.",
  ].join("\n");
}

function browserSafeGroundingMetadata(value) {
  const metadata = value && typeof value === "object" ? value : {};
  const queries = Array.isArray(metadata.webSearchQueries)
    ? metadata.webSearchQueries.slice(0, 20).map((query) => compactText(query, 300)).filter(Boolean)
    : [];
  const chunks = [];
  for (const chunk of Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks.slice(0, 30) : []) {
    try {
      const uri = new URL(chunk && chunk.web && chunk.web.uri || "");
      if (uri.protocol !== "https:") continue;
      chunks.push({ web: { uri: uri.toString(), title: compactText(chunk.web.title || uri.hostname, 300) } });
    } catch (_) {}
  }
  const renderedContent = compactText(metadata.searchEntryPoint && metadata.searchEntryPoint.renderedContent, 200000);
  return {
    webSearchQueries: queries,
    groundingChunks: chunks,
    searchEntryPoint: renderedContent ? { renderedContent } : null,
  };
}

async function handleGeminiSearch(request, env) {
  if (request.method !== "POST") return jsonResponse({ status: "method_not_allowed" }, { status: 405 });
  if (!await ownerActionAllowed(request, env, "x-cpo-search", true)) return jsonResponse({ status: "forbidden" }, { status: 403 });
  let input;
  try {
    const raw = await request.text();
    if (raw.length > 10000) return jsonResponse({ status: "payload_too_large", message: "검색 조건이 너무 큽니다." }, { status: 413 });
    input = JSON.parse(raw);
  } catch (_) { return jsonResponse({ status: "invalid_json", message: "검색 조건을 읽지 못했습니다." }, { status: 400 }); }
  const searchable = [input.job, input.location, input.required, input.preferred, input.additional].join(" ");
  if (BLOCKED_SEARCH_PATTERN.test(searchable)) {
    return jsonResponse({ status: "blocked_attribute", message: "연령·출생·졸업연도 관련 표현은 검색 요청에 사용할 수 없습니다." }, { status: 400 });
  }
  const fallbackUrl = "https://www.google.com/search?q=" + encodeURIComponent(xrayQueryFor(input));
  let apiKey;
  try { apiKey = await storedGeminiKey(env); } catch (_) {
    return jsonResponse({ status: "storage_error", message: "BYOK 암호화 저장소를 사용할 수 없습니다.", fallbackUrl }, { status: 500 });
  }
  if (!apiKey) {
    return jsonResponse({ status: "setup_required", message: "설정에서 Gemini API 키를 암호화 저장하세요. Google X-ray fallback은 바로 사용할 수 있습니다.", fallbackUrl }, { status: 409 });
  }
  let lockAcquired = false;
  try {
    lockAcquired = await acquireGeminiSearchLock(env);
    if (!lockAcquired) return jsonResponse({ status: "search_busy", message: "검색이 진행 중이거나 8초 cooldown 중입니다.", fallbackUrl }, { status: 409 });
    if (!await reserveDailyGeminiSearch(env, 450)) {
      await releaseGeminiSearchLock(env, 0);
      lockAcquired = false;
      return jsonResponse({ status: "daily_limit", message: "사이트 내부 일일 안전 한도 450회를 모두 사용했습니다.", fallbackUrl }, { status: 429 });
    }
    const result = await callGemini(apiKey, sourcingPrompt(input), true);
    if (!result.response.ok) {
      const status = result.response.status;
      const safeError = safeGeminiError(result);
      const attemptSummary = geminiAttemptSummary(result);
      const baseMessage = status === 401
        ? "Gemini가 저장된 키를 인증하지 못했습니다. 설정에서 AQ.… 또는 AIza… 키를 다시 저장하고 연결 테스트를 실행하세요."
        : status === 403
          ? "Gemini Search Grounding 권한 또는 프로젝트 설정을 확인하세요. " + attemptSummary
          : status === 429
            ? "Gemini 무료 티어가 0으로 설정됐거나 프로젝트 호출 한도를 초과했습니다. " + attemptSummary
            : status === 404
              ? "우선순위 모델을 찾지 못했습니다. " + attemptSummary
              : "Gemini Search 호출을 완료하지 못했습니다. (HTTP " + status + ") " + attemptSummary;
      const diagnostic = [safeError.upstreamStatus, safeError.reason, safeError.code].filter((value) => value != null).join("/");
      const message = baseMessage + (diagnostic ? " · Google " + diagnostic : "");
      return jsonResponse({ status: "api_error", message, httpStatus: status, errorCode: safeError.code, upstreamStatus: safeError.upstreamStatus, reason: safeError.reason, attemptedModels: result.attempts || [], fallbackUrl }, { status: status === 429 ? 429 : 502 });
    }
    const candidate = result.payload && result.payload.candidates && result.payload.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts || [];
    const text = parts.map((part) => part.text || "").join("\n").trim();
    const groundingMetadata = candidate && candidate.groundingMetadata || null;
    if (!groundingMetadata) {
      return jsonResponse({ status: "no_grounding", message: "응답에 groundingMetadata가 없어 근거 검색 결과로 표시하지 않습니다.", fallbackUrl }, { status: 422 });
    }
    return jsonResponse({
      status: "ok",
      mode: "grounded_ephemeral",
      model: result.model,
      fallbackUsed: result.model !== GEMINI_MODEL_PRIORITY[0],
      attemptedModels: result.attempts,
      text: text.slice(0, 50000),
      groundingMetadata: browserSafeGroundingMetadata(groundingMetadata),
      persistAllowed: false,
      latencyMs: result.elapsed,
      fallbackUrl,
    });
  } catch (error) {
    return jsonResponse({ status: "network_error", message: "Gemini Search 네트워크 호출에 실패했습니다.", fallbackUrl }, { status: 502 });
  } finally {
    if (lockAcquired) {
      try { await releaseGeminiSearchLock(env, 8000); } catch (_) {}
    }
  }
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/api/settings/gemini") return handleGeminiSettings(request, env);
    if (url.pathname === "/api/settings/gemini/test") return handleGeminiKeyTest(request, env);
    if (url.pathname === "/api/search") return handleGeminiSearch(request, env);
    if (url.pathname === "/api/manifest") return jsonResponse(MANIFEST);
    if (url.pathname === "/api/snapshot") return jsonResponse(SNAPSHOT);
    if (url.pathname === "/api/package") return jsonResponse(PACKAGE_INFO);
    if (url.pathname === "/api/presentation") {
      if (request.method === "GET") return getPresentation(request, env);
      if (request.method === "PUT") return putPresentation(request, env);
      return jsonResponse({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET, PUT" } });
    }
    if (url.pathname === "/api/inline-chart-widget") {
      return textResponse(CHART_WIDGET_HTML, { contentType: "text/html; charset=utf-8" });
    }
    if (url.pathname === "/api/source-file" || url.pathname === "/api/source") {
      const text = sourceTextFor(url);
      if (text != null) return textResponse(text);
      return textResponse("Source text was not included in this hosted artifact.", { status: 404 });
    }
    if (url.pathname === "/workflow" || url.pathname === "/plan" || url.pathname === "/report") {
      return textResponse(INDEX_HTML, { contentType: "text/html; charset=utf-8" });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return textResponse(SOURCING_HTML, { contentType: "text/html; charset=utf-8" });
    }
    return textResponse("Not found", { status: 404 });
  },
};
