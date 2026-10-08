// 가게 목록을 배포된 앱의 DB에 올린다. PC의 Claude Code(CLI)가 목록을 만든 뒤 실행하는 용도.
//
//   npm run upload-places                 # restaurants.json을 기존 목록에 병합
//   npm run upload-places -- --replace    # 기존 목록을 지우고 이 파일로 교체
//   npm run upload-places -- my-list.json
//
// 필요한 설정(.env 또는 환경변수): EATZY_URL=https://….onrender.com, ADMIN_KEY=관리자 키
const fs = require('fs');
const path = require('path');
const { loadPlaces } = require('../src/places');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'restaurants.json'));
  const baseUrl = (process.env.EATZY_URL || '').replace(/\/+$/, '');
  const key = process.env.ADMIN_KEY;

  if (!baseUrl) throw new Error('EATZY_URL이 없습니다. .env에 EATZY_URL=https://…onrender.com 을 넣어 주세요.');
  if (!key) throw new Error('ADMIN_KEY가 없습니다. .env에 ADMIN_KEY=관리자 키 를 넣어 주세요.');
  if (!fs.existsSync(file)) throw new Error(`파일이 없습니다: ${file}`);

  const { places, errors } = loadPlaces(file);
  if (errors.length) {
    console.error(`형식 오류 ${errors.length}건 (이 항목은 올리지 않습니다):`);
    for (const e of errors) console.error(`  - ${e}`);
  }
  if (!places.length) throw new Error('올릴 가게가 없습니다.');

  console.log(`${places.length}곳을 ${baseUrl} 에 ${replace ? '교체' : '병합'} 업로드합니다. (무료 서버가 잠들어 있으면 1분 정도 걸릴 수 있습니다)`);
  const res = await fetch(`${baseUrl}/api/admin/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ mode: replace ? 'replace' : 'merge', places }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  console.log(`완료: ${body.saved}곳 저장, 현재 저장된 가게 ${body.total}곳`);
}

main().catch((err) => {
  console.error('업로드 실패:', err.message);
  process.exit(1);
});
