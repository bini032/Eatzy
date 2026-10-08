const crypto = require('crypto');
const kakao = require('./kakao');

const CATEGORIES = [
  { key: 'korean', label: '한식' },
  { key: 'chinese', label: '중식' },
  { key: 'western', label: '양식' },
  { key: 'snack', label: '분식' },
];

const MAX_PAGES = 3; // 카카오 키워드 검색은 최대 45건(15건 x 3페이지)까지 조회 가능

function hasCoords(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.y - a.y);
  const dLng = rad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.y)) * Math.cos(rad(b.y)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 위치를 알 수 없으면 null (거리 표시/반경 필터 생략)
function distanceOrNull(origin, p) {
  return hasCoords(origin) && hasCoords(p) ? Math.round(distanceMeters(origin, p)) : null;
}

// 카카오 검색: 반경 안의 음식점 중 카카오 분류에 해당 카테고리명이 들어간 곳.
// 이용 정책상 검색 결과를 저장하지 않도록 매번 실시간으로 조회한다.
async function kakaoPool(category, origin, radius) {
  const seen = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { places, isEnd } = await kakao.keywordSearch({
      query: category.label,
      x: origin.x,
      y: origin.y,
      radius,
      page,
      food: true,
    });
    for (const p of places) {
      if (p.category.includes(category.label)) seen.set(p.id, p);
    }
    if (isEnd) break;
  }
  return [...seen.values()];
}

// 등록 목록: 좌표가 있는 가게만 반경으로 거르고, 좌표가 없는 가게는 항상 포함.
function listPool(places, category, origin, radius) {
  return places.filter((p) => {
    if (p.category !== category.label) return false;
    const d = distanceOrNull(origin, p);
    return d === null || d <= radius;
  });
}

function randomItem(list) {
  return list[crypto.randomInt(list.length)];
}

// 카테고리마다 한 곳씩 뽑는다.
// - 직전 확정 가게는 같은 카테고리 자리에 다시 노출(위치를 알면 반경 안일 때만)
// - 나머지는 이전에 노출된 적 없는 곳 위주로 랜덤, 다 돌면 기록을 비우고 다시 시작
// poolFor(category) -> Promise<place[]>
async function pickCandidates(state, origin, radius, poolFor) {
  const candidates = [];
  const missing = [];
  const lastWinner = state.lastWinner;

  for (const cat of CATEGORIES) {
    if (lastWinner && lastWinner.categoryKey === cat.key) {
      const d = distanceOrNull(origin, lastWinner);
      if (d === null || d <= radius) {
        candidates.push({ ...stripWinner(lastWinner), distance: d, categoryKey: cat.key, categoryLabel: cat.label, pinned: true });
        continue;
      }
    }

    const pool = (await poolFor(cat)).filter((p) => !lastWinner || p.id !== lastWinner.id);
    if (pool.length === 0) {
      missing.push(cat.label);
      continue;
    }
    let recent = state.recent[cat.key] || [];
    let fresh = pool.filter((p) => !recent.includes(p.id));
    if (fresh.length === 0) {
      recent = [];
      fresh = pool;
    }
    const pick = randomItem(fresh);
    state.recent[cat.key] = [...recent, pick.id];
    candidates.push({
      ...pick,
      distance: distanceOrNull(origin, pick),
      categoryKey: cat.key,
      categoryLabel: cat.label,
      pinned: false,
    });
  }
  return { candidates, missing };
}

function stripWinner(w) {
  const { id, name, category, address, phone, url, naverUrl, naverPlaceId, memo, menus, x, y } = w;
  return { id, name, category, address, phone, url, naverUrl, naverPlaceId, memo, menus, x, y };
}

// 투표 값: { candidateId, menu } (예전 형식인 가게 id 문자열도 허용)
function readVote(v) {
  return typeof v === 'string' ? { candidateId: v, menu: null } : { candidateId: v.candidateId, menu: v.menu || null };
}

function tally(round) {
  const counts = Object.fromEntries(round.candidates.map((c) => [c.id, 0]));
  // 가게별 메뉴 선택 수. 메뉴를 고르지 않은 표는 "" 키로 센다.
  const menuCounts = Object.fromEntries(round.candidates.map((c) => [c.id, {}]));
  for (const raw of Object.values(round.votes)) {
    const { candidateId, menu } = readVote(raw);
    if (!(candidateId in counts)) continue;
    counts[candidateId]++;
    const key = menu || '';
    menuCounts[candidateId][key] = (menuCounts[candidateId][key] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  const top = max > 0 ? round.candidates.filter((c) => counts[c.id] === max).map((c) => c.id) : [];

  let leaderId = null;
  if (top.length === 1) {
    leaderId = top[0];
  } else if (top.length > 1 && round.draw && sameSet(round.draw.tiedIds, top)) {
    leaderId = round.draw.winnerId;
  }
  return {
    counts,
    menuCounts,
    totalVotes: Object.keys(round.votes).length,
    tiedIds: top.length > 1 ? top : [],
    needsDraw: top.length > 1 && leaderId === null,
    leaderId,
  };
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

module.exports = { CATEGORIES, pickCandidates, kakaoPool, listPool, tally, readVote, distanceMeters, hasCoords, randomItem };
