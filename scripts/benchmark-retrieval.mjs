import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const ignoredQaRoot = resolve(repositoryRoot, "qa");
const retrievalAuditNamespace = "direct-xray-retrieval-stage-v1";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedText(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function normalizeLinkedInProfileKey(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com"))) return "";
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 3 && segments[2].toLowerCase() === "en") segments.pop();
    if (segments.length !== 2 || segments[0].toLowerCase() !== "in") return "";
    const slug = decodeURIComponent(segments[1]).normalize("NFKC").toLocaleLowerCase("en-US");
    return slug ? "/in/" + slug : "";
  } catch (_) {
    return "";
  }
}

export function normalizeReferenceRecords(input) {
  const entries = Array.isArray(input) ? input : input && Array.isArray(input.references) ? input.references : [];
  if (!entries.length) throw new Error("Reference file must contain a non-empty JSON array or { references: [...] }.");
  const records = [];
  const seen = new Set();
  for (const entry of entries) {
    const rawUrl = typeof entry === "string" ? entry : entry && entry.url;
    const key = normalizeLinkedInProfileKey(rawUrl);
    if (!key) throw new Error("Every reference entry must be a public HTTPS LinkedIn /in/ profile URL.");
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ id: "R" + String(records.length + 1).padStart(2, "0"), key });
  }
  if (!records.length) throw new Error("Reference file did not contain a unique LinkedIn /in/ profile URL.");
  return records;
}

function urlSetFrom(records, field) {
  const keys = [];
  for (const record of Array.isArray(records) ? records : []) {
    const key = normalizeLinkedInProfileKey(record && record[field]);
    if (key) keys.push(key);
  }
  return { keys, unique: new Set(keys) };
}

function recordMapByProfileKey(records, field) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = normalizeLinkedInProfileKey(record && record[field]);
    if (key && !map.has(key)) map.set(key, record);
  }
  return map;
}

function boundedUniqueTexts(values, limit, maximum) {
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = boundedText(value, limit);
    if (text && !unique.includes(text)) unique.push(text);
    if (unique.length >= maximum) break;
  }
  return unique;
}

function referenceDiagnostic(reference, candidate, source) {
  const hit = Boolean(candidate);
  return {
    id: reference.id,
    hit,
    roleEvidenceLevel: hit ? boundedText(candidate.roleEvidenceLevel || source && source.roleEvidenceLevel, 40) || null : null,
    evidenceBasis: hit ? boundedText(candidate.evidenceBasis || source && source.evidenceBasis, 80) || null : null,
    coverage: hit ? boundedText(candidate.coverage, 40) || null : null,
    score: hit ? finiteNumber(candidate.score) : null,
    koreaEvidenceLevel: hit ? boundedText(candidate.koreaEvidenceLevel || source && source.koreaEvidenceLevel, 40) || null : null,
    retrievalLanes: hit ? boundedUniqueTexts(source && source.retrievalLanes, 80, 4) : [],
    retrievalPaths: hit ? boundedUniqueTexts(candidate.retrievalPaths || source && source.retrievalPaths, 180, 8) : [],
    matchedRoleTerms: hit ? boundedUniqueTexts(candidate.matchedKeywords || source && source.matchedRoleTerms, 100, 8) : [],
  };
}

function retrievalAuditToken(nonce, profileKey) {
  return createHash("sha256").update(retrievalAuditNamespace + "|" + nonce + "|" + profileKey, "utf8").digest("hex");
}

function retrievalAuditSummary(response, references) {
  const audit = response && response.retrievalAudit;
  const nonce = boundedText(audit && audit.nonce, 80).toLowerCase();
  const stages = audit && audit.stages;
  if (!audit || audit.schemaVersion !== 1 || !/^[0-9a-f]{32,64}$/.test(nonce) || !stages) return null;
  const stageNames = ["rawUnique", "roleBound", "reviewPool", "finalReviewPool"];
  const availableStages = Object.fromEntries(stageNames.map((stage) => [stage, Array.isArray(stages[stage])]));
  const tokenSets = Object.fromEntries(stageNames.map((stage) => [stage, availableStages[stage] ? new Set(
    stages[stage].filter((token) => /^[0-9a-f]{64}$/.test(String(token || ""))),
  ) : null]));
  const results = references.map((reference) => {
    const token = retrievalAuditToken(nonce, reference.key);
    const result = { id: reference.id, ...Object.fromEntries(stageNames.map((stage) => [stage, availableStages[stage] ? tokenSets[stage].has(token) : null])) };
    result.lossStage = result.rawUnique === false ? "provider_retrieval"
      : result.roleBound === false ? "role_binding"
        : result.reviewPool === false ? "review_pool_selection"
          : result.finalReviewPool === false ? "final_card"
            : result.finalReviewPool === true ? null : "not_measured";
    return result;
  });
  const counts = Object.fromEntries(stageNames.map((stage) => [stage, availableStages[stage] ? results.filter((record) => record[stage]).length : null]));
  const lossCounts = Object.fromEntries(["provider_retrieval", "role_binding", "review_pool_selection", "final_card", "not_measured"].map((stage) => [stage, results.filter((record) => record.lossStage === stage).length]));
  lossCounts.recovered = results.filter((record) => record.lossStage === null).length;
  return {
    available: true,
    availableStages,
    counts,
    lossCounts,
    recall: Object.fromEntries(stageNames.map((stage) => [stage, counts[stage] == null ? null : counts[stage] / references.length])),
    results,
  };
}

function coverageRows(metrics, kind) {
  return (Array.isArray(metrics) ? metrics : []).map((metric, index) => ({
    id: boundedText(kind === "query" ? metric && metric.queryId : metric && metric.keyword, 180) || kind + "-" + String(index + 1),
    ...(kind === "query" ? {
      keyword: boundedText(metric && metric.keyword, 100),
      lane: boundedText(metric && metric.lane, 80),
      discoveryLabel: boundedText(metric && metric.discoveryLabel, 180),
      evidenceFacetId: boundedText(metric && metric.evidenceFacetId, 80) || null,
      evidenceGate: boundedText(metric && metric.evidenceGate, 80) || null,
      roleKeywordRequired: metric && typeof metric.roleKeywordRequired === "boolean" ? metric.roleKeywordRequired : null,
    } : {}),
    raw: finiteNumber(metric && metric.rawResultCount) || 0,
    unique: finiteNumber(metric && metric.uniqueProfileCount) || 0,
    roleBound: finiteNumber(metric && metric.roleMatchedProfileCount) || 0,
    directRole: finiteNumber(metric && metric.directRoleProfileCount) || 0,
    adjacentRole: finiteNumber(metric && metric.adjacentEvidenceProfileCount) || 0,
    expandedEvidence: finiteNumber(metric && metric.expandedEvidenceProfileCount) || 0,
    final: finiteNumber(metric && metric.finalAcceptedCandidateCount) || 0,
  }));
}

function balanceSummary(rows) {
  const finalCounts = rows.map((row) => row.final);
  const total = finalCounts.reduce((sum, value) => sum + value, 0);
  const nonZero = finalCounts.filter((value) => value > 0);
  const maximum = finalCounts.length ? Math.max(...finalCounts) : 0;
  const minimumNonZero = nonZero.length ? Math.min(...nonZero) : 0;
  return {
    dimensions: finalCounts.length,
    zeroContributionDimensions: finalCounts.filter((value) => value === 0).length,
    minimumNonZeroContribution: minimumNonZero,
    maximumContribution: maximum,
    maximumContributionShare: total ? maximum / total : null,
    maximumToMinimumNonZeroRatio: minimumNonZero ? maximum / minimumNonZero : null,
  };
}

export function evaluateRetrievalBenchmark(response, referenceInput, options = {}) {
  const references = normalizeReferenceRecords(referenceInput);
  const stageAudit = retrievalAuditSummary(response, references);
  const sources = urlSetFrom(response && response.sources, "uri");
  const candidates = urlSetFrom(response && response.candidates, "url");
  const sourcesByProfile = recordMapByProfileKey(response && response.sources, "uri");
  const candidatesByProfile = recordMapByProfileKey(response && response.candidates, "url");
  const preservedSourceCount = Array.from(sources.unique).filter((key) => candidates.unique.has(key)).length;
  const sourceToCardPreservationRate = sources.unique.size ? preservedSourceCount / sources.unique.size : null;
  const referenceResults = references.map((reference) => referenceDiagnostic(
    reference,
    candidatesByProfile.get(reference.key),
    sourcesByProfile.get(reference.key),
  ));
  const matchedReferenceCount = referenceResults.filter((reference) => reference.hit).length;
  const queryCoverage = coverageRows(response && response.queryMetrics, "query");
  const keywordCoverage = coverageRows(response && response.keywordMetrics, "keyword");
  const minimumRecallCount = finiteNumber(options.minimumRecallCount) ?? 1;
  const minimumSourceCardRate = finiteNumber(options.minimumSourceCardRate) ?? 1;
  const maximumCredits = finiteNumber(options.maximumCredits) ?? 10;
  const usageCredits = finiteNumber(response && response.usageCredits);
  const checks = {
    responseOk: response && response.status === "ok",
    recallCount: matchedReferenceCount >= minimumRecallCount,
    sourceToCardPreservation: sourceToCardPreservationRate != null && sourceToCardPreservationRate >= minimumSourceCardRate,
    creditBudget: usageCredits != null && usageCredits <= maximumCredits,
  };
  return {
    schemaVersion: 5,
    status: boundedText(response && response.status, 80) || "unknown",
    reference: {
      total: references.length,
      matched: matchedReferenceCount,
      recallAtReviewPool: matchedReferenceCount / references.length,
      results: referenceResults,
    },
    stageAudit: stageAudit || { available: false, counts: null, recall: null, results: [] },
    pool: {
      candidateRecords: Array.isArray(response && response.candidates) ? response.candidates.length : 0,
      uniqueCandidateUrls: candidates.unique.size,
      duplicateCandidateUrls: Math.max(0, candidates.keys.length - candidates.unique.size),
      sourceRecords: Array.isArray(response && response.sources) ? response.sources.length : 0,
      uniqueSourceUrls: sources.unique.size,
      sourceUrlsWithCards: preservedSourceCount,
      sourceToCardPreservationRate,
      reportedRawResults: finiteNumber(response && response.rawResultCount),
      reportedUniqueProfiles: finiteNumber(response && response.uniqueProfileCount),
      reportedRoleBoundProfiles: finiteNumber(response && response.roleMatchedProfileCount),
    },
    evidence: {
      directRoleProfiles: finiteNumber(response && response.directRoleProfileCount),
      adjacentRoleProfiles: finiteNumber(response && response.adjacentEvidenceProfileCount),
      expandedEvidenceProfiles: finiteNumber(response && response.expandedEvidenceProfileCount),
      koreaStrongProfiles: finiteNumber(response && response.koreaStrongProfileCount),
      koreaWeakProfiles: finiteNumber(response && response.koreaWeakProfileCount),
      koreaUnverifiedProfiles: finiteNumber(response && response.koreaUnverifiedProfileCount),
    },
    queryCoverage,
    queryBalance: balanceSummary(queryCoverage),
    keywordCoverage,
    keywordBalance: balanceSummary(keywordCoverage),
    operations: {
      usageCredits,
      latencyMs: finiteNumber(response && response.latencyMs),
      aiStructuredCandidates: finiteNumber(response && response.aiStructuredCandidateCount),
      serverRecoveredCandidates: finiteNumber(response && response.serverRecoveredCandidateCount),
    },
    acceptance: {
      thresholds: { minimumRecallCount, minimumSourceCardRate, maximumCredits },
      checks,
      passed: Object.values(checks).every(Boolean),
    },
    privacy: "Candidate names and profile URLs are intentionally omitted; R01..Rn follow the private reference-file order.",
  };
}

function roundStageAuditSummary(initial, deep, total) {
  const stageNames = ["rawUnique", "roleBound", "reviewPool", "finalReviewPool"];
  const initialResults = new Map((initial.results || []).map((result) => [result.id, result]));
  const deepResults = new Map((deep.results || []).map((result) => [result.id, result]));
  const availableStages = Object.fromEntries(stageNames.map((stage) => [stage, Boolean(
    initial.available
      && deep.available
      && initial.availableStages && initial.availableStages[stage]
      && deep.availableStages && deep.availableStages[stage],
  )]));
  const unionCounts = {};
  const deepAddedCounts = {};
  for (const stage of stageNames) {
    if (!availableStages[stage]) {
      unionCounts[stage] = null;
      deepAddedCounts[stage] = null;
      continue;
    }
    unionCounts[stage] = 0;
    deepAddedCounts[stage] = 0;
    for (let index = 1; index <= total; index += 1) {
      const id = "R" + String(index).padStart(2, "0");
      const initialHit = initialResults.get(id) && initialResults.get(id)[stage] === true;
      const deepHit = deepResults.get(id) && deepResults.get(id)[stage] === true;
      if (initialHit || deepHit) unionCounts[stage] += 1;
      if (!initialHit && deepHit) deepAddedCounts[stage] += 1;
    }
  }
  return {
    available: Object.values(availableStages).some(Boolean),
    complete: Object.values(availableStages).every(Boolean),
    availableStages,
    initialCounts: initial.counts || null,
    deepCounts: deep.counts || null,
    unionCounts,
    deepAddedCounts,
    unionRecall: Object.fromEntries(stageNames.map((stage) => [
      stage,
      unionCounts[stage] == null ? null : unionCounts[stage] / total,
    ])),
  };
}

export function evaluateRetrievalRounds(initialResponse, deepResponse, referenceInput, options = {}) {
  const references = normalizeReferenceRecords(referenceInput);
  const initial = evaluateRetrievalBenchmark(initialResponse, referenceInput, options);
  const deep = evaluateRetrievalBenchmark(deepResponse, referenceInput, options);
  const initialResults = new Map(initial.reference.results.map((result) => [result.id, result]));
  const deepResults = new Map(deep.reference.results.map((result) => [result.id, result]));
  const referenceResults = references.map((reference) => {
    const initialHit = Boolean(initialResults.get(reference.id) && initialResults.get(reference.id).hit);
    const deepHit = Boolean(deepResults.get(reference.id) && deepResults.get(reference.id).hit);
    return {
      id: reference.id,
      initialHit,
      deepHit,
      deepAdded: deepHit && !initialHit,
      unionHit: initialHit || deepHit,
    };
  });
  const initialCandidates = urlSetFrom(initialResponse && initialResponse.candidates, "url").unique;
  const deepCandidates = urlSetFrom(deepResponse && deepResponse.candidates, "url").unique;
  const candidateUnion = new Set([...initialCandidates, ...deepCandidates]);
  const overlappingCandidateUrls = Array.from(deepCandidates).filter((key) => initialCandidates.has(key)).length;
  const initialMatched = referenceResults.filter((result) => result.initialHit).length;
  const deepMatched = referenceResults.filter((result) => result.deepHit).length;
  const deepAdded = referenceResults.filter((result) => result.deepAdded).length;
  const unionMatched = referenceResults.filter((result) => result.unionHit).length;
  const maximumCreditsPerRound = finiteNumber(options.maximumCredits) ?? 10;
  const maximumTotalCredits = finiteNumber(options.maximumTotalCredits) ?? maximumCreditsPerRound * 2;
  const initialCredits = finiteNumber(initialResponse && initialResponse.usageCredits);
  const deepCredits = finiteNumber(deepResponse && deepResponse.usageCredits);
  const totalCredits = initialCredits == null || deepCredits == null ? null : initialCredits + deepCredits;
  const minimumRecallCount = finiteNumber(options.minimumRecallCount) ?? 1;
  const minimumSourceCardRate = finiteNumber(options.minimumSourceCardRate) ?? 1;
  const sourcePreservationPassed = (benchmark) => benchmark.pool.uniqueSourceUrls === 0
    || (benchmark.pool.sourceToCardPreservationRate != null
      && benchmark.pool.sourceToCardPreservationRate >= minimumSourceCardRate);
  const checks = {
    initialResponseCompleted: initial.status === "ok" || initial.status === "no_candidates",
    deepResponseCompleted: deep.status === "ok" || deep.status === "no_candidates",
    unionRecallCount: unionMatched >= minimumRecallCount,
    initialSourceToCardPreservation: sourcePreservationPassed(initial),
    deepSourceToCardPreservation: sourcePreservationPassed(deep),
    initialCreditBudget: initialCredits != null && initialCredits <= maximumCreditsPerRound,
    deepCreditBudget: deepCredits != null && deepCredits <= maximumCreditsPerRound,
    totalCreditBudget: totalCredits != null && totalCredits <= maximumTotalCredits,
  };
  return {
    schemaVersion: 1,
    reference: {
      total: references.length,
      initialMatched,
      deepMatched,
      deepAdded,
      unionMatched,
      initialRecall: initialMatched / references.length,
      deepRecall: deepMatched / references.length,
      unionRecall: unionMatched / references.length,
      results: referenceResults,
    },
    pool: {
      initialUniqueCandidateUrls: initialCandidates.size,
      deepUniqueCandidateUrls: deepCandidates.size,
      overlappingCandidateUrls,
      deepAddedCandidateUrls: deepCandidates.size - overlappingCandidateUrls,
      unionUniqueCandidateUrls: candidateUnion.size,
    },
    stageAudit: roundStageAuditSummary(initial.stageAudit, deep.stageAudit, references.length),
    operations: { initialCredits, deepCredits, totalCredits },
    acceptance: {
      thresholds: { minimumRecallCount, minimumSourceCardRate, maximumCreditsPerRound, maximumTotalCredits },
      checks,
      passed: Object.values(checks).every(Boolean),
    },
    privacy: "Candidate names and profile URLs are intentionally omitted; R01..Rn follow the private reference-file order.",
  };
}

export function compareRetrievalBenchmarks(current, baseline) {
  const currentResults = new Map(current.reference.results.map((item) => [item.id, item.hit]));
  const baselineResults = new Map(baseline.reference.results.map((item) => [item.id, item.hit]));
  const ids = Array.from(new Set([...currentResults.keys(), ...baselineResults.keys()])).sort();
  return {
    recallCountDelta: current.reference.matched - baseline.reference.matched,
    recallRateDelta: current.reference.recallAtReviewPool - baseline.reference.recallAtReviewPool,
    candidatePoolDelta: current.pool.uniqueCandidateUrls - baseline.pool.uniqueCandidateUrls,
    sourceToCardPreservationRateDelta: current.pool.sourceToCardPreservationRate == null || baseline.pool.sourceToCardPreservationRate == null
      ? null
      : current.pool.sourceToCardPreservationRate - baseline.pool.sourceToCardPreservationRate,
    recoveredReferenceIds: ids.filter((id) => currentResults.get(id) && !baselineResults.get(id)),
    lostReferenceIds: ids.filter((id) => !currentResults.get(id) && baselineResults.get(id)),
  };
}

function parseArguments(argv) {
  const parsed = {};
  const booleans = new Set(["execute-live", "stage-audit", "enforce", "help"]);
  const valued = new Set([
    "reference", "response", "deep-response", "baseline-response", "endpoint", "request", "save-response",
    "minimum-recall-count", "minimum-source-card-rate", "maximum-credits", "maximum-total-credits",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("Unexpected argument: " + token);
    const name = token.slice(2);
    if (booleans.has(name)) {
      parsed[name] = true;
      continue;
    }
    if (!valued.has(name)) throw new Error("Unknown option: --" + name);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --" + name);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function numericThreshold(args, name, fallback, minimum, maximum = Infinity, integer = false) {
  if (args[name] == null) return fallback;
  const value = finiteNumber(args[name]);
  if (value == null || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    const range = maximum === Infinity ? String(minimum) + " or greater" : String(minimum) + " to " + String(maximum);
    throw new Error("--" + name + " must be " + (integer ? "an integer from " : "a number from ") + range + ".");
  }
  return value;
}

function helpText() {
  return [
    "Evaluate a Direct X-ray Searching response without printing candidate URLs.",
    "",
    "Saved response:",
    "  node scripts/benchmark-retrieval.mjs --reference qa/reference-urls.json --response qa/current-response.json [--deep-response qa/current-deep-response.json] [--baseline-response qa/baseline-response.json] [--enforce]",
    "",
    "Live request (spends the site's configured provider credits):",
    "  node scripts/benchmark-retrieval.mjs --reference qa/reference-urls.json --endpoint https://example.com --request qa/search-request.json --execute-live --stage-audit --save-response qa/current-response.json [--enforce]",
    "",
    "Optional thresholds: --minimum-recall-count 1 --minimum-source-card-rate 1 --maximum-credits 10 --maximum-total-credits 20",
    "Reference and captured response files belong under ignored qa/ and must not be committed.",
  ].join("\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
}

function qaOutputPath(path) {
  const output = resolve(process.cwd(), path);
  const pathFromQa = relative(ignoredQaRoot, output);
  if (pathFromQa.startsWith("..") || isAbsolute(pathFromQa)) {
    throw new Error("Captured live responses may only be written under the ignored repository qa/ directory.");
  }
  return output;
}

async function executeLiveSearch(args) {
  if (!args["execute-live"]) throw new Error("Live mode can spend provider credits. Re-run with --execute-live to confirm.");
  if (!args.request) throw new Error("Live mode requires --request with a JSON search payload.");
  const endpoint = new URL("/api/search", args.endpoint);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))) {
    throw new Error("Live endpoint must use HTTPS, except localhost test servers.");
  }
  const payload = await readJson(args.request);
  if (args["stage-audit"]) payload.retrievalAuditNonce = randomBytes(16).toString("hex");
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      origin: endpoint.origin,
      "content-type": "application/json",
      "x-cpo-search": "1",
      ...(args["stage-audit"] ? { "x-cpo-retrieval-audit": "1" } : {}),
      "user-agent": "direct-xray-retrieval-benchmark/1.0",
    },
    body: JSON.stringify(payload),
  });
  const text = await upstream.text();
  let response;
  try { response = JSON.parse(text); } catch (_) { throw new Error("Live endpoint returned non-JSON data (HTTP " + upstream.status + ")."); }
  if (args["save-response"]) {
    const output = qaOutputPath(args["save-response"]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(response, null, 2) + "\n", "utf8");
  }
  return { response, httpStatus: upstream.status };
}

export async function runBenchmarkCli(argv) {
  const args = parseArguments(argv);
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (!args.reference) throw new Error("--reference is required.");
  const hasSavedResponse = Boolean(args.response);
  const hasLiveEndpoint = Boolean(args.endpoint);
  if (hasSavedResponse === hasLiveEndpoint) throw new Error("Choose exactly one of --response or --endpoint.");
  if (args["execute-live"] && !hasLiveEndpoint) throw new Error("--execute-live is only valid with --endpoint live mode.");
  if (args["stage-audit"] && !hasLiveEndpoint) throw new Error("--stage-audit is only valid with --endpoint live mode.");
  if (args["save-response"] && !hasLiveEndpoint) throw new Error("--save-response is only valid with --endpoint live mode.");
  if (args["deep-response"] && hasLiveEndpoint) throw new Error("--deep-response is only valid with a saved --response. Capture each live round separately before comparing them.");
  const referenceInput = await readJson(args.reference);
  const live = hasLiveEndpoint ? await executeLiveSearch(args) : null;
  const response = live ? live.response : await readJson(args.response);
  const thresholds = {
    minimumRecallCount: numericThreshold(args, "minimum-recall-count", 1, 0, Infinity, true),
    minimumSourceCardRate: numericThreshold(args, "minimum-source-card-rate", 1, 0, 1),
    maximumCredits: numericThreshold(args, "maximum-credits", 10, 0),
  };
  thresholds.maximumTotalCredits = numericThreshold(args, "maximum-total-credits", thresholds.maximumCredits * 2, 0);
  const benchmark = evaluateRetrievalBenchmark(response, referenceInput, thresholds);
  const output = {
    generatedAt: new Date().toISOString(),
    ...(live ? { httpStatus: live.httpStatus } : {}),
    benchmark,
  };
  if (args["deep-response"]) {
    const deepResponse = await readJson(args["deep-response"]);
    output.deepBenchmark = evaluateRetrievalBenchmark(deepResponse, referenceInput, thresholds);
    output.roundComparison = evaluateRetrievalRounds(response, deepResponse, referenceInput, thresholds);
  }
  if (args["baseline-response"]) {
    const baseline = evaluateRetrievalBenchmark(await readJson(args["baseline-response"]), referenceInput, thresholds);
    output.baseline = baseline;
    output.comparison = compareRetrievalBenchmarks(benchmark, baseline);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  const enforcedResult = output.roundComparison || benchmark;
  return args.enforce && !enforcedResult.acceptance.passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runBenchmarkCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write("benchmark_error: " + boundedText(error && error.message, 500) + "\n");
    process.exitCode = 2;
  }
}
