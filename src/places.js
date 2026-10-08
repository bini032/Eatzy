const fs = require('fs');
const crypto = require('crypto');

const LABELS = ['한식', '중식', '양식', '분식'];

// restaurants.json 형식:
// [{ "name": "가게명", "category": "한식|중식|양식|분식",
//    "address": "", "phone": "", "url": "지도 링크", "x": 경도, "y": 위도, "memo": "" }]
// name, category 외에는 선택. x/y가 있으면 기준 위치로부터의 거리와 반경 필터에 쓰인다.
function validatePlaces(list) {
  const places = [];
  const errors = [];
  if (!Array.isArray(list)) return { places, errors: ['최상위는 배열([ ... ])이어야 합니다.'] };

  const ids = new Set();
  list.forEach((raw, i) => {
    const where = `${i + 1}번째 항목`;
    if (!raw || typeof raw !== 'object') return errors.push(`${where}: 객체가 아닙니다.`);
    const name = String(raw.name || '').trim();
    if (!name) return errors.push(`${where}: name이 비어 있습니다.`);
    if (!LABELS.includes(raw.category)) {
      return errors.push(`${where} (${name}): category는 ${LABELS.join('/')} 중 하나여야 합니다.`);
    }
    const hasX = raw.x !== undefined && raw.x !== null && raw.x !== '';
    const hasY = raw.y !== undefined && raw.y !== null && raw.y !== '';
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (hasX !== hasY || (hasX && (!Number.isFinite(x) || !Number.isFinite(y)))) {
      return errors.push(`${where} (${name}): x(경도), y(위도)는 둘 다 숫자로 넣거나 둘 다 비워 두세요.`);
    }
    const address = String(raw.address || '').trim();
    const id = raw.id ? String(raw.id) : 'list-' + crypto.createHash('sha1').update(`${name}|${address}`).digest('hex').slice(0, 12);
    if (ids.has(id)) return errors.push(`${where} (${name}): 중복된 가게입니다.`);
    ids.add(id);

    places.push({
      id,
      name,
      category: raw.category,
      label: raw.category,
      address,
      phone: String(raw.phone || '').trim(),
      url: String(raw.url || '').trim(),
      memo: String(raw.memo || '').trim(),
      x: hasX ? x : null,
      y: hasY ? y : null,
    });
  });
  return { places, errors };
}

// 파일은 매번 다시 읽는다. 서버를 재시작하지 않아도 목록 수정이 바로 반영된다.
function loadPlaces(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { places: [], errors: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { places: [], errors: [`JSON 형식 오류: ${err.message}`] };
  }
  return validatePlaces(parsed);
}

module.exports = { loadPlaces, validatePlaces, LABELS };
