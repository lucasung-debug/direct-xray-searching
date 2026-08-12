# Retrieval quality log

## 목적과 측정 단위

Direct X-ray Searching의 검색 품질은 후보 카드 수가 아니라 **정규화된 공개 LinkedIn `/in/` URL** 단위로 측정합니다. 기준 집합은 2026-08-06에 Google X-ray 스타일 검색과 공개 보조자료로 확인한 CPO 인접 후보 10명입니다.

점수는 검토 순서를 정리하는 참고값이고, 기준 URL의 발견 여부와는 별도 지표입니다. 검색 공급자가 찾지 못한 프로필은 Gemini가 복구할 수 없으므로 retrieval과 evaluation을 분리해 봅니다.

## 기준선

| 버전 | Tavily raw | URL 중복 제거 | 역할·인접 근거 소스 | 검토 카드 | 소스→카드 보존 | 기준 URL recall |
|---|---:|---:|---:|---:|---:|---:|
| v20 | 100 | 63 | 34 | 15 | 15/34 | 0/10 |
| v22 | 90 | 81 | 36 | 36 | 36/36 | 0/10 |
| v23 | 100 | 83 | 49 | 49 | 49/49 | 0/10 |

v20→v23에서 Gemini가 구조화하지 않은 소스를 서버 근거로 복구해 membership 손실은 제거했습니다. 그러나 기준 URL recall은 개선되지 않았으므로 남은 병목은 AI 평가가 아니라 검색 공급자 단계입니다.

## 이번 실험: 동일 credit의 역할어 + 프리셋 전문근거 retrieval

기존 방식은 역할 키워드 5개에 대해 복합 `advanced` 질의를 한 번씩 실행했습니다.

```text
5 queries × advanced 2 credits = 10 credits
```

첫 실험은 각 역할 키워드를 `role_identity`와 동일 역할어가 포함된 `professional_evidence` 검색면으로 나눴습니다. 그러나 두 검색면 모두 정확한 직함을 요구해, 실제로 개인정보보호 조직과 인증 성과를 이끈 사람이 공개 제목에 CPO/CISO를 쓰지 않으면 발견 범위가 넓어지지 않는 문제가 있었습니다.

현재 방식은 검색 10회의 예산을 다음처럼 사용합니다.

1. `role_identity`: 정확한 역할어 + LinkedIn people profile + 프리셋이 역할어별로 선언한 짧은 직무 문맥
2. `professional_evidence`: CPO 프리셋이 소유한 서로 다른 책임·성과 facet

CPO 프리셋의 전문근거 facet은 기준 후보군의 공개 신호 유형에 맞춰 다음 다섯 가지로 구성합니다.

- 개인정보보호 거버넌스·사고·규제·ISMS-P 성과
- 정보보호 센터·부문·조직 리딩
- 플랫폼·클라우드 보안 리딩
- 장기 개인정보·정보보호 경력과 ISMS-P·PIA 복수 근거
- Privacy·AI 거버넌스 리더십

공개 웹 인덱스 표본에서는 영어 설명형 query보다 `정보보호센터장`, `개인정보보호`, `경력 10년`처럼 실제 한국어 프로필에 쓰이는 표현이 레퍼런스형 후보를 더 직접적으로 드러냈습니다. 따라서 한국어/영어 직무 용어를 facet 목적에 맞춰 섞고, `정보보호센터장`·`정보보호부문장`·`Security Director`를 CPO 프리셋 역할군에 추가했습니다. 단, 물리보안·시설보안처럼 개인정보·정보보호·ISMS·cloud 문맥이 없는 동일 직함은 direct 근거로 인정하지 않습니다.

정확 역할어 lane도 단순히 `"CPO" + Korea`로 두지 않습니다. 이 형태는 Chief Product Officer 등 동음이의 프로필이 Tavily의 상위 결과 칸을 소모할 수 있습니다. CPO 프리셋은 각 역할어에 다음처럼 짧은 identity context를 소유합니다.

| 역할어 | identity context |
|---|---|
| 개인정보보호책임자 | Korea · 개인정보보호 · privacy · CPO |
| CPO | Korea · Chief Privacy Officer · privacy · 개인정보보호 |
| CISO | Korea · information security · privacy · 개인정보보호 |
| Head of Privacy | Korea · privacy · data protection · 개인정보보호 |
| 정보보호실장 | Korea · 정보보호 · 개인정보보호 · security leadership |

이 문맥은 retrieval 정밀도를 위한 검색어일 뿐 채용 적합 판정이나 hard gate가 아닙니다. 새 역할 프리셋은 자기 `identityRetrievalContexts`와 evidence facet을 함께 선언할 수 있고, 커스텀 역할은 사용자가 입력한 업무 문맥만 사용해 CPO 프리셋 지식을 상속하지 않습니다.

```text
5 exact-role queries + 5 preset evidence-facet queries
= 10 basic queries × 1 credit = 10 credits
```

Tavily 공식 문서는 `basic` 검색을 1 credit, `advanced` 검색을 2 credits로 설명하고 복잡한 검색을 짧은 하위 질의로 나누도록 권장합니다.

- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Search best practices](https://docs.tavily.com/documentation/best-practices/best-practices-search)
- [LinkedIn profile search](https://docs.tavily.com/examples/quick-tutorials/linkedin-profile-search)

## 후보 풀 다양성

검색 결과는 URL로 합친 뒤 한국 직무근거의 `strong`, `weak`, `unverified` tier를 유지합니다. 각 tier 안에서는 Tavily relevance만으로 상위 50명을 자르지 않고 query ID별 현재 선발 수가 가장 적은 검색면부터 한 명씩 가져옵니다.

이 방식의 목적은 다음과 같습니다.

- CISO처럼 결과가 많은 키워드가 전체 풀을 독점하지 않게 함
- `role_identity`와 `professional_evidence`가 모두 사람 검토 풀에 기여하게 함
- 낮은 점수·인접 후보도 정해진 범위에서 보존
- 각 검색면의 raw→unique→role-bound→final 전환을 별도로 측정

전문근거 검색 결과도 무조건 후보가 되지는 않습니다. 근거 강도를 세 단계로 나눕니다.

- `direct`: 프리셋의 역할군 직함이 후보 본인에게 결속됨
- `adjacent`: 개인정보보호 책임과 ISMS-P·클라우드·사고대응·조직리딩 중 하나 이상의 실무 성과가 후보 본인에게 결속됨
- `expanded`: 직함·기업 책임범위는 미확인이지만, 10년 이상 장기 개인정보·보안 경력과 ISMS-P를 포함한 복수 전문근거가 후보 본인에게 결속되거나, 개인정보 전문기관의 공식 지명문이 후보 이름과 한국 Privacy·AI 거버넌스 역할을 함께 명시함

`expanded` 후보는 사람이 먼저 사실관계를 확인하도록 점수를 49점 이하, coverage를 `Low`, 검증 상태를 `VERIFY`로 고정합니다. 일반 공유글은 계속 제외합니다. 공유 활동에서 제3자 근거를 보존하는 유일한 예외는 같은 근거 구간에 후보 이름, IAPP·KAPP 같은 개인정보 전문기관, 한국 역할, 임명·지정 표현, Privacy·AI 거버넌스 문맥이 모두 있는 경우입니다. 카드에는 이를 `공식 제3자 지정문`으로 따로 표시해 후보 본인의 경력 서술과 혼동하지 않습니다.

후보 membership과 검토 순위는 분리합니다. `AWS`, `ISMS-P 심사원`, `Director/센터장`처럼 레퍼런스형 후보를 찾는 데 유용한 단서는 회수 단계에서 버리지 않습니다. 다만 점수 단계에서는 후보 본인에게 결속된 책임·성과 문장이 있는지 다시 보고 네 강도로 구분합니다.

- `책임·성과 근거`: 운영·총괄 동사와 해당 영역의 구체 범위·통제·cycle 근거가 함께 있음
- `공식 제3자 지정`: 개인정보 전문기관이 후보 이름과 역할을 직접 지정함
- `자격·심사원 단서`: 관련 자격 또는 심사원 designation은 있으나 기업 내부 책임범위는 미확인
- `직함·용어 단서`: 직함이나 도메인 용어는 있으나 실제 권한·범위·결과는 미확인

특히 AWS 자격은 IAM·로그·암호화·region·backup·incident·위수탁/국외이전 통제 책임과 구분하고, ISMS 심사원은 인증 scope·갱신/사후심사·finding 종결 책임과 구분하며, Director/센터장 직함은 채용·평가·예산·조직 설계의 people-management 근거와 구분합니다. 단서 후보는 낮은 참고점수와 VERIFY로 남고 자동 탈락하지 않습니다.

새 역할 프리셋은 해당 역할에 맞는 facet을 명시적으로 정의해야 합니다. 아직 프리셋이 없는 커스텀 역할은 두 검색면 모두 정확한 역할어에 결속된 일반 fallback을 사용하며 CPO facet을 상속하지 않습니다.

## 자동 검증

회귀 fixture에서 다음을 확인합니다.

- 정확한 CPO/CISO 직함 없이 개인정보 거버넌스 책임과 ISMS-P 성과가 있는 프로필이 전문근거 검색에서 최종 후보로 보존됨
- 19년 개인정보·보안 경력과 ISMS-P/PIMS·PIA·AWS 복수 근거가 있지만 리더 직함이 없는 프로필은 `expanded`로 보존됨
- 후보 본인에게 결속된 Privacy·AI 거버넌스 country leadership은 `expanded`로 보존됨
- 공식 개인정보 전문기관이 후보 이름과 한국 country leadership을 함께 지명한 공개 문장은 `공식 제3자 지정문` `expanded`로 보존됨
- 공식 문장이어도 다른 사람을 지명했거나 일반 공유글이면 프로필 소유자 근거로 귀속하지 않음
- `정보보호센터장`과 개인정보·ISMS-P 문맥의 `Security Director`는 direct 역할군으로 보존됨
- 동일한 `Security Director`라도 시설·경호·물리보안 문맥뿐이면 제외됨
- 자격증과 관심 주제만 있는 프로필은 인접 후보로 들어오지 않음
- 자격증이 많아도 장기 직무경력 문장이 없거나 공유 글에만 근거가 있으면 확장 후보로 들어오지 않음
- 10개 검색면에서 100개의 서로 다른 유효 URL이 들어오면 각 검색면이 5명씩 기여해 50명 cap을 구성함
- 키워드별 metric은 정확한 역할어 검색의 기여만 집계해 전문근거 결과를 특정 역할어가 찾은 것처럼 오표기하지 않음
- query별 metric은 역할어 검색과 facet 검색 각각의 raw, unique, direct/adjacent/expanded, Korea evidence tier, 최종 후보 수와 `evidenceFacetId`·`evidenceGate`를 보존함
- 동일 프로필이 여러 검색면에서 반복될 때 발견 경로는 모두 남기되 같은 근거문장은 Gemini에 한 번만 전달함
- 총 예약 및 실제 사용량은 10 credits로 유지됨

## 다음 live 판정 기준

이번 변경은 실제 Tavily 실행 전까지 정확도 개선으로 확정하지 않습니다. 다음 한국시간 일일 한도 초기화 후 같은 입력으로 아래를 함께 비교합니다.

| 지표 | 판정 방향 |
|---|---|
| 기준 URL recall@50 | 0/10보다 높아야 함 |
| 소스→카드 보존율 | 100% 유지 |
| 직접 역할 오인율 | 공유글·자격·채용공고 표본에서 증가하지 않아야 함 |
| 신규 유효 후보율 | 사람이 원문 확인할 가치가 있는 후보 비율 기록 |
| keyword/query별 coverage | 한 검색면의 과도한 독점이 없어야 함 |
| Tavily credits | 10 이하 |
| 전체 latency | 운영 가능한 수준인지 별도 기록 |

기준 recall이 오르지 않으면 dual-lane 전략은 기각하거나 수정합니다. 후보 수 증가만으로 성공 판정하지 않습니다.

## 재현 가능한 비교 실행

기준 URL과 실제 응답에는 공개 인물 프로필이 포함되므로 Git에 커밋하지 않습니다. 저장소에서 이미 무시하는 `qa/` 아래에 JSON을 두고, benchmark 출력에는 URL·이름 대신 기준 파일 순서에 따른 `R01`~`Rn`만 표시합니다. 회수된 익명 레퍼런스에는 `roleEvidenceLevel`, `evidenceBasis`, 점수·coverage, Korea evidence tier, 역할어/전문근거 lane과 실제 발견 경로를 남깁니다. 미회수 항목은 프로필 URL을 공개 응답에 새로 노출하지 않고 query별 raw→role-bound→final 집계와 함께 해석해 검색 공급자 누락인지 후보 gate 이후 손실인지 다음 live QA에서 좁힙니다.

`qa/reference-urls.json`은 URL 문자열 배열 또는 `{ "references": [{ "url": "..." }] }` 형식입니다. `qa/search-request.json`은 화면에서 서버로 보내는 것과 같은 검색 조건입니다.

```json
{
  "preset": "cpo",
  "job": "CPO",
  "location": "한국 관련 인재 · 현재 거주지 무관",
  "keywords": "개인정보보호책임자\nCPO\nCISO\nHead of Privacy\n정보보호실장",
  "required": "privacy 10년 cloud ISMS",
  "preferred": "CISO SaaS",
  "additional": "Privacy by Design",
  "mode": "initial",
  "round": 0
}
```

저장해 둔 응답끼리 비교할 때:

```powershell
node scripts/benchmark-retrieval.mjs --reference qa/reference-urls.json --response qa/current-response.json --baseline-response qa/baseline-response.json --enforce
```

승인된 운영 배포를 다음 일일 한도 초기화 후 한 번 실행하고 응답을 저장할 때:

```powershell
node scripts/benchmark-retrieval.mjs --reference qa/reference-urls.json --endpoint https://example.com --request qa/search-request.json --execute-live --save-response qa/current-response.json --enforce
```

`--execute-live`가 없으면 네트워크 검색을 실행하지 않습니다. live 응답 저장 위치도 ignored `qa/` 내부로 제한합니다. 기본 합격선은 기준 URL 1개 이상 회수, 소스→카드 100%, Tavily 10 credits 이하이며 query·keyword별 최종 기여 편중과 latency는 별도 진단값으로 남깁니다.
