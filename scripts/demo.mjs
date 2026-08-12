/**
 * 데모 하네스 - 네트워크를 타지 않고 화면 흐름 전체를 재현한다.
 *
 * 왜 필요한가: 이 도구를 실제로 돌리면 화면에 실존 인물의 공개 프로필이 뜬다.
 * 포트폴리오용 화면 녹화에 그대로 쓸 수 없다. 그래서 Tavily·Gemini 응답을
 * 가상 후보로 갈아끼운 채 앱 자체는 진짜로 돌린다. 검색 파이프라인, 근거 등급,
 * 점수 산출, 카드 렌더는 전부 실제 코드가 수행한다.
 *
 *   node scripts/demo.mjs        → http://127.0.0.1:4180
 *
 * 등장하는 후보는 전부 가상이다. 실존 인물·기업과 무관하다.
 */

import http from "node:http";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const DEMO_OWNER_EMAIL = "demo@example.test";
const ownerDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DEMO_OWNER_EMAIL));
const ownerHash = Array.from(new Uint8Array(ownerDigest), (b) => b.toString(16).padStart(2, "0")).join("");

/* ---------------------------------------------------------------- 가상 후보 */

// 전원 가상 인물. 실제 사람과 겹치지 않도록 '데모후보'를 이름에 박아둔다.
const DEMO_PEOPLE = [
  {
    slug: "demo-candidate-a",
    name: "데모후보 A",
    company: "데모커머스",
    title: "정보보호센터장 / CPO 겸임",
    evidence:
      "데모커머스 정보보호센터장으로 개인정보보호 조직을 총괄하며 ISMS-P 인증 취득과 갱신심사를 이끌었습니다. 위수탁·국외이전 통제 체계를 설계했습니다.",
    signals: ["privacy_program", "isms_audit", "org_leadership"],
  },
  {
    slug: "demo-candidate-b",
    name: "데모후보 B",
    company: "데모페이",
    title: "CISO",
    evidence:
      "데모페이 CISO로 침해사고 대응 체계를 세우고 클라우드 보안 통제를 도입했습니다. 개인정보보호책임자를 겸임했습니다.",
    signals: ["incident_response", "cloud_security", "privacy_program"],
  },
  {
    slug: "demo-candidate-c",
    name: "데모후보 C",
    company: "데모헬스",
    title: "Head of Privacy",
    evidence:
      "데모헬스에서 프라이버시 정책과 개인정보 영향평가(PIA)를 담당했습니다. 국내외 규제 대응 문서를 정비했습니다.",
    signals: ["privacy_policy", "pia"],
  },
  {
    slug: "demo-candidate-d",
    name: "데모후보 D",
    company: "데모클라우드",
    title: "Security Director",
    evidence:
      "데모클라우드 Security Director로 플랫폼 보안 아키텍처를 설계했습니다. AWS 환경의 IAM·로그·암호화 통제를 운영했습니다.",
    signals: ["cloud_security", "platform_security"],
  },
  {
    slug: "demo-candidate-e",
    name: "데모후보 E",
    company: "데모모빌리티",
    title: "개인정보보호 담당 (19년)",
    evidence:
      "개인정보·정보보호 분야에서 19년간 일했습니다. ISMS-P 인증심사원과 CPPG 자격을 보유하고 있습니다. 기업 내 책임 범위는 공개 문서에 나타나지 않습니다.",
    signals: ["long_career", "isms_auditor", "certification"],
  },
];

let tavilyCalls = 0;

function tavilyResults(query) {
  // 라운드마다 다른 후보가 섞여 들어오도록 회전시킨다(초기·심층 검색 구분이 보이게).
  const offset = tavilyCalls % DEMO_PEOPLE.length;
  return Array.from({ length: 4 }, (_, index) => {
    const person = DEMO_PEOPLE[(offset + index) % DEMO_PEOPLE.length];
    return {
      title: `${person.name} - ${person.title} | ${person.company} | LinkedIn`,
      url: `https://www.linkedin.com/in/${person.slug}`,
      content: person.evidence,
      raw_content: person.evidence,
      score: 0.9 - index * 0.07,
      query,
    };
  });
}

function geminiCandidates(prompt) {
  const found = DEMO_PEOPLE.filter((person) => prompt.includes(person.slug));
  const ids = [...prompt.matchAll(/([A-Za-z0-9_-]{1,24})\s*[:|]\s*https?:\/\/www\.linkedin\.com\/in\/([a-z-]+)/g)];
  const bySlug = new Map(ids.map((match) => [match[2], match[1]]));
  return {
    c: (found.length ? found : DEMO_PEOPLE).map((person, index) => ({
      id: bySlug.get(person.slug) || String(index + 1),
      n: person.name,
      co: person.company,
      t: person.title,
      l: "UNKNOWN",
      le: "UNKNOWN",
      e: person.evidence,
      s: person.signals,
    })),
  };
}

/* ------------------------------------------------------------ 네트워크 대체 */

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);

  if (target === "https://api.tavily.com/usage") {
    return Response.json({ key: { usage: tavilyCalls, limit: 1000 } });
  }
  if (target === "https://api.tavily.com/search") {
    const body = JSON.parse(init.body || "{}");
    tavilyCalls += 1;
    return Response.json({
      query: body.query,
      usage: { credits: body.search_depth === "advanced" ? 2 : 1 },
      request_id: "demo-request",
      results: tavilyResults(body.query),
    });
  }
  if (target.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body || "{}");
    const prompt = body?.contents?.[0]?.parts?.[0]?.text || "";
    const text = prompt.includes("Respond with the exact ASCII text OK")
      ? "OK"
      : JSON.stringify(geminiCandidates(prompt));
    return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
  }

  return realFetch ? realFetch(url, init) : new Response("blocked in demo", { status: 502 });
};

/* ------------------------------------------------------------------ 저장소 */

class DemoStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO cpo_byok_secrets_v1")) {
      const [secret_id, cipher_b64, iv_b64, last4, created_at, updated_at] = this.values;
      const prior = this.db.secrets.get(secret_id);
      this.db.secrets.set(secret_id, { secret_id, cipher_b64, iv_b64, last4, created_at: prior?.created_at || created_at, updated_at });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM cpo_byok_secrets_v1")) {
      const changed = this.db.secrets.delete(this.values[0]) ? 1 : 0;
      return { success: true, meta: { changes: changed } };
    }
    if (this.sql.startsWith("INSERT INTO cpo_gemini_usage_v1")) {
      const [day, now] = this.values;
      if (!this.db.usage.has(day)) this.db.usage.set(day, { request_count: 0, updated_at: now });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE cpo_gemini_usage_v1")) {
      const [units, now, day, maximumBefore] = this.values;
      const row = this.db.usage.get(day);
      if (!row || row.request_count > maximumBefore) return { success: true, meta: { changes: 0 } };
      row.request_count += units;
      row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    // 행위자별 Tavily 일일 크레딧. 이 표를 다루지 않으면 첫 검색이 곧바로
    // 한도 초과(429)로 떨어진다.
    if (this.sql.startsWith("INSERT INTO cpo_actor_tavily_usage_v1")) {
      const [day, actorHash, now] = this.values;
      const key = day + "|" + actorHash;
      if (!this.db.actorUsage.has(key)) this.db.actorUsage.set(key, { search_count: 0, reserved_credits: 0, updated_at: now });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE cpo_actor_tavily_usage_v1")) {
      if (this.sql.includes("reserved_credits = reserved_credits - ?")) {
        const [credits, now, day, actorHash, minimumCredits] = this.values;
        const row = this.db.actorUsage.get(day + "|" + actorHash);
        if (!row || row.search_count < 1 || row.reserved_credits < minimumCredits) return { success: true, meta: { changes: 0 } };
        row.search_count -= 1;
        row.reserved_credits -= credits;
        row.updated_at = now;
        return { success: true, meta: { changes: 1 } };
      }
      const [credits, now, day, actorHash, maximumBefore] = this.values;
      const row = this.db.actorUsage.get(day + "|" + actorHash);
      if (!row || row.reserved_credits > maximumBefore) return { success: true, meta: { changes: 0 } };
      row.search_count += 1;
      row.reserved_credits += credits;
      row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    // 데모에서는 중복 실행 잠금과 완료 서명을 통과시킨다. 같은 조건을 여러 번
    // 눌러 보여줘야 하는데 15분 잠금에 걸리면 녹화가 끊긴다.
    if (this.sql.startsWith("INSERT INTO cpo_search_lock_v2")) return { success: true, meta: { changes: 1 } };
    if (this.sql.startsWith("UPDATE cpo_search_lock_v2")) return { success: true, meta: { changes: 1 } };
    if (this.sql.startsWith("INSERT INTO cpo_completed_search_v1")) return { success: true, meta: { changes: 1 } };
    return { success: true };
  }
  async first() {
    if (this.sql.startsWith("SELECT secret_id")) return this.db.secrets.get(this.values[0]) || null;
    // 완료 서명 없음 = 같은 조건을 다시 눌러도 중복으로 막지 않는다.
    return null;
  }
}

class DemoD1 {
  constructor() {
    this.secrets = new Map();
    this.usage = new Map();
    this.actorUsage = new Map();
  }
  prepare(sql) {
    return new DemoStatement(this, sql);
  }
}

const env = {
  DB: new DemoD1(),
  BYOK_MASTER_KEY: "33".repeat(32),
  CPO_OWNER_EMAIL_HASH: ownerHash,
  CPO_ALLOWED_HOST: "127.0.0.1",
  CPO_PUBLIC_SEARCH_ENABLED: "0",
  // 데모는 실제 크레딧을 쓰지 않으므로 한도를 넉넉히 둔다.
  CPO_OWNER_TAVILY_DAILY_CREDIT_LIMIT: "10000",
  CPO_SEARCH_SIGNATURE_TTL_SECONDS: "0",
};

const { default: worker } = await import("../worker/index.js");
const port = Number(process.env.CPO_DEMO_PORT || 4180);

function demoRequest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("oai-authenticated-user-email", DEMO_OWNER_EMAIL);
  // 설정 변경은 same-origin 요청만 받는다. 브라우저가 붙이는 헤더를 대신 넣어준다.
  headers.set("origin", "http://127.0.0.1:" + port);
  return new Request("http://127.0.0.1:" + port + path, { ...init, headers });
}

// 화면에서 키 입력 장면을 거치지 않도록 더미 키를 미리 저장해 둔다.
async function seedKeys() {
  const seeds = [
    ["/api/settings/gemini", { apiKey: "AIza" + "0".repeat(35) }],
    ["/api/settings/tavily", { apiKey: "tvly-" + "0".repeat(32) }],
  ];
  for (const [path, payload] of seeds) {
    const response = await worker.fetch(
      demoRequest(path, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-cpo-settings": "1" },
        body: JSON.stringify(payload),
      }),
      env
    );
    console.log(`  seed ${path} → ${response.status}`);
  }
}

const server = http.createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(incoming.headers);
  headers.set("oai-authenticated-user-email", DEMO_OWNER_EMAIL);
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

await seedKeys();
server.listen(port, "127.0.0.1", () => console.log("Demo http://127.0.0.1:" + port + " (가상 후보 · 네트워크 미사용)"));
