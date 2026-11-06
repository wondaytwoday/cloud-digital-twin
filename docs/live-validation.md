# 실계정 수집 검증 계획

실제 클라우드 계정 없이 수행한 사전 검토 결과와, 계정이 준비되면 실행할 검증 항목이다.

- **근거:** 각 CSP의 공개 API 문서에 적힌 동작(페이지 처리, 호출 제한, 응답 형식)을 기준으로 수집기 코드를 대조했다.
- **재현 방식:** 문서에 적힌 동작은 `tests/contract.test.ts`의 계약 테스트로 재현했다.
- **한계:** 계약 테스트는 "문서대로 응답한다면 수집기가 버틴다"는 것만 보여 준다. 실제 응답이 문서와 다를 수 있으므로 아래 2절은 실계정에서 다시 확인해야 한다.

## 1. 문서 기준 대조 결과

### 이번에 고친 것

| 클라우드 | API | 문서상 동작 | 기존 코드 | 조치 | 계약 테스트 |
|---|---|---|---|---|---|
| Azure | Cost Management Query | 호출 제한이 엄격함(QPU 기반). 429와 `x-ms-ratelimit-microsoft.costmanagement-*-retry-after` 헤더로 대기 시간을 알려 줌. 긴 결과는 `properties.nextLink`로 이어짐 | 재시도와 다음 페이지 처리가 없어 구독이 많으면 일부 구독 비용이 누락 | 헤더를 따르는 재시도, `nextLink` 처리, 중간에 실패한 구독은 일부만 남기지 않고 실패로 처리 | `Cost Management: …nextLink…` |
| Azure | Activity Log | 구독마다 따로 조회되며 429를 돌려줄 수 있음 | 구독 하나만 실패해도 변경 기록 전체를 잃음 | 구독별로 격리하고 '일부 누락'으로 표시, 재시도 | `Activity Log: one unreadable subscription…` |
| Azure | Resource Graph | Azure CLI와 SDK는 구독을 1,000개씩 나눠 조회함(1회 요청 상한으로 **추정**) | 모든 구독을 한 번에 요청 | 1,000개 단위로 나눠 조회하고 각 묶음의 `$skipToken`을 따로 처리 | `Resource Graph is queried in batches…` |
| Azure | 구독 접근 확인 | 429를 돌려줄 수 있음 | 재시도 없이 그 구독을 '일부 누락'으로 처리 | 재시도 | `a throttled Azure call is retried…` |
| AWS | CloudTrail LookupEvents | 계정·리전당 초당 2회 | 페이지를 쉬지 않고 연속 요청 | 페이지 사이 550ms 간격 | `CloudTrail pages are spaced…` |

### 문서와 일치해 고치지 않은 것

| 클라우드 | 확인한 내용 |
|---|---|
| AWS | 페이지 처리 토큰이 API마다 문서와 맞음: EC2 `NextToken`, ELBv2 `Marker`→`NextMarker`, RDS `Marker`, IAM `IsTruncated`/`Marker`, Direct Connect·EKS `nextToken`, Cost Explorer `NextPageToken` |
| AWS | SDK 재시도: `maxAttempts:3`, 표준 재시도 모드 |
| Azure | Microsoft Graph `getByIds`를 1,000개 단위로 나눠 호출 |
| Azure | Resource Graph에서 429·5xx 재시도, 반복되는 `$skipToken`과 `resultTruncated` 감지 |
| GCP | Cloud Asset `assets.list`: `pageSize` 1000, `readTime`을 고정해 페이지 간 일관성 유지 |
| GCP | Logging `entries:list`: 리소스 이름 50개씩 묶어 조회 |
| GCP | gaxios 기본 재시도가 429·5xx를 포함함 |

## 2. 실계정에서만 확인할 수 있는 것 (미검증)

1. **응답 필드명과 형식.** 예: Cost Management Monthly 결과의 `BillingMonth`, `ServiceName`, `Currency` 열 이름과 날짜 형식. EA·MCA·CSP 계약 유형마다 다를 수 있다.
2. **Resource Graph 1,000개 상한.** 1회 요청에 구독 1,000개 이상이 실제로 거부되는지. 거부되지 않더라도 나눠 조회해서 나빠지는 점은 없다.
3. **AWS SDK 클라이언트를 통한 실제 호출.** 테스트는 `call()` 함수를 가짜로 바꿨기 때문에 SDK 명령 이름·입력 형식은 "명령 존재 여부"만 확인했다.
4. **AWS 계정별 IAM·변경 기록 실패 집계.** SDK를 주입할 수 없어 공통 집계 규칙만 테스트했다.
5. **취소 신호.** 시간 초과 시 실제 SDK 요청이 멈추는지. 자격 증명 체인(SSO 토큰 갱신 등)은 취소되지 않는다.
6. **수집 소요 시간.** 구독·계정·프로젝트 수와 리전 수에 따라 15분 제한 안에 끝나는지.
7. **최종 일관성.** Resource Graph와 Asset Inventory는 생성 직후 자원을 늦게 보여줄 수 있다. 이것이 '삭제'로 오인되지 않는지 확인해야 한다.

## 3. 실계정 검증 매트릭스

계정이 준비되면 아래 순서로 실행한다. 각 항목은 콘솔·CLI 결과와 포털 표시를 대조한다.

| # | 시나리오 | 준비 | 통과 기준 |
|---|---|---|---|
| 1 | 단일 구독·계정·프로젝트 | Reader 수준 권한, 통제된 테스트 자원 10~20개 | 지원 대상 자원이 모두 보이고, ID·부모·상태가 콘솔과 일치 |
| 2 | 조직 전체 | 관리 그룹·OU·폴더 2단 이상, 범위 5개 이상 | 계층과 범위 수가 콘솔과 일치 |
| 3 | 권한 일부 거부 | 한 범위에서 특정 서비스 읽기 권한 제거 | 그 범위만 '일부 누락', 나머지는 정상, 경고에 서비스 이름 표시 |
| 4 | 데이터 종류별 거부 | IAM·Activity Log·CloudTrail·비용 권한을 하나씩 제거 | 해당 KPI·페이지에 '수집 실패/일부 누락', 0과 구분 |
| 5 | 빈 범위 | 자원 없는 구독·계정 | '미수집'이 아닌 빈 범위로 보이는지 확인. 현재는 구분하지 못하는 알려진 한계 |
| 6 | 호출 제한 | 구독 다수 또는 짧은 주기로 반복 수집 | 429 발생 시 재시도 로그, 누락 시 '일부 누락' 표시, 기존 스냅샷 유지 |
| 7 | 자격 증명 만료 | SSO 세션 또는 비밀 만료 | '로그인 필요'로 표시, 기존 스냅샷 유지 |
| 8 | 삭제·재생성 | 자원 삭제 후 같은 이름으로 재생성 | 변경 이력에 삭제·추가가 정확히 표시, 일부 누락 범위는 삭제로 오인하지 않음 |
| 9 | 공유 네트워크 | VNet 피어링(다른 구독), TGW 공유(RAM), GCP Shared VPC | 관계와 외부 참조가 올바르게 표시 |
| 10 | 연속 운영 | 7~14일 자동 수집 | 설명되지 않는 누락·거짓 삭제 없음, 이력 보존 기간 준수, `/api/ready` 정상 |
| 11 | Terraform plan 대조 | 실제 TFE plan JSON | 변경 대상이 수집 자원과 맞게 대조되고, 대조되지 않은 항목은 사유가 맞음 |

## 4. 필요한 최소 권한 (요약)

| 클라우드 | 역할 |
|---|---|
| Azure | 구독 Reader, 관리 그룹 읽기, Cost Management Reader, Microsoft Graph `Directory.Read.All`(주체 이름 표시용, 선택) |
| AWS | 각 계정 읽기 전용 역할(`ATLAS_AWS_ROLE_NAME`), 관리 계정 `organizations:List*`·`ce:GetCostAndUsage`, `cloudtrail:LookupEvents`, Resource Explorer 집계 인덱스 |
| GCP | 조직 또는 프로젝트 `roles/cloudasset.viewer`, `roles/browser`, `roles/logging.viewer`, 비용은 BigQuery 결제 내보내기 읽기 |
