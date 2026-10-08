const path = require('path');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

// .env 파일이 있으면 환경변수로 읽는다 (Windows에서도 같은 방식으로 설정 가능)
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

const defaultX = Number(process.env.DEFAULT_ORIGIN_X);
const defaultY = Number(process.env.DEFAULT_ORIGIN_Y);

// UPSTASH_REDIS_REST_URL/TOKEN이 있으면 파일 대신 Upstash Redis에 저장 (파일이 보존되지 않는 무료 호스팅용)
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, key: process.env.REDIS_KEY || 'eatzy:state' }
    : null;
const store = new Store(path.join(dataDir, 'state.json'), { redis });

const app = createApp({
  store,
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

store
  .init()
  .then(() => {
    console.log(redis ? '저장소: Upstash Redis' : `저장소: ${path.join(dataDir, 'state.json')}`);
    app.listen(port, () => {
      console.log(`Eatzy 실행 중: http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('저장된 데이터를 불러오지 못해 서버를 시작하지 않습니다:', err.message);
    process.exit(1);
  });
