# 수집 안정성·비용·인벤토리 검증

[이슈 #2](https://github.com/wondaytwoday/cloud-digital-twin/issues/2)·[#4](https://github.com/wondaytwoday/cloud-digital-twin/issues/4)·[#6](https://github.com/wondaytwoday/cloud-digital-twin/issues/6)의 코드 수정과 운영 검증 항목입니다. #6 수정은 `main 5bc0290` 기반 `fix/issue-6-performance` 브랜치에서 구현했으며 최종 PR·병합 상태는 이슈 #6에서 추적합니다. 별도 `topology-relations` 브랜치의 미병합 기능은 포함하지 않습니다.

## 비용 수집

- Azure Resource Graph와 비용 쿼리는 공통 재시도 도우미를 사용합니다. HTTP 429와 5xx는 최초 요청을 포함해 최대 4회 요청하고, 기본 대기는 2·4·8초입니다. 서버가 더 긴 대기를 요구하면 그 시간을 지킵니다. 비용 구독 호출 사이에는 500ms 간격을 둡니다.
- Resource Graph의 30초·비용 쿼리의 60초 요청 제한은 재시도마다 새로 시작합니다. `Retry-After` 대기 때문에 다음 요청의 제한 시간이 미리 만료되지 않으며, 전체 수집 취소는 대기에도 적용합니다.
- 표준 `Retry-After`의 초·HTTP 날짜와 `x-ms-ratelimit-microsoft.costmanagement-*-retry-after`를 확인합니다. Cost Management가 전용 헤더를 사용하는 근거는 [Microsoft 자동화 문서](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/manage-automation)입니다.
- Azure 비용의 `nextLink`, AWS Cost Explorer의 `NextPageToken`, BigQuery 비용 결과의 `pageToken`을 끝까지 읽습니다. 반복 토큰, 잘못된 응답, 중간 페이지 실패를 전체 성공으로 취급하지 않습니다. Azure의 한 구독에서 페이지가 실패하면 그 구독의 새 부분 행을 버립니다.
- BigQuery 쿼리가 아직 실행 중이면 `jobReference`와 `location`을 유지해 결과를 기다립니다. 조회·페이지 처리 방식은 [BigQuery getQueryResults 문서](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults)를 따릅니다.
- `costCoverage`는 제공자별 `complete`, `partial`, `failed`, `unconfigured`, `pending`과 실패 범위를 기록합니다. 완전히 성공한 조회만 `costAt`을 갱신합니다. Azure/AWS의 성공한 빈 결과는 정상 결과로 인정합니다. GCP 결제 내보내기의 0행은 기본 `pending`·`waiting-data`이며 이전 비용과 정상 조회 시각을 유지하고 다음 수집에서 재조회합니다. 이전 프로그램이 빈 결과를 `complete`로 저장했어도 다음 수집에서 24시간을 기다리지 않고 재조회합니다. 시간이 지났다는 이유로 정상 전환하지 않습니다. 비용 없는 환경임을 운영자가 확인한 경우에만 `ATLAS_GCP_ALLOW_EMPTY_COST=1`로 빈 성공을 허용합니다.
- 일부 범위가 실패하면 새로 읽은 범위의 비용과 실패 범위의 이전 비용을 함께 유지하고, 비용 화면·대시보드·수집 상태에 일부 누락을 표시합니다. 이전 값은 최신 합계로 보증하지 않습니다. 다음 수집에서는 24시간 캐시를 기다리지 않고 재시도합니다.
- 실패한 전체 조회와 비용 미설정에서는 이전 비용을 유지합니다. 처음부터 이전 값이 없으면 금액 0으로 표시하지 않고 미수집 사유를 보여줍니다.
- 통화 환산과 환율이 없는 통화 제외 규칙은 기존 비용 분석 모듈을 사용합니다.
- 환율은 **각 통화 1단위가 기준 통화로 얼마인지**를 뜻합니다. USD 기준의 KRW 환율은 역수로 원/달러를 구하며, 제3의 기준 통화와 다른 통화 간 비율도 보존합니다. 무한대·0·음수는 환율로 받지 않습니다. 대시보드도 환율 없는 통화의 제외를 알리고, 환산 가능한 행이 없으면 비용을 `—`로 표시합니다.
- 기존 version 1에 해당 제공자의 `costCoverage`가 없으면 비용 행이 있거나 이전 조회가 비어 있었더라도 완전성을 가정하지 않습니다. 다음 수집에서 한 번 재조회하고 `complete`가 확인되면 기본 24시간 주기로 돌아갑니다. live 화면에는 기존 비용의 완전성 검증 안 됨을 표시합니다.
- AWS 비용은 계정 수집 전에 로그인한 결제 주체로 조회합니다. 조직 조회 실패는 `unit: organization`과 빈 `failedScopes`로 기록하며, 계정 수만큼 실패 건수를 늘리지 않습니다. `reason`은 `denied`, `throttled`, `network`, `timeout`, `unknown`을 구분합니다. 각 Cost Explorer 요청은 60초 제한을 두며 전체 제한 시간 취소도 적용됩니다.
- 비용 단계가 끝나기 전에 전체 제한 시간이 지나면 `skipped-timeout` 사유를 수집 상태에 표시합니다. 완료 계정이 없어 기존 스냅샷을 유지하는 경우에도 실패 이유는 수집 상태에 남으며 다음 실행에 다시 조회합니다. 완료 계정이 있을 때 비용 실패 메타데이터도 함께 저장합니다.

## AWS 수집과 시간 제한

| 변수 | 기본값 | 범위·동작 |
|---|---|---|
| `ATLAS_AWS_ACCOUNT_CONCURRENCY` | 3 | 계정 동시 수집 수, 정수로 처리, 최대 8 |
| `ATLAS_AWS_REGION_CONCURRENCY` | 4 | 계정별 자원·CloudTrail 리전 동시 수집 수, 최대 8 |
| `ATLAS_COLLECT_TIMEOUT_MIN` | 15 | 제공자별 수집 제한(분), 최대 180 |
| `ATLAS_COST_HOURS` | 24 | 완전한 비용 수집 결과의 재조회 주기(시간) |
| `ATLAS_PROVIDER_CONCURRENCY` | 2 / 프록시 1 | 제공자 동시 실행 수, 최대 3 |
| `ATLAS_REQUEST_CONCURRENCY` | 8 / 프록시 4 | 제공자 공통 활성 API 요청 수, 최대 32 |

동시성·제한 시간에 양수가 아닌 값이나 숫자가 아닌 값을 넣으면 기본값을 사용합니다. 리전 동시성은 계정별 제한이므로 전체 리전 요청 수는 계정 수와 함께 늘어납니다. 스로틀링이 생기면 두 동시성을 줄입니다.

공통 요청 대기열은 Azure 요청·AWS SDK dispatch·GCP API 요청에 적용하며 대기 중 수집 취소도 처리합니다. 자격 증명 SDK 내부 연결까지 모두 제한하는 설정은 아닙니다. 프록시는 `HTTPS_PROXY`/`HTTP_PROXY`와 소문자 변수로 감지합니다. Azure 일반 조회도 연결 오류·429·5xx를 재시도하며 비용·Resource Graph의 별도 요청 제한·재시도 계약은 유지합니다. 실제 권한 거부(401/403), 요청 중단, 연결 시간 초과, 프록시가 설정된 상태의 지연, TLS 신뢰 오류를 구분해 안내합니다. 실제 프록시 포화 재현은 별도 검증입니다.

CloudTrail의 동일 계정·리전 페이지 사이에는 500ms를 둡니다. LookupEvents의 계정·리전당 초당 2회 제한은 [AWS API 문서](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html)에 명시되어 있습니다.

완료된 계정은 중간 결과로 보존합니다. 전체 제한 시간을 넘기면 진행 요청을 취소하고, 완료 계정은 저장하며 미완료 계정을 `incomplete`로 남깁니다. 미완료·부분 범위에서 읽지 못한 이전 자원에는 이전 수집 시각과 이전 값 유지 표시를 붙입니다. 누락을 삭제 이력으로 보고하지 않습니다. 완료 계정이 하나도 없는 시간 초과는 기존 스냅샷을 유지합니다. 취소되지 않은 요청이 남으면 같은 제공자의 다음 실행을 막고 취소 대기 사유를 표시합니다.

계정·리전 자원·IAM·나머지 서비스·CloudTrail 단계의 경과 시간을 진행 상태와 수집 로그에 남깁니다. 제공자를 지정한 `npm run collect -- --provider ...`도 자동 수집과 같은 실행기를 사용합니다.

계정별 마지막 완료 시각은 `scopeCollectedAt`에 저장합니다. 다음 실행은 미수집 계정, 오래된 계정 순으로 시작하므로 완료 계정이 항상 앞자리를 차지하지 않습니다. 이전 값 유지로 보존한 범위의 완료 시각은 갱신하지 않습니다. 구형 스냅샷은 미완료 범위를 제외한 기존 수집 시각을 초기 기준으로 사용합니다. 전체 시간 초과 시 완료 계정 수와 전체 대상 수, 다음 실행의 진행 방식과 제한 시간 설정을 안내합니다. 가장 느린 구간 상위 5개는 상태와 수집 메뉴에 남깁니다. 제한 시간의 기본값·상한과 CloudTrail 수집 기본 동작은 유지합니다.

## VM 용량 조회

- Azure는 구독·리전별 [Resource SKUs](https://learn.microsoft.com/en-us/rest/api/compute/resource-skus/list?view=rest-compute-2021-07-01)의 모든 페이지를 읽어 `vCPUsAvailable`(없으면 `vCPUs`), `MemoryGB`, GPU 수를 적용합니다. GPU 모델을 API가 제공하지 않으면 모델 미제공으로 표시합니다. 구독 범위의 `Microsoft.Compute/skus/read` 권한이 필요하며 구독 Reader가 포함합니다([Microsoft 권한 안내](https://microsoft.github.io/capacity-toolkit/getting-started.html)).
- GCP는 프로젝트·영역·크기별 [machineTypes.get](https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes/get)의 `guestCpus`, `memoryMb`, `accelerators`를 읽습니다. VM의 `guestAccelerators`가 있으면 그 관측 구성을 보존합니다. 명시적인 맞춤형 이름만 CPU와 MiB를 해석합니다([공식 형식 예시](https://docs.cloud.google.com/compute/docs/instances/changing-machine-type-of-stopped-instance)).
- GCP는 `compute.machineTypes.get`이 필요합니다. Asset Inventory 조회 권한만으로 이 권한까지 보장되지 않으며 Compute Viewer 등 읽기 역할을 확인해야 합니다([Compute IAM](https://docs.cloud.google.com/compute/docs/access/iam)). API 비활성·권한 거부는 알 수 없는 크기와 구분합니다.
- 중복 제거 캐시는 한 번의 수집 동안 유지하고 다음 수집에서 다시 확인합니다. API 실패 시 내장표가 있으면 수치와 폴백 출처·실패 사유를 보존하며, 내장표에도 없으면 숫자를 만들어 넣지 않습니다. 실행 중 VM의 확인하지 못한 값은 합계에서 제외하고 용량 안내와 상세에 사유를 표시합니다.

세 제공자 모두 IAM 조회 실패 범위를 자원 수집 완료와 별도로 기록합니다. 그 범위의 이전 IAM 할당에는 이전 수집 시각을 표시하고, 다음 IAM 조회가 성공한 빈 결과이면 이전 할당을 지웁니다.

GCP는 일부 조직을 성공적으로 읽었어도 그 조직에서 확인되지 않은 다른 프로젝트를 개별 조회합니다. 개별 조회 실패는 `incomplete`로 남깁니다. 자원이 없는 Azure 구독과 GCP 프로젝트도 성공한 수집 범위와 계층 항목으로 유지합니다.

## 인벤토리와 토폴로지

- 제공자별 일반 자원 분류·계층·근거는 `shared/resource-types.json`, 해석은 `shared/classification.ts`에서 관리합니다. Tier 1은 주요 자원·보안·미등록 타입을 보존합니다. Tier 2는 모니터링·DNS·로그, Tier 3은 낮은 정보량의 구성 부속물입니다. 정책·규칙·참조 대상·부모는 계층과 무관하게 보존합니다. 등록하지 않은 타입은 `service`로 유지하며 미분류 타입 상위 10개를 로그와 리소스 화면에 표시합니다.
- 기본 `ATLAS_INVENTORY_MODE=summary`에서는 Tier 2/3을 범위·타입별 개수와 최대 3개 예시로 저장합니다. `full`로 전체 부속물을 유지할 수 있습니다. 리소스 화면의 **구성 부속물 포함**에서 요약/상세를 확인합니다. 부분 범위는 이전 요약·시각을 유지하며 정상 조회 전까지 최신 합계로 보증하지 않습니다. 목록 API 자체는 수집 후 요약하므로 조회 호출 수가 모두 줄어드는 것은 아닙니다. 서버리스 애플리케이션을 VM 용량에 더하지 않습니다.
- 지도는 네트워크를 기본으로 표시합니다. **워크로드**를 켜면 같은 위치·종류의 4개 이상 자원을 묶어 시작하고 펼칠 수 있습니다. 네트워크에 배치된 워크로드 검색은 해당 묶음을 펼칩니다. 네트워크 위치나 링크가 없는 자원은 기본 지도에서 숨기고 개수를 안내하며 인벤토리에 유지합니다.
- **접근 관계**는 정책 적용 규칙·구성 참조·역할 할당 근거를 별도로 보여줍니다. 선택 자원의 연결 근거로 좁힐 수 있습니다. Azure VM 디스크·관리 ID, AWS EBS, GCP 디스크·서비스 계정은 실제 연결 필드가 있는 경우만 `reference`로 연결합니다. `reference`는 네트워크 경유나 관측 통신이 아닙니다. Azure/GCP 자원 수준 역할 할당의 대상 ID를 보존하며, 범위 역할을 특정 자원의 실효 권한으로 확대하지 않습니다. 방화벽 규칙을 실제 통신 링크로 바꾸지 않습니다.
- `collectionGaps`는 실패한 API·범위·리전·오류 코드와 `denied`, `unavailable`, `failed`를 기록합니다. DNS·네트워크 오류를 리전 미지원으로 추정하지 않습니다. 지도와 리소스 화면에서 상세 사유를 확인할 수 있습니다.
- 미해결 연결은 실제 자원으로 만들지 않고 `external` 참조로 표시합니다. 권한 오류 근거가 있을 때만 권한 없음으로 표시하고, 다른 범위의 미수집과 사유 미확인을 구분합니다. `parent`와 정책을 경유 경로로 취급하는 규칙은 변경하지 않습니다.
- 부분 수집으로 빠진 상위 자원을 이전 값으로 보존할 때, 이번 응답에 그 상위를 참조한 하위 자원의 네트워크 위치도 복원합니다. 이전 부모를 근거 없이 새 응답에 덧붙이지 않습니다.
- 보안 그룹 규칙·연결 설정·파라미터 그룹·이벤트 규칙·캐시 사용자·키·인스턴스 설정의 타입 매핑을 보강합니다. AWS `DescribeSecurityGroupRules`의 정확한 `GroupId`·`SecurityGroupRuleId`로 확인된 규칙은 상위 그룹의 `rules`로 모으고 같은 ID의 목록 중복만 제거합니다. 추가 읽기 권한 `ec2:DescribeSecurityGroupRules`가 없거나 응답이 비면 기존 그룹 규칙을 유지합니다. Resource Explorer 목록만 있는 미확인 규칙은 추정 병합하지 않습니다.
- VPC 엔드포인트·엔드포인트 서비스·네트워크 인터페이스는 `endpoint`(네트워크 접점)로 분류합니다. 네트워크 범주와 기본 지도에 표시하지만 VPC·서브넷 경계나 경유 게이트웨이로 표현하지 않습니다. 목록만으로 부모·연결·통신을 만들지 않습니다.

## 저장 형식과 검증

기존 version 1 스냅샷은 새 메타데이터 배열의 기본값으로 계속 읽습니다. 새 범주·구성 부속물 표시는 새로 정규화한 수집 결과에 적용됩니다. 새 범주가 들어 있는 스냅샷은 이전 프로그램의 고정 `ResourceKind` 열거형으로 읽을 수 없으므로 프로그램을 먼저 갱신합니다. live 스냅샷의 합성 지표·IAM·시뮬레이션 거부 검증을 유지합니다.

`scopeCollectedAt`은 없는 경우 빈 맵으로 읽고, 비용 `reason`·`unit`은 선택 필드입니다. 기존 파일을 읽을 수 있으며 새 `endpoint` 타입을 저장한 파일은 이 타입을 지원하는 프로그램으로 열어야 합니다. 범위 제한 응답에서는 허용된 범위의 완료 시각만 제공합니다.

#6의 `inventorySummary`는 기본 빈 배열, `inventoryMode`·표현 메타데이터·역할 대상 ID·규칙 ID는 선택 필드입니다. 새 프로그램은 기존 version 1을 읽습니다. 새 `reference` 링크와 `pending` 비용 상태가 저장된 파일은 이를 지원하는 새 프로그램이 필요합니다.

저장은 들여쓰기 없는 전체 JSON으로 원자 교체합니다. 이력은 최근 두 파일과 UTC 일별 기준본을 합쳐 제공자별 최대 30개이며, 일별 기준 보관 기간은 `ATLAS_HISTORY_DAYS`(기본 30, 최대 365일)입니다. 최근 두 파일은 비교를 위해 기간과 무관하게 유지합니다. 비교 전 이전 스냅샷에도 현재 요약 규칙을 적용해 모드 전환을 삭제로 표시하지 않습니다.

`/api/topology?part=scopes|dashboard|map|inventory|network|security|iam|audit|cost|findings|changes`는 화면별 표현을 제공합니다. 생략 또는 `full`은 전체 응답입니다. 범위 요약에는 개수만, 비용·IAM에는 해당 배열만, 대시보드에는 원본 활동 대신 범위·일·종류별 정확한 개수를 보냅니다. 모든 새 응답의 스키마·live 검증을 유지하고 전체 JSON 내보내기는 `full`을 재조회합니다.

서버는 최신 파일·직전 이력·상태의 버전이 바뀌면 병합 캐시를 무효화합니다. ETag/304와 gzip은 매 요청 인증·범위 제한 후의 표현에 적용하며 `private, no-cache`, Cookie/Authorization/인코딩별 Vary를 설정합니다. 다른 범위·압축 표현의 ETag가 공유되지 않도록 검증했습니다. 방문 페이지는 클라이언트에서 재사용하고 새로고침·수집 완료·로그아웃 시 비웁니다. 리소스 목록은 100행씩 렌더링합니다. 합성 측정과 남은 실환경 확인은 [#6 계획](issue-6-plan.md)에 기록합니다.

단위 테스트는 가짜 HTTP·AWS 런타임으로 재시도, 페이지 실패, 비용 캐시, 계정·리전 동시성, 시간 초과, 이전 데이터 보존, 취소 대기, 새 메타데이터의 범위 제한을 확인합니다. E2E는 프로덕션 목 서버와 가짜 live 서버로 비용 누락·빈 상태·워크로드 전환·구성 부속물 필터를 확인합니다. 실제 계정 데이터는 사용하지 않습니다.

실계정 검증은 별도로 남아 있습니다.

- [ ] Azure 비용을 청구 포털의 **같은 기간·같은 범위·같은 통화·같은 비용 유형**과 비교해 5% 이내인지 확인
- [ ] AWS 조직 수집 완료 또는 시간 초과 후 완료 계정 저장·미완료 범위 표시 확인
- [ ] 재수집한 AWS의 VPC·서브넷·게이트웨이·링크가 실제 구성과 일치하는지 확인
- [ ] 실제 타입 분포에서 기타 비중 20% 이하 여부 확인. 목표에 맞추려고 미등록 타입을 임의 분류하지 않음
- [ ] 세 제공자의 실제 전용선·피어링·게이트웨이 구성이 기본 지도에서 읽히는지 확인

위 확인 전에는 실제 비용 정확도나 실제 AWS 토폴로지 복구가 입증되었다고 보고하지 않습니다.

2026-11-10 [이슈 #4](https://github.com/wondaytwoday/cloud-digital-twin/issues/4)에 Azure 비용 직접 조회 합계 일치와 AWS 네트워크 자원·링크 생성이 확인됐다고 기록되어 있습니다. 이번 작업에서 실제 클라우드를 재조회한 결과는 아닙니다. 오늘 수정분의 콘솔 VM 합계, AWS 반복 수집, 오류 분류, 미분류 비율과 실제 지도 확인은 [수정 계획](issue-4-plan.md)의 후속 검증으로 추적합니다.
