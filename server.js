const path = require('path');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

const defaultX = Number(process.env.DEFAULT_ORIGIN_X);
const defaultY = Number(process.env.DEFAULT_ORIGIN_Y);

const app = createApp({
  store: new Store(path.join(dataDir, 'state.json')),
  adminKey: process.env.ADMIN_KEY || 'hs',
  defaultPlaceQuery: process.env.DEFAULT_PLACE_QUERY || '더존을지타워',
  defaultOrigin:
    process.env.DEFAULT_ORIGIN_X && process.env.DEFAULT_ORIGIN_Y && Number.isFinite(defaultX) && Number.isFinite(defaultY)
      ? { x: defaultX, y: defaultY }
      : null,
});

if (!process.env.KAKAO_REST_API_KEY) {
  console.warn('[경고] KAKAO_REST_API_KEY가 없어 맛집 검색이 동작하지 않습니다. README를 참고하세요.');
}

app.listen(port, () => {
  console.log(`Eatzy 실행 중: http://localhost:${port}`);
});
