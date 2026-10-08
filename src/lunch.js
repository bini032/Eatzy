const crypto = require('crypto');
const kakao = require('./kakao');

const CATEGORIES = [
  { key: 'korean', label: '한식' },
  { key: 'chinese', label: '중식' },
  { key: 'western', label: '양식' },
  { key: 'snack', label: '분식' },
];

const MAX_PAGES = 3; // 카카오 키워드 검색은 최대 45건(15건 x 3페이지)까지 조회 가능
const POOL_TTL_MS = 6 * 60 * 60 * 1000;
const poolCache = new Map();

function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.y - a.y);
  const dLng = rad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.y)) * Math.cos(rad(b.y)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 카테고리별 후보 풀: 반경 안의 음식점 중 카카오 분류에 해당 카테고리명이 들어간 곳.
async function categoryPool(category, origin, radius) {
  const cacheKey = `${category.key}|${origin.x.toFixed(5)}|${origin.y.toFixed(5)}|${radius}`;
  const cached = poolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.places;

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
  const places = [...seen.values()];
  poolCache.set(cacheKey, { at: Date.now(), places });
  return places;
}

function randomItem(list) {
  return list[crypto.randomInt(list.length)];
}

// 카테고리마다 한 곳씩 뽑는다.
// - 직전 확정 가게는 같은 카테고리 자리에 다시 노출(현재 위치 반경 안일 때만)
// - 나머지는 이전에 노출된 적 없는 곳 위주로 랜덤, 다 돌면 기록을 비우고 다시 시작
async function pickCandidates(state, origin, radius) {
  const candidates = [];
  const missing = [];
  const lastWinner = state.lastWinner;

  for (const cat of CATEGORIES) {
    if (
      lastWinner &&
      lastWinner.categoryKey === cat.key &&
      distanceMeters(origin, lastWinner) <= radius
    ) {
      candidates.push({ ...stripWinner(lastWinner), categoryKey: cat.key, categoryLabel: cat.label, pinned: true });
      continue;
    }

    const pool = (await categoryPool(cat, origin, radius)).filter((p) => !lastWinner || p.id !== lastWinner.id);
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
      distance: Math.round(distanceMeters(origin, pick)),
      categoryKey: cat.key,
      categoryLabel: cat.label,
      pinned: false,
    });
  }

  for (const c of candidates) {
    if (c.pinned) c.distance = Math.round(distanceMeters(origin, c));
  }
  return { candidates, missing };
}

function stripWinner(w) {
  const { id, name, category, address, phone, url, x, y } = w;
  return { id, name, category, address, phone, url, x, y };
}

function tally(round) {
  const counts = Object.fromEntries(round.candidates.map((c) => [c.id, 0]));
  for (const candidateId of Object.values(round.votes)) {
    if (candidateId in counts) counts[candidateId]++;
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
    totalVotes: Object.keys(round.votes).length,
    tiedIds: top.length > 1 ? top : [],
    needsDraw: top.length > 1 && leaderId === null,
    leaderId,
  };
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

module.exports = { CATEGORIES, pickCandidates, tally, distanceMeters, randomItem, poolCache };
