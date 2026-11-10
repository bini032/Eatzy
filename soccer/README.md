# 축구 전술 보드

축구팀(11:11)의 포지션, 이동 동선, 전략을 정리해 링크로 함께 보는 모바일 브라우저용 앱입니다.

- **보기는 누구나**: 링크만 있으면 전술 목록, 경기장, 재생, 메모, 라인업, 선수단을 볼 수 있습니다. 열어 둔 화면은 5초마다 확인해서 바뀐 내용을 반영합니다.
- **편집은 비밀번호**: 오른쪽 위 “🔒 보기”를 눌러 편집 비밀번호(`EDIT_PASSWORD`)를 넣은 사람(전략 제시자)만 전술 추가·수정·삭제와 선수단 편집을 할 수 있습니다. 같은 IP에서 5번 틀리면 10분 동안 막힙니다.

## 기능

- **선수단**: 등번호, 이름, 주 포지션 (최대 40명)
- **전술**: 제목, 작성자, 전체 메모, 우리/상대 포메이션(4-4-2, 4-3-3, 4-2-3-1, 4-1-4-1, 3-5-2, 3-4-3, 5-3-2), 자리별 선수 배정과 역할 메모
- **경기장**: 우리 팀(파랑, 아래에서 위로 공격) 11명, 상대 팀(빨강) 11명, 공. 손가락으로 끌어서 옮깁니다.
- **동선 그리기**: 달리기(흰 실선), 패스(노란 점선), 드리블(주황 점선). 선수(패스는 공)에서 시작해 그리면 그 선수의 동선이 됩니다.
- **장면**: “+ 장면”은 지금 장면의 동선 끝 위치로 선수와 공을 옮긴 다음 장면을 만듭니다. 장면마다 이름과 설명을 적을 수 있습니다.
- **재생**: 장면 순서대로 선수와 공이 동선을 따라 움직입니다(0.5x/1x/2x). 장면이 하나여도 동선이 있으면 재생됩니다.
- 편집 내용은 1초쯤 뒤에 자동 저장됩니다. 두 사람이 같은 전술을 동시에 고치면 나중에 저장한 쪽에 안내가 뜨고 최신 내용을 다시 불러옵니다.

## 실행

```bash
npm install
npm start      # http://localhost:3000
npm test
```

설정은 `.env` 파일로 합니다(`.env.example` 참고, `.env`는 커밋하지 않음).

| 변수 | 설명 |
|---|---|
| `EDIT_PASSWORD` | 편집 비밀번호. 없으면 기본값 `soccer`이므로 배포할 때 꼭 정하세요. |
| `TEAM_NAME` | 처음 팀 이름(앱의 선수단 탭에서 바꿀 수 있음) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | 있으면 파일 대신 Upstash Redis에 저장 |
| `REDIS_KEY` | Redis 키 이름, 기본 `soccer:state` (Eatzy와 같은 DB를 써도 섞이지 않음) |
| `DATA_DIR` | Redis가 없을 때 `state.json`을 둘 폴더, 기본 `soccer/data` |

## Render에 올리기 (Eatzy와 별도 주소)

Render 대시보드 → **New → Web Service** → 이 저장소 선택 후:

- **Root Directory**: `soccer`
- **Build Command**: `npm ci --omit=dev`
- **Start Command**: `node server.js`
- **Instance Type**: Free
- **Environment**: `EDIT_PASSWORD`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`(Eatzy 서비스와 같은 값을 써도 됨), `REDIS_KEY=soccer:state`

주소는 서비스 이름에 따라 `서비스이름.onrender.com` 형태로 정해집니다. 무료 서비스는 15분 동안 접속이 없으면 잠들고, 다음 첫 접속 때 깨어나는 데 시간이 걸릴 수 있습니다. 데이터는 Upstash에 있어 유지됩니다.

## 구조

- `server.js`: 설정 읽기, 저장소 준비, 서버 시작
- `src/app.js`: API (`GET /api/state`, `GET /api/version`, `POST /api/login`, `PUT /api/team`, `POST/PUT/DELETE /api/strategies`). 편집 요청은 `x-edit-key` 헤더(URL 인코딩한 비밀번호)로 확인
- `src/sanitize.js`: 화면에서 보낸 전술·선수단을 허용된 모양과 크기로 정리
- `src/store.js`: 문서 전체를 메모리에 두고 파일 또는 Upstash Redis에 통째로 저장 (단일 서버 전제)
- `public/formations.js`: 포메이션 프리셋 (서버와 화면 공용). 좌표는 미터 단위 68×105
- `public/app.js`: 화면 전체 (해시 주소 `#/`, `#/roster`, `#/s/전술id/장면번호`)
