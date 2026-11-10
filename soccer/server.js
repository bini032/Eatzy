const path = require('path');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

// .env 파일이 있으면 환경변수로 읽는다
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

// UPSTASH_REDIS_REST_URL/TOKEN이 있으면 파일 대신 Upstash Redis에 저장 (파일이 보존되지 않는 무료 호스팅용)
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, key: process.env.REDIS_KEY || 'soccer:state' }
    : null;
const store = new Store(path.join(dataDir, 'state.json'), { redis, teamName: process.env.TEAM_NAME || '우리 팀' });

if (!process.env.EDIT_PASSWORD) {
  console.log('EDIT_PASSWORD 없음: 편집 비밀번호가 기본값 "soccer"입니다. 배포 전에 꼭 바꾸세요.');
}
const app = createApp({ store, editPassword: process.env.EDIT_PASSWORD || 'soccer' });

store
  .init()
  .then(() => {
    console.log(redis ? '저장소: Upstash Redis' : `저장소: ${path.join(dataDir, 'state.json')}`);
    app.listen(port, () => console.log(`축구 전술 보드 실행 중: http://localhost:${port}`));
  })
  .catch((err) => {
    console.error('저장된 데이터를 불러오지 못해 서버를 시작하지 않습니다:', err.message);
    process.exit(1);
  });

// 배포·재시작 때 보내는 종료 신호: 아직 DB로 보내는 중인 저장을 끝내고 종료한다
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    Promise.race([store.flush(), new Promise((r) => setTimeout(r, 5000))]).finally(() => process.exit(0));
  });
}
