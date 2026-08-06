import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const { default: worker } = await import("../worker/index.js");

const testOwnerEmail = "owner@example.test";
const testOwnerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(testOwnerEmail));
const testOwnerHash = Array.from(new Uint8Array(testOwnerDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() {
    if (this.sql.startsWith("CREATE TABLE")) return { success: true, meta: { changes: 0 } };
    if (this.sql.startsWith("INSERT INTO cpo_byok_secrets_v1")) {
      const [secret_id, cipher_b64, iv_b64, last4, created_at, updated_at] = this.values;
      const prior = this.db.secret;
      this.db.secret = { secret_id, cipher_b64, iv_b64, last4, created_at: prior?.created_at || created_at, updated_at };
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM cpo_byok_secrets_v1")) { this.db.secret = null; return { success: true, meta: { changes: 1 } }; }
    if (this.sql.startsWith("INSERT INTO cpo_gemini_usage_v1")) {
      const [day, now] = this.values;
      if (!this.db.usage.has(day)) this.db.usage.set(day, { request_count: 0, updated_at: now });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE cpo_gemini_usage_v1")) {
      const [now, day, limit] = this.values;
      const row = this.db.usage.get(day);
      if (!row || row.request_count >= limit) return { success: true, meta: { changes: 0 } };
      row.request_count += 1; row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO cpo_gemini_lock_v1")) {
      const [leaseUntil, updatedAt, nowIso] = this.values;
      if (!this.db.lock || this.db.lock.lease_until < nowIso) {
        this.db.lock = { lease_until: leaseUntil, updated_at: updatedAt };
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.startsWith("UPDATE cpo_gemini_lock_v1")) {
      const [leaseUntil, updatedAt] = this.values;
      this.db.lock = { lease_until: leaseUntil, updated_at: updatedAt };
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error("Unexpected run SQL");
  }
  async first() {
    if (this.sql.startsWith("SELECT secret_id")) return this.db.secret;
    throw new Error("Unexpected first SQL");
  }
}

class MockD1 {
  constructor() { this.secret = null; this.usage = new Map(); this.lock = null; }
  prepare(sql) { return new MockStatement(this, sql); }
}

const DB = new MockD1();
const env = { DB, BYOK_MASTER_KEY: "11".repeat(32), CPO_OWNER_EMAIL_HASH: testOwnerHash };
const origin = "https://cpo.example";
const fakeKey = "AQ.Ab8" + "x".repeat(240) + "3456";
const request = (path, init = {}) => new Request(origin + path, init);
const settingsHeaders = { origin, "x-cpo-settings": "1", "oai-authenticated-user-email": testOwnerEmail };
const searchHeaders = { origin, "x-cpo-search": "1", "content-type": "application/json", "oai-authenticated-user-email": testOwnerEmail };

let response = await worker.fetch(request("/"), env);
assert.equal(response.status, 200);
const home = await response.text();
assert.match(home, /Settings · BYOK/);
assert.match(home, /REFERENCE PARITY/);
assert.doesNotMatch(home, new RegExp(fakeKey));
assert.match(home, /AQ\./);
assert.match(home, /maxlength="512"/);
assert.doesNotMatch(home, /createElement\("iframe"\)|\.srcdoc\s*=/, "Google Search Suggestions must not be framed");
assert.match(home, /safeGoogleSuggestionFragment/);
assert.match(home, /attachShadow/);

response = await worker.fetch(request("/api/settings/gemini", {
  method: "PUT",
  headers: { origin, "x-cpo-settings": "1", "content-type": "application/json" },
  body: JSON.stringify({ apiKey: fakeKey }),
}), env);
assert.equal(response.status, 403, "owner identity header is required");

response = await worker.fetch(request("/api/settings/gemini", {
  method: "PUT",
  headers: { "x-cpo-settings": "1", "oai-authenticated-user-email": testOwnerEmail, "content-type": "application/json" },
  body: JSON.stringify({ apiKey: fakeKey }),
}), env);
assert.equal(response.status, 403, "mutating settings request requires exact Origin");

response = await worker.fetch(request("/api/settings/gemini", { headers: settingsHeaders }), env);
assert.deepEqual(await response.json(), { status: "ok", configured: false, masked: null, updatedAt: null });

response = await worker.fetch(request("/api/settings/gemini", {
  method: "PUT",
  headers: { ...settingsHeaders, "content-type": "application/json" },
  body: JSON.stringify({ apiKey: "AQ.Ab8" + "x".repeat(600) }),
}), env);
assert.equal(response.status, 400, "oversized auth keys are rejected before storage");

response = await worker.fetch(request("/api/settings/gemini", {
  method: "PUT",
  headers: { ...settingsHeaders, "content-type": "application/json" },
  body: JSON.stringify({ apiKey: fakeKey }),
}), env);
assert.equal(response.status, 200);
const saved = await response.json();
assert.equal(saved.configured, true);
assert.equal(saved.masked, "••••3456");
assert.ok(DB.secret.cipher_b64);
assert.ok(DB.secret.iv_b64);
assert.doesNotMatch(JSON.stringify(DB.secret), new RegExp(fakeKey));
const firstCipher = DB.secret.cipher_b64;

response = await worker.fetch(request("/api/settings/gemini", {
  method: "PUT",
  headers: { ...settingsHeaders, "content-type": "application/json" },
  body: JSON.stringify({ apiKey: fakeKey }),
}), env);
assert.equal(response.status, 200);
assert.notEqual(DB.secret.cipher_b64, firstCipher, "AES-GCM must use a fresh IV");

let capturedPrompt = "";
let forceAuthenticationFailure = false;
let forceProjectPermissionFailure = false;
const geminiCalls = [];
globalThis.fetch = async (_url, init) => {
  assert.equal(init.headers["x-goog-api-key"], fakeKey);
  assert.equal(init.headers.authorization, undefined);
  assert.doesNotMatch(String(_url), /[?&]key=/, "BYOK key must never be put in the URL");
  assert.equal(init.method, "POST", "fixed-priority generateContent calls do not require a model catalog request");
  assert.equal(Object.hasOwn(init, "redirect"), false, "Sites runtime must receive the minimal proven fetch initializer");
  assert.equal(Object.hasOwn(init, "cache"), false, "Sites runtime must not receive the compatibility-gated RequestInit.cache field");
  assert.equal(init.headers["cache-control"], undefined);
  assert.equal(init.headers.pragma, undefined);
  const body = JSON.parse(init.body);
  capturedPrompt = body.contents[0].parts[0].text;
  const modelMatch = String(_url).match(/\/(v1(?:beta)?)\/models\/([A-Za-z0-9._-]+):generateContent$/);
  assert.ok(modelMatch, "generateContent URL includes an allowlisted model");
  const apiVersion = modelMatch[1];
  const model = modelMatch[2];
  geminiCalls.push({ model, apiVersion, useSearch: Boolean(body.tools) });
  if (forceAuthenticationFailure) {
    return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", details: [{ reason: "API_KEY_INVALID" }] } }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (forceProjectPermissionFailure) {
    return new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403, headers: { "content-type": "application/json" } });
  }
  if (model === "gemini-3.5-flash-lite") {
    const status = body.tools ? 429 : 404;
    const errorStatus = body.tools ? "RESOURCE_EXHAUSTED" : "NOT_FOUND";
    const reason = body.tools ? "QUOTA_EXCEEDED" : "MODEL_NOT_FOUND";
    const message = body.tools ? "google_search free_tier quota unavailable for model gemini-3.5-flash-lite" : "model not found";
    return new Response(JSON.stringify({ error: { code: status, status: errorStatus, message, details: [{ reason }] } }), { status, headers: { "content-type": "application/json" } });
  }
  assert.equal(model, "gemini-2.5-flash-lite");
  if (body.tools) {
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "근거가 연결된 일회성 결과" }] },
        groundingMetadata: {
          webSearchQueries: ["CPO public profile"],
          searchEntryPoint: {
            renderedContent: "<style>.g{font-weight:700}</style><a class=\"g\" href=\"https://www.google.com/search?q=CPO+public+profile\">CPO public profile</a>",
            sdkBlob: Buffer.from(JSON.stringify([["CPO public profile", "https://www.google.com/search?q=CPO+public+profile"]]), "utf8").toString("base64"),
          },
          groundingChunks: [{ web: { uri: "https://example.com/profile", title: "Public profile" } }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
};

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", location: "대한민국", required: "privacy 10년 cloud ISMS", preferred: "CISO SaaS", additional: "Privacy by Design", mode: "initial" }),
}), env);
assert.equal(response.status, 200);
const search = await response.json();
assert.equal(search.status, "ok");
assert.equal(search.model, "gemini-2.5-flash-lite");
assert.equal(search.fallbackUsed, true);
assert.deepEqual(search.attemptedModels, [
  { model: "gemini-3.5-flash-lite", apiVersion: "v1", status: 429 },
  { model: "gemini-2.5-flash-lite", apiVersion: "v1", status: 200 },
]);
assert.equal(search.persistAllowed, false);
assert.ok(search.groundingMetadata);
assert.deepEqual(search.groundingMetadata.searchEntryPoint.searchSuggestions, [
  { label: "CPO public profile", url: "https://www.google.com/search?q=CPO+public+profile" },
]);
assert.match(search.groundingMetadata.searchEntryPoint.renderedContent, /CPO public profile/);
assert.equal(JSON.stringify(search).includes("sdkBlob"), false, "raw sdkBlob must not be returned to the browser");
assert.match(capturedPrompt, /Privacy by Design/);
assert.match(capturedPrompt, /Do not infer or mention age/);

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", location: "대한민국", required: "privacy cloud ISMS" }),
}), env);
assert.equal(response.status, 409);
assert.equal((await response.json()).status, "search_busy");

DB.lock = null;
forceProjectPermissionFailure = true;
const beforePermissionFailureCalls = geminiCalls.length;
response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", location: "대한민국", required: "privacy cloud ISMS" }),
}), env);
assert.equal(response.status, 502);
const permissionFailure = await response.json();
assert.equal(permissionFailure.httpStatus, 403);
assert.equal(permissionFailure.reason, "SERVICE_DISABLED");
assert.equal(geminiCalls.length, beforePermissionFailureCalls + 1, "project-wide 403 must not try another API version or model");
forceProjectPermissionFailure = false;

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", required: "1980년생 이상" }),
}), env);
assert.equal(response.status, 400);
assert.equal((await response.json()).status, "blocked_attribute");

response = await worker.fetch(request("/api/settings/gemini/test", { method: "POST", headers: { ...settingsHeaders, "content-type": "application/json" }, body: "{}" }), env);
assert.equal(response.status, 200);
const keyTest = await response.json();
assert.equal(keyTest.status, "ok");
assert.equal(keyTest.model, "gemini-2.5-flash-lite");
assert.equal(keyTest.fallbackUsed, true);
assert.deepEqual(keyTest.attemptedModels, [
  { model: "gemini-3.5-flash-lite", apiVersion: "v1", status: 404 },
  { model: "gemini-3.5-flash-lite", apiVersion: "v1beta", status: 404 },
  { model: "gemini-2.5-flash-lite", apiVersion: "v1", status: 200 },
]);

response = await worker.fetch(request("/api/settings/gemini/test", { method: "POST", headers: { ...settingsHeaders, "content-type": "application/json" }, body: "{}" }), { ...env, BYOK_MASTER_KEY: "invalid" });
assert.equal(response.status, 500);
assert.equal((await response.json()).status, "storage_error", "decryption failures must be distinct from Gemini transport failures");

const workingGeminiFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError("Request initializer is unsupported"); };
response = await worker.fetch(request("/api/settings/gemini/test", { method: "POST", headers: { ...settingsHeaders, "content-type": "application/json" }, body: "{}" }), env);
assert.equal(response.status, 502);
assert.equal((await response.json()).status, "network_error", "runtime fetch failures must not be reported as decryption failures");
globalThis.fetch = workingGeminiFetch;

forceAuthenticationFailure = true;
const beforeAuthFailureCalls = geminiCalls.length;
response = await worker.fetch(request("/api/settings/gemini/test", { method: "POST", headers: { ...settingsHeaders, "content-type": "application/json" }, body: "{}" }), env);
assert.equal(response.status, 502);
const authFailure = await response.json();
assert.equal(authFailure.httpStatus, 401);
assert.equal(authFailure.upstreamStatus, "UNAUTHENTICATED");
assert.equal(geminiCalls.length, beforeAuthFailureCalls + 1, "401 must not try the second model");
forceAuthenticationFailure = false;

response = await worker.fetch(request("/api/settings/gemini", { method: "DELETE", headers: settingsHeaders }), env);
assert.equal(response.status, 200);
assert.equal(DB.secret, null);

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", required: "cloud ISMS" }),
}), env);
assert.equal(response.status, 409);
const setup = await response.json();
assert.equal(setup.status, "setup_required");
assert.match(setup.fallbackUrl, /^https:\/\/www\.google\.com\/search\?q=/);

console.log("Worker auth, strict Origin, AES-GCM BYOK, isolated suggestions, rate lock, search boundary, and Grounding contract passed");
