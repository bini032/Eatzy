// 가게 목록 파일 검사: node scripts/check-places.js [파일경로]
const path = require('path');
const { loadPlaces, LABELS } = require('../src/places');

const file = process.argv[2] || process.env.RESTAURANTS_FILE || path.join(__dirname, '..', 'restaurants.json');
const { places, errors } = loadPlaces(file);

console.log(`파일: ${file}`);
for (const label of LABELS) {
  const n = places.filter((p) => p.category === label).length;
  console.log(`  ${label}: ${n}곳${n === 0 ? '  (이 카테고리는 후보에 나오지 않습니다)' : ''}`);
}
const noCoords = places.filter((p) => p.x === null).length;
if (noCoords) console.log(`  좌표 없는 가게 ${noCoords}곳: 거리 표시와 반경 필터 없이 항상 후보에 포함됩니다.`);
if (errors.length) {
  console.error(`\n오류 ${errors.length}건 (이 항목들은 무시됩니다):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(places.length ? '\n문제 없음' : '\n등록된 가게가 없습니다.');
