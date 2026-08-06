import http from "node:http";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const { default: worker } = await import("../worker/index.js");

const previewOwnerEmail = "preview@example.test";
const previewOwnerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(previewOwnerEmail));
const previewOwnerHash = Array.from(new Uint8Array(previewOwnerDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");

class PreviewStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() {
    if (this.sql.startsWith("CREATE TABLE")) return { success: true, meta: { changes: 0 } };
    if (this.sql.startsWith("INSERT INTO cpo_byok_secrets_v1")) {
      const [secret_id, cipher_b64, iv_b64, last4, created_at, updated_at] = this.values;
      this.db.secret = { secret_id, cipher_b64, iv_b64, last4, created_at, updated_at };
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM cpo_byok_secrets_v1")) { this.db.secret = null; return { success: true, meta: { changes: 1 } }; }
    if (this.sql.startsWith("INSERT INTO cpo_gemini_usage_v1")) {
      const [day, now] = this.values;
      if (!this.db.usage.has(day)) this.db.usage.set(day, { request_count: 0, updated_at: now });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE cpo_gemini_usage_v1")) {
      const [now, day, limit] = this.values; const row = this.db.usage.get(day);
      if (!row || row.request_count >= limit) return { success: true, meta: { changes: 0 } };
      row.request_count += 1; row.updated_at = now; return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO cpo_gemini_lock_v1")) {
      const [leaseUntil, updatedAt, nowIso] = this.values;
      if (!this.db.lock || this.db.lock.lease_until < nowIso) { this.db.lock = { lease_until: leaseUntil, updated_at: updatedAt }; return { success: true, meta: { changes: 1 } }; }
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.startsWith("UPDATE cpo_gemini_lock_v1")) { const [leaseUntil, updatedAt] = this.values; this.db.lock = { lease_until: leaseUntil, updated_at: updatedAt }; return { success: true, meta: { changes: 1 } }; }
    if (this.sql.startsWith("INSERT INTO data_analytics_presentation_v1")) return { success: true };
    return { success: true };
  }
  async first() {
    if (this.sql.startsWith("SELECT secret_id")) return this.db.secret;
    if (this.sql.includes("data_analytics_presentation_v1")) return null;
    return null;
  }
}

class PreviewD1 {
  constructor() { this.secret = null; this.usage = new Map(); this.lock = null; }
  prepare(sql) { return new PreviewStatement(this, sql); }
}

const env = { DB: new PreviewD1(), BYOK_MASTER_KEY: "22".repeat(32), CPO_OWNER_EMAIL_HASH: previewOwnerHash };
const port = Number(process.env.CPO_PREVIEW_PORT || 4179);

const server = http.createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(incoming.headers);
  headers.set("oai-authenticated-user-email", previewOwnerEmail);
  const request = new Request("http://127.0.0.1:" + port + incoming.url, {
    method: incoming.method,
    headers,
    body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : body,
  });
  const response = await worker.fetch(request, env);
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "127.0.0.1", () => console.log("Preview http://127.0.0.1:" + port));
