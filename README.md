# Cloud Atlas

AWS, Azure, GCP 자원을 읽기 전용 API로 수집해 조직 계층과 네트워크 토폴로지로 탐색하는 포털 프로토타입입니다.

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

```bash
npm run collect -- --provider azure --subscriptions <id,id>
```

```bash
npm run collect -- --provider aws --regions ap-northeast-2 --roles network=<role-arn>
```

```bash
npm run collect -- --provider gcp --parent organizations/<org-id>
```

```bash
DATA_MODE=live npm run dev
```

| 환경 변수 | 용도 |
|---|---|
| `DATA_MODE` | `mock`(기본) 또는 `live` |
| `SNAPSHOT_DIR` | 스냅샷과 이력 저장 위치 (기본 `data/`) |
| `ACCESS_TOKENS` | 접근 토큰 목록. 형식은 아래 참고 |

사내망 경계는 CSP API로 복원할 수 없어 `data/onprem.json`에 직접 등록합니다.

```json
[{"id":"seoul-dc","name":"Seoul DC","region":"Seoul","cidr":"10.0.0.0/12","connects":[{"name":"er-seoul-01","label":"ExpressRoute"}]}]
```

## 접근 제어

실제 데이터 모드는 기본적으로 닫혀 있습니다. `npm run dev`처럼 127.0.0.1에만 열 때를 제외하면, `ACCESS_TOKENS`가 없을 때 데이터를 제공하지 않습니다.

```bash
ACCESS_TOKENS='[{"name":"ops","tokenSha256":"<토큰의 sha256>","scopes":["*"]},{"name":"team-a","tokenSha256":"<토큰의 sha256>","scopes":["<구독 또는 계정 ID>"]}]'
```

토큰 원문은 저장하지 않습니다. `scopes`를 제한한 사용자에게는 서버가 해당 범위의 자원만 보냅니다. SSO는 사내 IdP에 맞춰 `server/auth.ts`를 교체해 붙이는 것을 전제로 합니다.

## 저장소

`server/store.ts`의 `SnapshotStore`가 저장소 경계입니다. 지금은 파일 구현만 있어 실제 데이터를 Vercel처럼 파일을 저장할 수 없는 환경에 올리려면 데이터베이스 구현을 추가해야 합니다.

다른 서비스에 이 설계를 적용하려면 [docs/HANDOFF.md](docs/HANDOFF.md)를 보세요.
