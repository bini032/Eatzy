const { AppError } = require('./errors');

const API_BASE = 'https://dapi.kakao.com/v2/local';
const FOOD_GROUP = 'FD6'; // 카카오 카테고리 그룹 코드: 음식점

function apiKey() {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) {
    throw new AppError(503, '서버에 KAKAO_REST_API_KEY가 설정되지 않아 맛집을 검색할 수 없습니다.');
  }
  return key;
}

async function call(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `KakaoAK ${apiKey()}` } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, '카카오 API에 연결하지 못했습니다: {error}', undefined, { error: err.message });
  }
  if (!res.ok) {
    throw new AppError(502, '카카오 API 오류 (HTTP {status})', undefined, { status: res.status });
  }
  return res.json();
}

function toPlace(doc) {
  return {
    id: String(doc.id),
    name: doc.place_name,
    category: doc.category_name || '',
    address: doc.road_address_name || doc.address_name || '',
    phone: doc.phone || '',
    url: doc.place_url || '',
    x: Number(doc.x),
    y: Number(doc.y),
    distance: doc.distance ? Number(doc.distance) : null,
  };
}

async function keywordSearch({ query, x, y, radius, page = 1, size = 15, food = false }) {
  const data = await call('search/keyword.json', {
    query,
    x,
    y,
    radius: x !== undefined ? radius : undefined,
    page,
    size,
    category_group_code: food ? FOOD_GROUP : undefined,
  });
  return {
    places: (data.documents || []).map(toPlace),
    isEnd: data.meta ? Boolean(data.meta.is_end) : true,
  };
}

// 좌표 -> 주소 (현재 위치 이름 표시용). 실패해도 치명적이지 않으므로 null 반환.
async function coordToAddress(x, y) {
  try {
    const data = await call('geo/coord2address.json', { x, y });
    const doc = (data.documents || [])[0];
    if (!doc) return null;
    return (doc.road_address && doc.road_address.address_name) || (doc.address && doc.address.address_name) || null;
  } catch {
    return null;
  }
}

module.exports = { keywordSearch, coordToAddress };
