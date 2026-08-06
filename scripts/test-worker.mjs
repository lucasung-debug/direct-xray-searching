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
const fakeKey = "unit_test_key_not_real_0000000000003456";
const request = (path, init = {}) => new Request(origin + path, init);
const settingsHeaders = { origin, "x-cpo-settings": "1", "oai-authenticated-user-email": testOwnerEmail };
const searchHeaders = { origin, "x-cpo-search": "1", "content-type": "application/json", "oai-authenticated-user-email": testOwnerEmail };

let response = await worker.fetch(request("/"), env);
assert.equal(response.status, 200);
const home = await response.text();
assert.match(home, /Settings · BYOK/);
assert.match(home, /REFERENCE PARITY/);
assert.doesNotMatch(home, new RegExp(fakeKey));
assert.match(home, /sandbox","allow-popups allow-popups-to-escape-sandbox/);
assert.doesNotMatch(home, /sandbox","[^"]*allow-scripts/);

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
globalThis.fetch = async (_url, init) => {
  assert.equal(init.headers["x-goog-api-key"], fakeKey);
  const body = JSON.parse(init.body);
  capturedPrompt = body.contents[0].parts[0].text;
  if (body.tools) {
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "근거가 연결된 일회성 결과" }] },
        groundingMetadata: {
          webSearchQueries: ["CPO public profile"],
          searchEntryPoint: { renderedContent: "<div>Google Search Suggestions</div>" },
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
assert.equal(search.persistAllowed, false);
assert.ok(search.groundingMetadata);
assert.match(capturedPrompt, /Privacy by Design/);
assert.match(capturedPrompt, /Do not infer or mention age/);

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", location: "대한민국", required: "privacy cloud ISMS" }),
}), env);
assert.equal(response.status, 409);
assert.equal((await response.json()).status, "search_busy");

response = await worker.fetch(request("/api/search", {
  method: "POST",
  headers: searchHeaders,
  body: JSON.stringify({ job: "CPO", required: "1980년생 이상" }),
}), env);
assert.equal(response.status, 400);
assert.equal((await response.json()).status, "blocked_attribute");

response = await worker.fetch(request("/api/settings/gemini/test", { method: "POST", headers: { ...settingsHeaders, "content-type": "application/json" }, body: "{}" }), env);
assert.equal(response.status, 200);
assert.equal((await response.json()).status, "ok");

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

console.log("Worker auth, strict Origin, AES-GCM BYOK, sandboxed suggestions, rate lock, search boundary, and Grounding contract passed");
