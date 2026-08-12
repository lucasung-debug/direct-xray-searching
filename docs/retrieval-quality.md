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

## 이번 실험: 동일 credit의 dual-lane retrieval

기존 방식은 역할 키워드 5개에 대해 복합 `advanced` 질의를 한 번씩 실행했습니다.

```text
5 queries × advanced 2 credits = 10 credits
```

새 방식은 각 역할 키워드를 두 개의 짧은 검색면으로 분리합니다.

1. `role_identity`: 정확한 역할어 + LinkedIn people profile + 직무 시장 문맥
2. `professional_evidence`: 정확한 역할어 + privacy/security/ISMS-P 등 전문 근거 문맥

```text
5 keywords × 2 lanes × basic 1 credit = 10 credits
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

## 자동 검증

회귀 fixture에서 다음을 확인합니다.

- 두 번째 검색면에만 존재하는 프로필이 최종 후보로 보존됨
- 10개 검색면에서 100개의 서로 다른 유효 URL이 들어오면 각 검색면이 5명씩 기여해 50명 cap을 구성함
- 키워드별 metric은 두 검색면을 합산하되 중복 URL은 한 번만 집계함
- query별 metric은 raw, unique, direct/adjacent, Korea evidence tier, 최종 후보 수를 보존함
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
