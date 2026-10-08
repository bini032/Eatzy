# Eatzy

점심 가게 후보를 뽑아 링크로 다같이 투표하는 Node.js(Express) 앱. 사용자 안내 문서는 `README.md`이며 기능, 설정, 배포 방법은 그쪽을 기준으로 한다.

## 명령

- `npm install`: 의존성 설치 (express 하나)
- `npm start`: 서버 실행, 기본 http://localhost:3000
- `npm test`: 테스트 (node:test, 외부 API는 가짜 응답)
- `npm run check-places`: `restaurants.json` 형식 검사와 카테고리별 개수 출력

설정은 `.env` 파일로 한다(`.env.example` 참고). `.env`는 커밋하지 않는다.

## 가게 목록(`restaurants.json`) 채우기

사용자는 이 PC에서 가게 목록을 만들고, 고른 가게를 `restaurants.json`에 저장해 공유하려고 한다. 형식은 README의 "가게 목록 파일 형식"을 따른다.

- 가게 정보를 지어내지 않는다. 이름, 주소, 전화, 좌표는 확인한 출처가 있는 것만 넣고, 확인하지 못한 항목은 비워 둔다.
- 후보를 찾으면 먼저 표로 보여 주고(이름, 카테고리, 주소, 출처 링크), 사용자가 고른 것만 파일에 저장한다.
- 카테고리는 `한식`, `중식`, `양식`, `분식` 중 하나만 쓴다. 카테고리마다 최소 몇 곳씩은 있어야 매번 다른 곳이 나온다.
- 카카오맵, 네이버 지도 등의 검색 결과를 옮겨 적을 때는 해당 서비스의 이용 정책상 저장이 허용되는지 사용자에게 상기시킨다.
- 저장 후에는 `npm run check-places`를 실행해 오류가 없는지 확인한다.

## 공유 링크 만들기

README의 "다른 사람들에게 링크로 공유하기"를 따른다.

- A(이 PC에서 실행): `npm start` 후 `cloudflared tunnel --url http://localhost:3000`. cloudflared 설치나 회사 보안 정책 확인이 필요하면 사용자에게 먼저 묻는다.
- B(클라우드): Render 등은 사용자 본인 계정으로 로그인해야 한다. 로그인, 가입, 결제 단계는 사용자가 직접 하도록 안내한다.

## 구조 메모

- 상태는 `DATA_DIR/state.json` 하나에 저장된다(단일 서버 전제).
- 후보 출처는 `restaurants.json`에 가게가 있으면 목록, 없고 `KAKAO_REST_API_KEY`가 있으면 카카오 실시간 검색이다(`src/app.js`의 `placeSource`).
- 관리자 키 기본값은 `hs`이고 `ADMIN_KEY`로 바꾼다. 키를 화면 코드에 넣지 않는다.
