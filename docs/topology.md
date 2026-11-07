# 토폴로지: 관계 모델, 경로·정책 분석, 보기

운영자가 VM이나 Pod를 골라 다음 세 가지를 근거와 함께 확인하는 기능입니다.

- 어디에 연결돼 있는가
- 어떤 경로와 정책을 거치는가
- 어떤 신원으로 대상에 접근하는가

이 문서의 모든 판정은 **수집한 구성**을 기준으로 합니다. 관측 통신(흐름 로그)은 아직 연동되지 않았습니다.

## 1. 데이터 모델

### 관계 종류
관계 이름은 이전 버전과의 호환을 위해 기존 다섯 가지를 유지하고, 새 종류는 **추가만** 했습니다. 그래서 스냅샷 버전은 1 그대로이며 기존 스냅샷을 그대로 읽습니다(마이그레이션 불필요).

| 관계 | 의미 | 예 |
|---|---|---|
| `parent` (필드) | 네트워크 위치 | 서브넷 ⊂ VNet, NIC ⊂ 서브넷. VM의 parent는 기본 NIC의 서브넷이며 표시용입니다 |
| `contains` | 논리적 포함 | 클러스터 ⊃ 네임스페이스 ⊃ 워크로드·Service |
| `attachment` (= attached_to) | 연결 | VM–NIC, VM–디스크, 게이트웨이–회선 |
| `peering` (= peers_with) | 피어링 | VNet↔VNet, VPC↔VPC, TGW↔TGW |
| `route` (= routes_to) | 라우트 대상 | 서브넷 → UDR 다음 홉 장비, 서브넷 → 게이트웨이 엔드포인트 |
| `forwards_to` | 전달 | LB 백엔드 풀 → VM, Service → EndpointSlice의 Pod, Ingress → Service |
| `private_link` | Private Link | Private Endpoint → 서비스 본체 |
| `runs_on` | 실행 위치 | Pod → Node, Node → VM (`providerID`) |
| `owns` | 소유 | 워크로드 → Pod (`ownerReferences`, ReplicaSet 경유) |
| `mounts` | 마운트 요청 | Pod → PVC (Pod 명세 기준이며 실제 마운트 상태는 아님) |
| `binds_to` | 바인딩 | PVC → PV, PV → 클라우드 디스크 (CSI `volumeHandle`) |
| `policy` (= policy_applies_to) | 정책 적용 | NSG → 서브넷·NIC, SG → ENI, NACL → 서브넷, NetworkPolicy → Pod |
| `uses_identity` | 실행 신원 | VM → 관리 ID / 인스턴스 프로파일 / 서비스 계정, Pod → ServiceAccount → 클라우드 신원 |
| `role_binding`, `permission_evidence` | 예약 | 역할 할당은 현재 IAM 목록(`iam`)으로 연결합니다 |
| `observed_flow` | 관측 통신 | 실데이터에서는 거부. 관측 소스가 없기 때문입니다 |
| `simulation` | 데모 트래픽 | 실데이터에서는 거부 |

포함 관계는 통신 간선이 아닙니다. 통신 여부는 흐름 분석기(`shared/flow.ts`)만 판정합니다.

### 관계의 근거 필드
- `basis`: 관계가 만들어진 방식
  - `configured`: API에 적힌 그대로
  - `inferred`: Atlas가 계산한 것. 예: UDR 다음 홉 IP를 장비 주소와 맞춘 경우, NetworkPolicy 선택자와 Pod 레이블을 비교한 경우
  - `observed`: 관측된 것. 실데이터에서는 금지됩니다
  - `declared`: 운영자가 직접 등록한 것(`onprem.json`)
  - 이전 스냅샷의 관계에는 이 필드가 없으며, 화면에는 "근거 구분 이전 데이터"로 표시됩니다.
- `evidence`: 관계를 만든 API 필드
- `ref`: 원본 ID
- `note`: 한계 설명. 예: "OS 내부 마운트 여부는 확인할 수 없음"
- 수집 시각은 각 클라우드 연결의 `collectedAt`을 따릅니다.

### 새로 추가한 것
- **자원 종류:** `nic`, `disk`, `fileshare`, `bucket`, `endpoint`, `identity`, `node`, `namespace`, `workload`, `pod`, `k8sservice`, `ingress`, `serviceaccount`, `pvc`, `pv`.
- **자원 필드:**
  - `addresses`: NIC가 가진 모든 IP
  - 라우트: `nextHopIp`, `target`, `priority`, `origin`, `tags`
  - 규칙: `name`, `peers`(SG·ASG·태그·선택자 참조)
  - 정책: `appliesTo`(대상 태그·서비스 계정·Pod 선택자)
  - 그 밖에 `selector`, `netTags`
- **교차 참조(`crossRefs`):** Kubernetes와 클라우드처럼 따로 수집한 대상 사이의 관계입니다. 병합할 때 해결하고, 대상을 찾지 못하면 `unresolved`에 남깁니다. 자원을 지어내지 않습니다.
- **`'firewall'` 종류의 의미:** **보안 정책**입니다(NSG, SG, NACL, VPC 방화벽 규칙, NetworkPolicy). 실제로 패킷이 거치는 장비(Azure Firewall, NVA)는 `'appliance'` 종류입니다.

## 2. 지원 범위

| 항목 | Azure | AWS | GCP | Kubernetes |
|---|---|---|---|---|
| NIC·복수 IP | ✅ 모든 IP 구성, 보조 IP, NIC별 NSG | ✅ 모든 ENI, 보조 IP, ENI별 SG | ✅ 모든 NIC, 별칭 IP, 외부 IP | Pod IP |
| 라우트 선택 | ✅ 최장 접두사, 같으면 UDR 우선. 시스템 경로(VNet·피어링·게이트웨이 전송·기본 인터넷) 포함 | ✅ 최장 접두사, local = VPC CIDR. pcx / tgw / igw / nat / vgw / vpce | ✅ 최장 접두사 → 우선순위. 서브넷 경로, 태그 경로, 피어링 서브넷 경로 | – |
| 경유 장비 | ✅ UDR 다음 홉 IP의 장비만 경로에 넣음. **Azure Firewall 정책 규칙 평가**(네트워크 규칙 우선순위, 기본 거부, 애플리케이션 규칙은 FQDN이라 판단 불가). NVA 내부 정책은 판단 불가 | ⚠️ Network Firewall·GWLB 미수집 | ⚠️ 다음 홉 Instance·ILB는 판단 불가 | – |
| 비전이 피어링 | ✅ | ✅ | ✅ | – |
| 정책 평가 | ✅ NSG: 우선순위, 기본 규칙, VirtualNetwork·Internet·AzureLoadBalancer 태그, **ASG(NIC 구성원)**, **서비스 태그**(규칙이 쓰는 태그만 대역을 수집, 하루 캐시). 대역을 못 읽은 태그는 판단 불가 | ✅ SG(합집합, 상태 기반, SG 참조, **관리형 접두사 목록**: 항목 CIDR, 게이트웨이 엔드포인트로 가는 S3·DynamoDB는 서브넷 경로의 목록 ID), NACL(번호 순, 상태 비저장, 응답 임시 포트) | ✅ VPC 방화벽: 대상 태그·SA, 출발 태그·SA, 우선순위, 같은 우선순위면 거부 우선, 암묵 규칙. 계층형·네트워크 방화벽 정책은 미수집 | ✅ NetworkPolicy: 선택 시 격리, 규칙 합집합, pod·ns·ipBlock 선택자. 엔진 미확인이면 차단을 확정하지 않음 |
| 응답 경로 | ✅ 비대칭(장비 우회) 검출 | ✅ NACL 임시 포트 | 상태 기반 | 상태 기반 |
| 게이트웨이·사내망 | ✅ ER·VPN 게이트웨이, 게이트웨이 전송 | ✅ **TGW 라우트 테이블**(연결·전파·블랙홀, 응답 경로). 다른 계정 소유 TGW는 그 계정을 수집해야 함 | ✅ **Cloud Router 동적 경로**(getRouterStatus). 읽기 실패 시 판단 불가 | – |
| 블록 스토리지 | ✅ 관리 디스크 연결 | ✅ EBS 연결 | ✅ PD (Disk 자산이 있을 때만) | ✅ Pod→PVC→PV→클라우드 디스크 |
| 파일 스토리지 | ❌ Azure Files 공유는 Resource Graph에 없음 | ❌ EFS 미수집 | ❌ Filestore 미수집 | PVC로만 표현 |
| 객체 스토리지 | ✅ 스토리지 계정 + Private Endpoint (서브넷 밖) | ✅ S3 + 게이트웨이 엔드포인트 (ENI 없음) | ✅ GCS 버킷 | – |
| 실행 신원 | ✅ 시스템·사용자 할당 관리 ID, 역할 할당 원본 범위 | ⚠️ 인스턴스 프로파일. 역할 연결 미수집. IRSA 역할 | ✅ 인스턴스 서비스 계정 | ✅ SA, Workload Identity·IRSA 주석, RBAC |
| DNS | ⚠️ PE FQDN은 레코드 존재만 의미. 해석 결과로 쓰지 않음 | ⚠️ 엔드포인트 DNS 이름만 수집 | ❌ | ❌ |
| LB 리스너·백엔드 | ⚠️ 백엔드 풀은 수집하지만 리스너·규칙 경로 분석은 없음 | ⚠️ 대상 그룹. 리스너 미수집 | ⚠️ forwarding rule만 | ✅ Service→EndpointSlice |
| NAT | ✅ NAT Gateway → 공인 IP → 기본 아웃바운드 순 | ✅ NAT·IGW (IGW는 공인 IP 필요) | ✅ **Cloud NAT** 적용 서브넷. 외부 IP도 NAT도 없으면 차단 | – |
| 클라우드 간 경로 | ❌ 판단 불가 | ❌ | ❌ | ❌ (Pod → 클러스터 밖) |
| Gateway API | – | – | – | ❌ 수집하지 않음 |
| 관측 통신 | ❌ 미연동 | ❌ | ❌ | ❌ |

✅ 지원, ⚠️ 부분 지원(나머지는 판단 불가나 '범위 밖'으로 표시), ❌ 미지원.

## 3. 흐름 분석의 판정 규칙
- 결과는 **구성상 허용 / 구성상 차단 / 판단 불가**의 세 가지이고, 관측 통신은 별도로 '미연동'입니다.
- **차단:** 확정적으로 차단한 정책이 하나라도 있거나, 라우트가 없음·버림이 확정되면 차단입니다.
- **판단 불가:**
  - 해석하지 못한 조건이 결정 규칙보다 앞서고, 그 조건이 다른 결과를 낼 수 있을 때. 예외: 그 조건들이 모두 같은 동작(모두 Allow 등)이면 결과가 같으므로 확정합니다.
  - 규칙을 수집하지 않은 경유 장비가 경로에 있을 때
  - 라우트 테이블을 수집하지 않은 TGW를 지날 때
  - BGP 동적 경로가 있을 수 있을 때
  - 엔진이 확인되지 않은 클러스터의 NetworkPolicy가 차단할 때
  - 응답 경로가 비대칭일 때
- **부분 평가:** 범위 밖(사내망, 인터넷 쪽, 서비스 자체 방화벽, 계층형 정책)은 결과를 '부분 평가'로 표시하고 목록에 적습니다.
- **Service·Ingress:** 논리적 전달로 표시하며 패킷 홉이 아닙니다. Service 포트는 targetPort로 변환해 평가합니다.
- **신원·권한:** 역할 할당은 근거로만 보여줍니다. 조건부 할당, 거부 할당, 권한 경계, 조직 정책, 리소스 정책은 '평가하지 않은 항목'으로 표시합니다.
- **CSP 자체 분석 기능:** 연결할 확장 지점은 `analyzeFlow`의 provider 분기입니다. Network Watcher, Reachability Analyzer, Connectivity Tests는 호출하지 않습니다. 비용이 들고 실계정이 필요하기 때문입니다.

## 4. 최소 수집 권한과 연결 절차

### 클라우드 (토폴로지 작업에서 추가된 호출)
- **AWS:** `ec2:DescribeVolumes`, `ec2:DescribeVpcEndpoints`, `ec2:DescribeNetworkAcls`, `ec2:DescribeTransitGatewayRouteTables`, `ec2:GetTransitGatewayRouteTableAssociations`, `ec2:SearchTransitGatewayRoutes`, `ec2:GetManagedPrefixListEntries`(SG 규칙이 쓰는 목록만). 모두 `ReadOnlyAccess`에 포함되며 요금이 없습니다.
- **Azure:** 방화벽 정책마다 `GET {policy}/ruleCollectionGroups`(ARM, `Microsoft.Network/firewallPolicies/ruleCollectionGroups/read`, Reader에 포함). NSG가 서비스 태그를 쓰면 `GET /subscriptions/{id}/providers/Microsoft.Network/locations/{region}/serviceTags`를 하루 한 번 호출합니다(Reader로 가능, 무료). 응답이 수 MB라 규칙이 쓰는 태그만 저장하고, 새로 못 읽으면 이전 목록을 날짜와 함께 씁니다. NIC·디스크·Private Endpoint·관리 ID는 Resource Graph가 이미 반환합니다.
- **GCP:** Cloud Router마다 `routers.getRouterStatus`(`compute.routers.get`, `roles/compute.networkViewer`). Disk·Bucket 자산과 Router의 Cloud NAT 구성은 Asset Inventory에 포함됩니다.

### Kubernetes
`ATLAS_KUBERNETES`에 kubeconfig 컨텍스트와 그 클라우드 클러스터를 대응시킵니다.

```bash
ATLAS_KUBERNETES='[{"context":"aks-platform","provider":"azure","scope":"<구독 ID>","cluster":"<AKS 리소스 ID>","networkPolicyEngine":"azure"}]'
```

- `scope`는 서버의 범위 제한에 쓰이므로 클러스터가 속한 구독·계정·프로젝트여야 합니다.
- `networkPolicyEngine`을 비우면 AKS 수집 값을 사용합니다. 그 값도 없으면 NetworkPolicy가 실제로 강제되는지 확정하지 않습니다.
- 수집기는 `kubectl get <종류> -A -o json`만 실행합니다. 아래 읽기 전용 ClusterRole을 수집 주체에 바인딩하세요. Secret과 ConfigMap은 포함하지 않습니다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: cloud-atlas-reader}
rules:
- apiGroups: [""]
  resources: [nodes, namespaces, pods, services, serviceaccounts, persistentvolumeclaims, persistentvolumes]
  verbs: [get, list]
- apiGroups: [apps]
  resources: [deployments, statefulsets, daemonsets, replicasets]
  verbs: [get, list]
- apiGroups: [discovery.k8s.io]
  resources: [endpointslices]
  verbs: [get, list]
- apiGroups: [networking.k8s.io]
  resources: [ingresses, networkpolicies]
  verbs: [get, list]
- apiGroups: [rbac.authorization.k8s.io]
  resources: [roles, clusterroles, rolebindings, clusterrolebindings]
  verbs: [get, list]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses]
  verbs: [get, list]
```

- 읽지 못한 종류는 경고로 남고, 그 클러스터의 범위가 '일부 누락'으로 표시됩니다.
- 모든 종류를 읽지 못하면 수집 실패로 처리하고, 이전 스냅샷을 유지합니다.

## 5. 실계정 검증 체크리스트 (토폴로지)
[실계정 수집 검증 계획](live-validation.md)에 더해 다음을 확인합니다.

1. NIC 2개 이상이고 NIC별 NSG·SG가 다른 VM: 각 IP에서 출발한 분석이 해당 NIC의 정책을 쓰는지
2. UDR로 방화벽을 경유하는 스포크: 경로에 방화벽이 나오고, 응답 경로 비대칭 경고가 실제 라우팅과 일치하는지
3. 허브를 공유하는 두 스포크(UDR 없음): '차단'이 실제 연결 테스트(Network Watcher·Reachability Analyzer)와 일치하는지
4. Private Endpoint 대상: PE 서브넷의 `privateEndpointNetworkPolicies` 값과 NSG 적용 결과
5. S3 게이트웨이 엔드포인트, 인터페이스 엔드포인트: 라우트 테이블과 엔드포인트가 맞게 대응되는지
6. EKS·GKE 노드의 `providerID`가 수집된 인스턴스와 연결되는지. AKS는 VMSS 인스턴스가 Resources 테이블에 없어 미해결로 남는 것이 정상입니다.
7. CSI `volumeHandle` 형식(Azure Disk·EBS·PD)이 수집된 디스크 ID와 맞는지
8. Workload Identity·IRSA 주석과 실제 페더레이션 구성이 일치하는지(분석기는 주석만 근거로 씀)
9. NetworkPolicy 엔진(Azure NPM·Cilium·Calico, VPC CNI 정책, Dataplane V2) 별로 '강제 적용' 판정이 실제와 맞는지
10. 제한 토큰으로 접속했을 때 그래프·검색·정책·분석·내보내기 모두에 다른 범위의 ID가 없는지

## 6. 사용 방법
- **지도 > 보기:** 네트워크 / Kubernetes / 스토리지 / 보안 정책 / 실행 신원 / 관측 통신 / 변경 비교. 보기와 선택한 자원은 URL(`layer`, `sel`)에 남아 링크로 공유됩니다.
- **보안 정책·스토리지·실행 신원 보기:** 네트워크 배치는 그대로 두고, 클라우드별 열을 옆에 붙입니다. 정책은 경로 위 장비로 그려지지 않습니다.
- **Kubernetes 보기:** 클러스터 → 네임스페이스 → 워크로드 → Pod 순입니다. 워크로드는 접힌 상태로 시작하고, 펼치면 Pod가 보입니다.
- **자원 선택:** 1홉·2홉 이웃만 강조하고 나머지는 흐리게 합니다. 재배치는 하지 않습니다. 의존 관계(Private Link, LB 백엔드, 신원)는 선택했을 때만 선으로 나타납니다.
- **연결선 클릭:** 관계 종류, 근거(구성 수집/추론/수동 등록), 원본 참조, 메모, 수집 시각이 나옵니다.
- **경로 추적:** 출발·목적지(자원 또는 IP), 프로토콜, 포트를 고르면 다음이 나옵니다.
  - 판정, 후보 경로와 홉별 근거
  - 평가한 정책과 결정한 규칙, 응답 경로
  - 확인하지 않은 것 (판정을 막는 것과 범위 밖을 구분)
  - 실행 신원과 역할 할당 근거, 데이터 기준 시각

## 7. 성능 측정
`npx tsx scripts/bench-topology.ts 500 5000`으로 합성 Azure형 자원을 생성해 측정했습니다. 환경은 Apple M4, Node 26이며 ELK는 프로세스 안에서 실행했습니다. 브라우저 렌더링 시간은 측정하지 않았습니다.

| 백엔드 전체 자원 | 생성+검증 | 범위 제한 | 흐름 분석(평균) | 레이아웃 상세 0 | 상세 1 | 상세 2 |
|---|---|---|---|---|---|---|
| 1,075 | 8ms | <1ms | 0.2ms | 42ms · 노드 9 | 20ms · 노드 65 | 36ms · 노드 567 |
| 10,633 | 16ms | 1ms | 1.2ms | 20ms · 노드 65 | 61ms · 노드 569 | 측정 안 함 |

- '노드'는 브라우저가 실제로 그리는 수이고, 백엔드 자원 수와 다릅니다. NIC·디스크·정책은 네트워크 보기에 노드로 그리지 않습니다.
- 합성 데이터는 VNet당 서브넷 8개, 서브넷당 VM 10개인 단순 구조입니다. 실제 환경의 피어링·정책 밀도에서는 수치가 달라집니다.
- **알려진 병목 후보:**
  - `/api/topology`가 스냅샷 전체를 내려보냅니다(1만 자원에서 수 MB).
  - 흐름 분석은 호출할 때마다 인덱스를 새로 만듭니다.
  - 1만 자원을 상세 2로 펼치면 React Flow가 수천 노드를 그려야 합니다. `onlyRenderVisibleElements`는 이미 켜져 있습니다.

## 8. 구현 상태
- **완료:**
  - 관계 모델 확장과 호환 유지
  - Azure·AWS·GCP의 NIC·디스크·엔드포인트·신원 정규화
  - 세 CSP의 라우트·정책 흐름 분석
  - Azure Firewall 정책 규칙, AWS TGW 라우트 테이블, GCP Cloud NAT·BGP 동적 경로 수집과 평가
  - Kubernetes 수집기·정규화·교차 참조, NetworkPolicy 분석
  - 보기 전환과 URL 복원, 선택 홉 강조, 관계 근거 표시
  - 실데이터의 관측·데모 관계 거부
  - 범위 제한 확장(라우트 대상, 교차 참조, K8s 개체)
- **부분 구현:**
  - LB 리스너·규칙 경로 분석
  - DNS 해석 증거
  - AWS 인스턴스 프로파일 → 역할 연결
  - 스토리지 서비스 자체 방화벽과 버킷 정책 평가
  - 신원 권한: 근거만 제시하고 판정하지 않음
- **환경 미연동:** 관측 통신(흐름 로그), CSP 자체 연결 분석, 실계정 검증.
- **미구현:**
  - 파일 스토리지(Azure Files·EFS·Filestore), Gateway API
  - 클라우드 간 경로, Pod → 클러스터 밖 경로
  - AWS Network Firewall·GWLB 규칙 수집, NVA 내부 정책, Azure Firewall 상위 정책 상속(IP 그룹은 수집 시 주소로 펼침)
  - 스냅샷 시점 선택 UI: 비교는 직전 수집 1회분만 가능
  - 서버 측 범위 조회·페이지 처리

## 9. 다음 단계
1. 실계정 검증(5절)과 CSP 자체 연결 분석 결과 비교
2. ~~Azure Firewall 정책, AWS TGW 라우트 테이블, GCP Cloud NAT·동적 경로 수집~~ (완료). ASG 구성원과 IP 그룹도 수집합니다. NSG 서비스 태그와 AWS 관리형 접두사 목록도 대역으로 펼칩니다. 다음 '판단 불가' 원인은 Azure Firewall 상위 정책 상속과 AWS Network Firewall입니다.
3. LB 리스너·규칙 경로와 DNS 해석 증거(Private DNS 영역, Route 53 Resolver)
4. 흐름 로그 연동(NSG/VNet flow logs, VPC Flow Logs, VPC Flow Logs for GCP)으로 관측 통신 상태 추가
5. 이력 스냅샷 시점 선택과 비교 UI
6. 대규모 환경을 위한 서버 측 범위 조회·관계 집계
