const kakao = require('./kakao');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

// OpenStreetMap Nominatim 역지오코딩 (키 불필요).
// 이용 정책: 식별 가능한 User-Agent, 초당 1건 이하. 위치 갱신 버튼을 누를 때만 호출하므로 충분히 낮다.
async function nominatimReverse(x, y) {
  const url = new URL(NOMINATIM_URL);
  url.search = new URLSearchParams({ format: 'jsonv2', lat: String(y), lon: String(x), zoom: '18', 'accept-language': 'ko' });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Eatzy-lunch-vote/1.0 (https://github.com/bini032/Eatzy)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc || doc.error) return null;

  const a = doc.address || {};
  const city = a.city || a.province || a.state || '';
  const district = a.borough || a.city_district || a.county || '';
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  const address = [city, district, street].filter(Boolean).join(' ') || doc.display_name || '';
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

module.exports = { reverseGeocode };
