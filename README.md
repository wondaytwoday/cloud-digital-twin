# Cloud Atlas

AWS, Azure, GCP의 자원, 네트워크, IAM, 비용을 읽기 전용 API로 수집해 한곳에서 보는 멀티클라우드 운영 포털 프로토타입입니다.

| 화면 | 내용 |
|---|---|
| 개요 > 대시보드 | 핵심 지표, 클라우드별 현황, 우선 조치, 최근 변경 |
| 개요 > 조치 항목 | 전체 조치 목록, 심각도와 영역 필터, 검색 |
| 개요 > 변경 이력 | 직전 수집과 이번 수집의 차이 |
| 인프라 > 토폴로지 | 연결 지도, 경로 추적, 단절 영향 |
| 인프라 > 리소스 | 전체 자원 인벤토리 |
| 인프라 > 네트워크 | 사내망 연결, 피어링, 대역 중복 |
| 보안 > 노출·방화벽 | 공인 노출 후보, 방화벽 규칙 |
| 보안 > IAM | 주체별 역할 할당, 특권, 외부 주체, MFA, 오래된 키 |
| 비용 | 월별 추이, 서비스와 범위별 비용, 급증 항목, CSV |

클라우드와 관리 범위 선택은 모든 화면에 함께 적용됩니다. 조직 계층과 클라우드별 연결 상태는 범위 필터의 `관리 범위 전체 보기`에서 봅니다.

처음 접속하면 연결 가이드가 열리고, 닫으면 목데이터로 전체 화면을 볼 수 있습니다.

> 수집기는 아직 실제 클라우드 계정으로 실행한 적이 없습니다. 기본 실행은 API 응답 형태의 목데이터를 같은 수집·정규화 코드로 보여줍니다.

```bash
npm install
npm run dev
```

## 검증

```bash
npm test
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

e2e는 프로덕션 빌드를 CSP까지 켠 상태로 검사합니다. 이미 받은 Chromium을 쓰려면 `PLAYWRIGHT_CHROMIUM_PATH`에 실행 파일 경로를 지정하세요.

## 실제 데이터로 실행

서버 PC에서 쓰는 클라우드에 로그인한 뒤 실행합니다. 일부만 로그인해도 됩니다.

```bash
az login
```

```bash
aws sso login --profile <프로필> && export AWS_PROFILE=<프로필>
```

```bash
gcloud auth application-default login
```

```bash
npm run live
```

AWS는 `AWS_PROFILE`을 내보낸 **같은 터미널**에서 `npm run live`를 실행해야 합니다. 브라우저에서 http://127.0.0.1:4317 을 엽니다. 나중에 로그인한 클라우드는 화면의 `지금 수집`으로 바로 반영됩니다. 서버가 로그인된 클라우드를 찾아 볼 수 있는 구독, 리전, 프로젝트를 자동으로 수집하고 1시간마다 다시 수집합니다. 화면의 `지금 수집`으로 바로 실행할 수도 있습니다.

권한이 없는 서비스나 범위는 건너뛰고 화면에 `일부 누락`과 이유를 표시합니다. 수집 전체가 실패하면 마지막 성공 스냅샷을 유지합니다.

**인증만으로 되지 않는 것**
- 읽기 권한은 계정에 미리 있어야 합니다. CSP별 절차와 권한은 화면의 `클라우드 연결` 가이드에 있습니다.
- GCP는 Cloud Asset API가 켜져 있어야 하고, 비용은 BigQuery 결제 내보내기가 필요합니다.
- AWS 조직의 다른 계정까지 읽으려면 계정마다 읽기 전용 역할을 만들고 `ATLAS_AWS_ROLE_NAME`에 그 이름을 지정해야 합니다. 지정하지 않으면 로그인한 계정만 수집합니다.
- AWS S3, Lambda 같은 나머지 서비스 목록은 Resource Explorer 인덱스가 켜져 있어야 합니다.
- Cost Explorer와 BigQuery는 조회할 때 요금이 듭니다. 그래서 비용은 기본 하루 한 번만 읽습니다.
- 사내망은 CSP API로 알 수 없어 아래 형식으로 직접 등록합니다.

범위를 좁히거나 서버 없이 한 번만 수집할 수도 있습니다.

```bash
npm run collect
```

```bash
npm run collect -- --provider aws --regions ap-northeast-2
```

| 환경 변수 | 용도 |
|---|---|
| `DATA_MODE` | `mock`(기본) 또는 `live` |
| `SNAPSHOT_DIR` | 스냅샷과 이력 저장 위치 (기본 `data/`) |
| `ACCESS_TOKENS` | 접근 토큰 목록. 형식은 아래 참고 |
| `ATLAS_COLLECT_MINUTES` | 자동 수집 주기(분). 기본 60, 0이면 끔 |
| `ATLAS_AWS_ROLE_NAME` | AWS 계정마다 맡을 읽기 전용 역할 이름. 지정하면 로그인한 역할은 전환만 하고 자원을 직접 읽지 않음 |
| `ATLAS_AWS_ACCOUNTS` | Organizations를 읽지 못할 때의 계정 목록 (`이름=ID,이름=ID`) |
| `ATLAS_GCP_BILLING_TABLE` | BigQuery 결제 내보내기 테이블 (`프로젝트.데이터셋.테이블`) |
| `ATLAS_COST_HOURS` | 비용 조회 주기(시간). 기본 24 |

사내망 경계는 CSP API로 복원할 수 없어 `data/onprem.json`에 직접 등록합니다.

```json
[{"id":"seoul-dc","name":"Seoul DC","region":"Seoul","cidr":"10.0.0.0/12","connects":[{"name":"er-seoul-01","label":"ExpressRoute"}]}]
```

## 접근 제어

실제 데이터 모드는 기본적으로 닫혀 있습니다. `npm run live`처럼 127.0.0.1에만 열 때를 제외하면, `ACCESS_TOKENS`가 없을 때 데이터를 제공하지 않습니다.

```bash
ACCESS_TOKENS='[{"name":"ops","tokenSha256":"<토큰의 sha256>","scopes":["*"]},{"name":"team-a","tokenSha256":"<토큰의 sha256>","scopes":["<구독 또는 계정 ID>"]}]'
```

토큰 원문은 저장하지 않습니다. `scopes`를 제한한 사용자에게는 서버가 해당 범위의 자원만 보냅니다. SSO는 사내 IdP에 맞춰 `server/auth.ts`를 교체해 붙이는 것을 전제로 합니다.

## 저장소

`server/store.ts`의 `SnapshotStore`가 저장소 경계입니다. 지금은 파일 구현만 있어 실제 데이터를 Vercel처럼 파일을 저장할 수 없는 환경에 올리려면 데이터베이스 구현을 추가해야 합니다.

다른 서비스에 이 설계를 적용하려면 [docs/HANDOFF.md](docs/HANDOFF.md)를 보세요.
