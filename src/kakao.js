const { AppError } = require('./errors');

const API_BASE = process.env.KAKAO_API_BASE || 'https://dapi.kakao.com/v2/local'; // 테스트용 가짜 서버로 바꿀 수 있다
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
    // 카카오가 준 오류 내용(예: "App(...) disabled OPEN_MAP_AND_LOCAL service.")을 로그와 안내에 함께 보여 준다
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 200);
    try {
      const body = JSON.parse(text);
      detail = [body.errorType, body.message || body.msg].filter(Boolean).join(': ') || detail;
    } catch {}
    console.warn(`카카오 API 오류 ${res.status} (${endpoint}): ${detail}`);
    throw new AppError(502, '카카오 API 오류 (HTTP {status}): {detail} {hint}', 'kakao_error', { status: res.status, detail, hint: kakaoHint(res.status, detail) });
  }
  return res.json();
}

// 자주 나는 오류의 해결 방법
function kakaoHint(status, detail) {
  if (status === 401) return '→ KAKAO_REST_API_KEY가 "REST API 키"인지 확인해 주세요 (어드민 키·JavaScript 키 아님).';
  if (status === 403 && /OPEN_MAP_AND_LOCAL|disabled/i.test(detail)) return '→ 카카오 개발자 콘솔의 [제품 설정 > 카카오맵]에서 사용 설정을 켜 주세요.';
  if (status === 403) return '→ 카카오 개발자 콘솔에서 카카오맵(로컬) API 사용 권한을 확인해 주세요.';
  if (status === 429) return '→ 카카오 API 호출 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.';
  return '';
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
