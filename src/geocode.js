const kakao = require('./kakao');

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'Eatzy-lunch-vote/1.0 (https://github.com/bini032/Eatzy)';

// Nominatim 이용 정책(초당 1건 이하)을 지키도록 서버 전체에서 호출 간격을 둔다
let nominatimQueue = Promise.resolve();
let lastNominatimAt = 0;
function nominatimFetch(url) {
  const gap = Number(process.env.NOMINATIM_GAP_MS ?? 1100);
  const run = nominatimQueue.then(async () => {
    const wait = lastNominatimAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  nominatimQueue = run.catch(() => {});
  return run;
}

// Nominatim 주소 정보 -> "서울특별시 중구 을지로 100" 형태
function nominatimAddress(doc) {
  const a = doc.address || {};
  const city = a.city || a.province || a.state || '';
  const district = a.borough || a.city_district || a.county || '';
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  return [city, district, street].filter(Boolean).join(' ') || doc.display_name || '';
}

// OpenStreetMap Nominatim 역지오코딩 (키 불필요).
// 이용 정책: 식별 가능한 User-Agent, 초당 1건 이하. 위치 갱신 버튼을 누를 때만 호출하므로 충분히 낮다.
async function nominatimReverse(x, y) {
  const url = new URL(`${NOMINATIM}/reverse`);
  url.search = new URLSearchParams({ format: 'jsonv2', lat: String(y), lon: String(x), zoom: '18', 'accept-language': 'ko' });
  const doc = await nominatimFetch(url);
  if (!doc || doc.error) return null;

  const a = doc.address || {};
  const address = nominatimAddress(doc);
  const place = doc.name || a.building || a.amenity || a.office || '';
  const area = a.quarter || a.neighbourhood || a.suburb || '';
  return {
    name: place || (area ? `${area} 근처` : ''),
    address,
    attribution: '© OpenStreetMap contributors',
  };
}

// 좌표 -> { name, address, attribution }. 카카오 키가 있으면 카카오, 없거나 실패하면 OpenStreetMap.
// 둘 다 실패해도 위치 지정은 되어야 하므로 null을 반환한다.
async function reverseGeocode(x, y) {
  if (process.env.KAKAO_REST_API_KEY) {
    const addr = await kakao.coordToAddress(x, y);
    if (addr) return { name: '', address: addr, attribution: '' };
  }
  try {
    return await nominatimReverse(x, y);
  } catch (err) {
    console.warn('OpenStreetMap 주소 변환 실패:', err.message);
    return null;
  }
}

// 장소 검색(지도에서 위치 지정용): 카카오 키가 있으면 카카오, 없으면 OpenStreetMap. -> { places: [{ id, name, address, x, y }], attribution }
async function searchPlaces(query) {
  if (process.env.KAKAO_REST_API_KEY) {
    const { places } = await kakao.keywordSearch({ query, size: 10 });
    return { places: places.map(({ id, name, address, x, y }) => ({ id, name, address, x, y })), attribution: '' };
  }
  const url = new URL(`${NOMINATIM}/search`);
  url.search = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'kr', limit: '8', addressdetails: '1', 'accept-language': 'ko' });
  const docs = await nominatimFetch(url);
  return {
    places: (Array.isArray(docs) ? docs : [])
      .map((d) => ({
        id: `osm-${d.osm_type}-${d.osm_id}`,
        name: d.name || String(d.display_name || '').split(',')[0].trim(),
        address: nominatimAddress(d),
        x: Number(d.lon),
        y: Number(d.lat),
      }))
      .filter((p) => p.name && Number.isFinite(p.x) && Number.isFinite(p.y)),
    attribution: '© OpenStreetMap contributors',
  };
}

module.exports = { reverseGeocode, searchPlaces };
