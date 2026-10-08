const path = require('path');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

const defaultX = Number(process.env.DEFAULT_ORIGIN_X);
const defaultY = Number(process.env.DEFAULT_ORIGIN_Y);

const app = createApp({
  store: new Store(path.join(dataDir, 'state.json')),
  placesFile: process.env.RESTAURANTS_FILE || path.join(__dirname, 'restaurants.json'),
  adminKey: process.env.ADMIN_KEY || 'hs',
  defaultPlaceQuery: process.env.DEFAULT_PLACE_QUERY || '더존을지타워',
  defaultOrigin:
    process.env.DEFAULT_ORIGIN_X && process.env.DEFAULT_ORIGIN_Y && Number.isFinite(defaultX) && Number.isFinite(defaultY)
      ? { x: defaultX, y: defaultY }
      : null,
});

if (!process.env.KAKAO_REST_API_KEY) {
  console.log('KAKAO_REST_API_KEY 없음: restaurants.json에 등록된 가게 목록으로만 후보를 뽑습니다.');
}

app.listen(port, () => {
  console.log(`Eatzy 실행 중: http://localhost:${port}`);
});
