# 멀티클라우드 인프라 운영 포털 구현 검토

검토일: 2026-10-14. 대상: AWS·Azure·GCP 리소스 구성, 네트워크 연결, 권한, 상태를 탐색하는 웹서비스.

## 판단

구현 가능하다. 제품의 중심은 클라우드 API로 유지하는 리소스·관계 그래프이며, 구성도는 이 그래프의 목적별 화면이다. 기존 cloud-architecture-drawio 스킬은 표현 규칙과 문서 내보내기에 활용할 수 있다. 수집기·지속 동기화·권한 분석·대규모 웹 탐색 기능은 새로 개발해야 한다.

권장 시작점은 Azure 단일 Entra 테넌트, 여러 구독의 읽기 전용 운영 포털이다. 다중 CSP를 수용하는 데이터 모델은 처음부터 설계하되 커넥터 구현은 순차 진행한다. 실제 연결된 계정은 없으며, 이 문서는 로컬 코드와 공식 문서에 근거한 타당성 검토다. 데이터 완전성, 지연, 비용, 성능은 실제 환경 PoC에서 검증해야 한다.

## 기존 자산 검토

현재 cloud-digital-twin 디렉터리는 검토 시작 시 비어 있었다. 상위 cloud-architecture-skill의 README, 모델 형식, Azure 규칙, 아이콘 출처, 생성기 진입점을 확인했다.

| 기존 자산 | 활용 방안 | 추가 개발 |
|---|---|---|
| CSP 아이콘 카탈로그와 배치 규칙 | 웹 노드 표현과 구성도 export에 공유 | 서비스 종류별 아이콘 보강, 웹용 변환, 배포 조건 확인 |
| containers / nodes / edges와 안정적인 ID | 화면 모델로 재사용 | 실제 자산 ID, 시간, 권한 범위, 원본 속성을 가진 도메인 모델 |
| 네트워크 경계와 관계 종류 | 관리 범위·배치·연결 의미 구분 | 네트워크 및 IAM 분석용 관계 종류 |
| draw.io 생성·검증·PNG 렌더링 | 보고서와 변경 전후 문서 내보내기 | 비동기 export worker와 작업량 제한 |
| diff·evidence·부분 재라우팅 | 변경 표시와 출처 추적 설계에 활용 | 이벤트 수집, 이력 저장, 웹 화면의 증분 업데이트 |

스킬 README는 모든 토폴로지를 자동 배치하는 엔진이 아니며 입력 해석과 배치 선택에 에이전트가 관여한다고 명시한다. 따라서 임의의 대규모 실환경을 지속적으로 배치하려면 별도 레이아웃 전략이 필요하다. 운영 데이터의 정본을 draw.io 좌표 모델로 삼지 않고, 그래프에서 선택한 뷰를 기존 모델로 변환한다.

## 기능별 가능성과 경계

| 기능 | 판단 | 조건과 한계 |
|---|---|---|
| 3사 자원 통합 목록·검색 | 높음 | 서비스별 지원 범위와 수집 권한을 관리해야 함 |
| 계정·구독·프로젝트별 구성도 | 높음 | 전체를 한 번에 펼치지 않고 집계·검색·드릴다운 제공 |
| VM 클릭 시 vCPU·메모리·GPU 구성 | 높음 | VM 속성과 SKU/머신 타입 카탈로그 결합, 미지원 필드는 미확인 표시 |
| CPU·메모리·GPU 사용률 | 조건부 가능 | 플랫폼 메트릭과 게스트 메트릭 구분; 메모리·GPU는 환경에 따라 에이전트/exporter 등 필요 |
| 방화벽 허용 규칙과 포트 조회 | 높음 | 방향·프로토콜·출발지·목적지·우선순위·적용 대상을 함께 표시 |
| 실제 통신 가능 여부 판정 | 지원 범위 내 가능 | 경로·보안 정책·NAT·반환 경로·DNS·OS/앱 상태를 별도로 고려 |
| 실제 통신 흐름 시각화 | 조건부 가능 | Flow Logs·방화벽 로그·APM 등의 사전 수집 필요; 미관측은 통신 없음의 증거가 아님 |
| 사용자·그룹·역할 할당 조회 | 높음 | 클라우드 IAM과 외부 IdP/디렉터리 권한을 별도로 수집 |
| 사용자 실효 권한 판정 | 난도 높음 | 상속·중첩 그룹·조건·명시적 거부·세션·PIM 상태 등 평가 필요 |
| 포털에서 방화벽·IAM 변경 | 가능, 후속 단계 권장 | 읽기 수집기와 별도 실행 권한, 변경 검토·감사·재검증 필요 |
| 초 단위로 모든 상태를 정확히 동기화 | 보장 불가 | CSP 데이터 반영 지연·API 한도·로그 지연·권한 공백 존재 |

VM 사양의 메모리 32 GiB와 메모리 사용률 70%는 서로 다른 데이터다. 구성 정보는 기본 API로, 사용률은 모니터링 시스템으로 가져온다. Azure는 호스트 메트릭과 게스트 메트릭의 수집 경로를 구분한다. [Azure VM 모니터링](https://learn.microsoft.com/en-us/azure/azure-monitor/vm/monitor-virtual-machine-analyze)

## CSP별 데이터 수집

| 영역 | Azure | AWS | GCP |
|---|---|---|---|
| 조직 범위 | Entra tenant / Management Group / Subscription | Organization / OU / Account / Region | Organization / Folder / Project |
| 기본 인벤토리 | Resource Graph + ARM 서비스 API | 서비스별 Describe/List API + 이미 구성된 Config Aggregator 활용 | Cloud Asset Inventory + 서비스별 API |
| 변경 트리거 | Event Grid의 ARM 변경 이벤트, Activity Log 보완 | EventBridge의 Config 변경 이벤트, CloudTrail 보완 | Asset Inventory Feed / Pub/Sub, Audit Logs 보완 |
| 메트릭 | Azure Monitor | CloudWatch | Cloud Monitoring |
| 관측된 통신 | VNet Flow Logs, Firewall 로그 | VPC Flow Logs, 방화벽·LB 로그 | VPC Flow Logs, Firewall 로그 |
| 권한 | Azure RBAC + 필요한 Microsoft Graph 조회 | IAM, Organizations 정책, 자원 정책 | IAM 정책과 조직 계층, 필요한 디렉터리 조회 |

인벤토리 서비스 하나만으로 모든 서비스의 속성·관계·동적 상태를 얻지는 못한다. 각 리소스 타입에 discovery / topology / metrics / policy / diagnostics 지원 여부를 표시하는 지원표가 필요하다.

- Azure Resource Graph는 여러 구독을 조회할 수 있지만 접근 가능한 리소스만 반환한다. 일부 구독의 권한이 없어도 결과가 부분적이라는 경고 없이 반환될 수 있으므로, 온보딩 시 등록한 범위와 실제 수집 성공 범위를 별도 비교한다. [Resource Graph](https://learn.microsoft.com/en-us/azure/governance/resource-graph/overview)
- Azure Event Grid의 해당 이벤트는 ARM 관리 작업을 대상으로 하며 모든 데이터 평면 변경을 의미하지 않는다. 이벤트 수신 후 리소스를 재조회하고 주기적 재수집으로 누락을 보정한다. [이벤트 범위](https://learn.microsoft.com/en-us/azure/event-grid/event-schema-resource-groups)
- AWS Config Aggregator는 여러 계정·리전의 기록된 Config 데이터를 집계한다. 소스의 기록 설정·지원 리소스·비용을 확인하며, 미설정 환경에서는 서비스별 API 수집으로 시작할 수 있다. [Config 집계](https://docs.aws.amazon.com/organizations/latest/userguide/services-that-can-integrate-config.html), [변경 이벤트](https://docs.aws.amazon.com/config/latest/developerguide/monitor-config-with-cloudwatchevents.html)
- GCP Cloud Asset Inventory는 최종 일관성 기반이며 엄격한 실시간 조회를 위한 서비스가 아니다. 관계 데이터 API는 공식 문서상 Security Command Center Premium/Enterprise 조건이 있으므로, 필요한 기본 관계는 리소스 참조 ID를 이용해 직접 구성하는 방안도 준비한다. [인벤토리](https://docs.cloud.google.com/asset-inventory/docs/asset-inventory-overview), [관계 데이터](https://docs.cloud.google.com/asset-inventory/docs/relationship-types), [Feed](https://docs.cloud.google.com/asset-inventory/docs/monitor-asset-changes)
- Azure 신규 구현은 VNet Flow Logs를 기준으로 한다. NSG Flow Logs는 신규 생성이 중단되었고 2027-09-30 폐지 예정이다. [공식 이전 안내](https://learn.microsoft.com/en-us/azure/network-watcher/nsg-flow-logs-migrate)

## Azure 구독과 전용선 화면

구독은 관리·권한 범위이며 네트워크 경계가 아니다. 네트워크 화면에서는 구독이 다른 리소스도 같은 경로에 표시하고 소유 구독을 라벨로 유지한다. 구독 필터를 걸어도 외부 구독의 의존 리소스를 축약해서 남겨야 전용선 경로가 끊겨 보이지 않는다.

다음 두 패턴을 구분한다.

1. 공유 ExpressRoute Circuit → 각 구독의 Connection → 각 VNet Gateway → VNet. 구독마다 별도 게이트웨이로 공유 회선에 연결한다.
2. 공유 ExpressRoute Circuit → Hub의 Connection / VNet Gateway → Hub VNet → gateway transit이 설정된 peering → 다른 구독의 Spoke VNet. Spoke가 Hub의 원격 게이트웨이를 이용한다.

Virtual WAN을 사용하면 vHub·ExpressRoute gateway·VNet connection·라우팅 테이블을 별도 모델로 지원해야 한다. 두 패턴 모두 구성상 관계를 나타내며, 실제 패킷 경로는 유효 경로와 정책 확인 후 표시한다. 모든 경로에 Azure Firewall이 존재한다고 가정해서는 안 된다.

회선 선택 시 보여줄 내용:

- 소유 구독, 회선·게이트웨이·연결 상태와 데이터 수집 시각.
- 직접 연결된 VNet, transit을 사용하는 Spoke, 의존 구독 목록.
- 회선의 구성 대역폭과 관측 트래픽. 구독별 사용량은 별도 귀속 근거가 있을 때만 제공.
- 연결 참조, 양방향 peering 설정, 수집 가능한 BGP/유효 경로.
- 회선 단절 시 영향을 받을 가능성이 있는 자원. 이중화 경로가 있으면 함께 표시하며 실제 장애 영향으로 단정하지 않음.

회선과 원격 구독에 대한 조회 권한이 모두 필요하다. 권한이 없는 참조는 삭제하지 않고 '외부 리소스 / 조회 권한 없음'으로 표시한다. 통신사 망이나 온프레미스 라우터 내부는 CSP API만으로 복원할 수 없으므로 별도 연동 또는 수동 등록 경계가 필요하다. ExpressRoute authorization key 같은 비밀 값은 수집·표시할 필요가 없다.

근거: [구독 간 ExpressRoute 공유](https://learn.microsoft.com/en-us/azure/expressroute/expressroute-howto-linkvnet-portal-resource-manager), [원격 게이트웨이와 gateway transit](https://learn.microsoft.com/en-us/azure/vpn-gateway/vpn-gateway-different-region).

## 네트워크와 IAM을 오해 없이 표현하는 방법

관계 데이터에는 의미와 근거를 함께 저장한다.

- 구성 관계: NIC가 subnet에 연결됨, VNet이 peered 됨, 게이트웨이가 회선에 연결됨.
- 정책 분석: 특정 출발지 → 목적지의 TCP/443이 지원되는 분석 범위에서 허용/차단/미확인.
- 관측 관계: 지정한 시간 구간에 해당 흐름이 로그로 확인됨. 샘플링·로그 범위를 명시.
- 능동 검사: 별도 진단을 수행한 시각과 결과. 관측 로그와도 구분.

NSG·Security Group·IAM 정책은 대상에 적용되는 정책 관계로 표현한다. 실제 경유 장비처럼 선 가운데 배치하지 않는다. '443 허용'만으로 서버가 인터넷에 공개되었다거나 애플리케이션이 응답한다고 판단하지 않는다. NAT, 라우팅, DNS, 반환 경로, 방화벽 적용 지점과 서비스 listener 상태가 다를 수 있다.

초기에는 모든 네트워크 분석기를 직접 구현하기보다 각 CSP 진단 기능을 지원 범위에 맞게 연계한다. AWS Reachability Analyzer는 패킷을 보내지 않는 구성 분석이다. GCP Connectivity Tests는 일부 경로에서만 실제 데이터 평면 검사를 함께 제공하며 외부 네트워크를 모두 이해하지 못한다. CSP 간 종단 경로는 각 구간의 근거를 연결하고 미지원 구간을 명시한다. 진단 생성에는 읽기 조회와 다른 API 권한·비용이 필요할 수 있다. [AWS 분석 방식](https://docs.aws.amazon.com/vpc/latest/reachability/how-reachability-analyzer-works.html), [GCP 분석 범위](https://docs.cloud.google.com/network-intelligence-center/docs/connectivity-tests/concepts/overview)

IAM 첫 버전은 '어떤 사용자/그룹/서비스 계정에 어떤 역할이 어느 범위에서 할당되었는가'에 집중한다. 직접 할당과 상속, 그룹을 통한 할당을 구분한다. Azure RBAC와 Entra 디렉터리 역할은 별개의 범위이고, Microsoft Graph 조회 권한도 별도다. PIM의 eligible 상태를 활성 권한으로 표시해서는 안 된다. AWS에서는 역할 목록만으로 SCP/RCP·permissions boundary·자원 정책·세션 조건을 반영한 실효 권한을 확정할 수 없다. Azure/GCP에서도 조건과 deny 등을 고려해야 한다. [Azure 역할 할당 조회](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest), [Entra 역할](https://learn.microsoft.com/en-us/azure/active-directory/roles/custom-overview), [AWS 정책 평가](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)

## 권장 시스템 구조

```text
CSP 인증·범위 등록
    → 초기 스냅샷 + 변경 이벤트 + 주기적 전체 대조
    → 큐 → CSP별 수집 worker → 정규화·관계 해석
    → 리소스 / 관계 / 정책 / 변경 이력 저장
    → 범위·권한을 적용한 조회 API
    → 목적별 구성도, 자원 상세, 네트워크 경로, IAM 화면

모니터링·로그 API → 요청 시 조회/집계 → 메트릭·트래픽 화면
선택한 그래프 뷰 → 기존 draw.io 모델 변환 → 문서 export worker
```

초기에는 웹 프런트엔드, API 서버, 비동기 worker, 작업 큐, PostgreSQL 정도로 시작할 수 있다. 리소스·관계 테이블과 JSON 속성으로 기본 그래프를 보관하고, 경로 질의가 실제 병목이 될 때 그래프 DB를 평가한다. 모든 원시 로그를 자체 복제하지 않고 기존 모니터링 저장소에서 필요한 시간 구간만 조회하면 초기 비용과 운영 부담을 줄일 수 있다.

도메인 모델은 리소스 ID를 중심으로 하고 화면 좌표와 분리한다. 최소 필드는 provider, tenant/account/subscription/project, native ID, resource type, scope, region, raw properties 참조, source, observedAt, collectedAt, completeness다. 관계는 from/to, kind, evidence, valid time, 판정 상태를 갖는다. 삭제 후 같은 ID가 재사용될 가능성과 수집 지연도 이력 모델에서 처리한다.

관리 계층·물리 배치·네트워크 소속·앱 소속을 하나의 parent 트리에 우겨 넣지 않는다. 예를 들어 Azure RG 소속과 subnet 배치는 독립 관계다. AWS의 subnet/AZ 규칙을 Azure나 GCP에 일괄 적용하지 않는다. 리소스 참조로 확인한 관계와 태그/이름으로 추정한 관계는 분리한다. LLM은 검색·설명에 보조적으로 사용하고 자산·연결·권한의 정본 생성에는 결정적 API 해석을 사용한다.

## 동기화·성능·운영 설계

실시간은 '변경을 지속 반영하는 near-real-time 화면'으로 정의하는 것이 적절하다. 초기 목표 예시는 지원되는 주요 자원의 변경 반영 P95 1~5분, 일정 주기 전체 대조다. 이는 CSP 보장치나 측정 결과가 아니며 PoC 결과로 조정해야 한다. 메트릭·로그·IAM은 각각 다른 갱신 주기를 갖고 화면에 마지막 성공 수집 시각과 지연 상태를 표시한다.

이벤트 중복·역순·누락, API pagination, 429/backoff, 부분 실패, 권한 회수, 일시적 404를 처리한다. API 호출 실패나 빈 결과를 삭제로 오인하지 않도록 수집 범위의 성공 여부를 기록하고 삭제 이벤트 또는 성공한 대조로 확정한다. 전체 스냅샷 도중 발생한 이벤트도 재처리할 수 있게 체크포인트를 남긴다.

수천·수만 리소스는 전체 노드를 동시에 그리는 방식으로 다루지 않는다. 첫 화면은 구독·VNet·전용선 수준의 요약, 확대하면 subnet과 자원, 선택하면 상세 패널로 이어진다. 연결선도 선택 대상 주변과 목적별 레이어로 제한한다. 사용자가 고정한 위치는 저장하고 일부 변경 때문에 전체 그래프가 재배치되지 않게 한다. 예상 실환경 규모의 합성·실제 그래프로 수집량과 화면 성능을 함께 측정한다.

## 연결 권한과 변경 관리

읽기 수집기는 가능한 경우 단기 자격증명·워크로드 신원 연동을 사용한다. AWS AssumeRole, Azure 관리 ID 또는 서비스 주체, GCP 워크로드 신원 연동 등 배포 위치에 맞는 인증 방식을 선택한다. 최초 동의/역할 할당과 이벤트·로그 활성화는 지속적인 읽기 수집 권한과 분리한다. Azure Reader 권한만으로 Event Grid 구독 생성이나 모든 Microsoft Graph 조회가 가능하다고 가정하지 않는다. [Event Grid 구독 권한](https://learn.microsoft.com/en-us/azure/event-grid/security-authorization)

수집 서비스 계정이 넓은 권한을 가져도 모든 포털 사용자가 모든 정보를 보게 해서는 안 된다. 포털의 조회 범위를 명시적으로 정의하고 API·캐시·검색·구성도 export에서 동일하게 적용한다. 고객 간 데이터와 자격증명을 격리하고, 원본 속성/이벤트에 포함된 비밀 값과 불필요한 개인정보는 저장 전에 걸러낸다.

후속 변경 기능은 대상과 변경 전후 차이 → 영향 검토 → 승인된 실행 → 실제 상태 재조회 → 감사 기록의 흐름으로 설계한다. 실행 직전 현재 상태와 권한을 재확인하고 IaC 관리 리소스는 코드 변경 경로와 충돌하지 않게 한다. 네트워크·IAM 변경은 항상 원복할 수 있다고 보장할 수 없으므로 작업별 복구 방법을 정의한다.

## 화면 구성 제안

1. 전체 현황: 연결한 CSP와 범위, 수집 상태, 자원 수, 최근 변경.
2. 아키텍처 탐색: 구독·네트워크·애플리케이션별 보기, 검색, 범위 밖 의존 관계.
3. 리소스 상세: 사양, IP/NIC/디스크, 사용률, 정책, 관련 사용자/역할, 변경 이력, 원본 포털 링크.
4. 네트워크: 전용선·Hub/Spoke·VPN·peering 지도, 흐름별 분석과 관측 시각.
5. IAM: principal → group/role → scope/resource 관계와 할당 근거.

## 개발 단계와 검증 기준

아래 기간은 클라우드 경험이 있는 개발자 2~3명과 운영 담당자의 협업, 테스트 계정·권한의 조기 확보, 지원 리소스 제한을 전제로 한 초기 추정이다. 계약 일정이나 전체 CSP 서비스 지원 약속이 아니다.

| 단계 | 예상 기간 | 산출물 |
|---|---|---|
| Azure 수집 PoC | 2~3주 | 테스트 구독 2~3개, VM/NIC/VNet/subnet/NSG/route/peering/ExpressRoute 관계와 실제 데이터 검증 |
| Azure 운영 MVP | 추가 6~10주 | 구독별 지도, 상세 패널, 전용선 의존 관계, 기본 RBAC 조회, 변경 이력, 수집 상태, SSO·포털 접근 제어 |
| 3사 핵심 자원 확장·운영 강화 | 추가 3~6개월 | AWS/GCP 커넥터, 선택적 메트릭·Flow Logs, 한도·장애 복구·대규모 화면 검증 |
| 실효 권한·변경 실행·광범위 서비스 | 별도 산정 | 지원 정책/서비스 범위 확정 후 설계·검증 |

첫 MVP에서는 온프레미스 내부 자동 복원, 모든 PaaS와 Kubernetes 내부 객체, 전체 IAM 실효 권한 엔진, 모든 방화벽 변경 기능까지 동시에 포함하지 않는다. Kubernetes 내부는 Kubernetes API와 RBAC가 별도로 필요하며, 비용 최적화·정책 자동 교정 등은 추가 제품 범위다.

PoC 통과 기준:

- 등록한 구독과 지원 타입의 자원을 직접 API/포털 기준으로 대조하고 누락 이유를 설명할 수 있음.
- 생성·수정·삭제·권한 제거·구독 간 참조 변화가 잘못된 삭제나 연결로 나타나지 않음.
- ExpressRoute 직접 연결과 Hub transit 예제를 올바르게 구분하고 근거 ID를 추적할 수 있음.
- VM 사양, 정책 포트, 역할 할당이 기준 데이터와 일치하며 미수집 정보는 미확인으로 표시됨.
- 이벤트 누락·API 제한·수집기 재시작 후 전체 대조로 회복됨.
- 사용자별 데이터 접근 제한이 조회·검색·export에서 동일하게 작동함.
- 대상 규모에서 변경 지연 P50/P95, API 요청 수, 화면 탐색 응답, 예상 로그 보관량을 측정함.

비용은 포털 서버보다 Config 기록, 로그 생성·저장·질의, 메트릭 호출, 진단 실행, 보안 상품 구독에 크게 좌우될 수 있다. 자원 수·변경 빈도·로그 GB/일·보존 기간·동시 사용자·CSP별 기능 활성화 현황이 없으므로 현재는 월 비용을 확정하지 않는다.

최초 구현 범위는 'Azure 단일 테넌트의 여러 구독을 읽어 실제 구성도와 공유 전용선 의존 관계를 만들고, 클릭해서 자원·정책·권한 할당을 확인하는 포털'로 잡는 것을 권장한다. 이 단계에서 포털 순회 시간을 얼마나 줄였는지 측정한 뒤 AWS/GCP와 변경 기능의 우선순위를 정한다.
