const crypto = require('crypto');
const kakao = require('./kakao');

const { CATEGORIES } = require('./categories');

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
// 점심 후보로 맞지 않는 카카오 분류·이름 (술집, 코스·고급 위주)
const KAKAO_SKIP = /술집|호프|요리주점|이자카야|와인|칵테일|한정식|오마카세|코스요리|파인다이닝|뷔페/;

// 카카오 분류 -> 세계음식 세부 종류. "음식점 > 일식 > 초밥,롤" -> 일식, "음식점 > 아시아음식 > 베트남음식" -> 베트남
function kakaoCuisine(categoryName, query) {
  const parts = String(categoryName || '').split('>').map((x) => x.trim());
  if (parts[1] === '아시아음식' && parts[2]) return parts[2].replace(/음식$/, '');
  return parts[1] || query;
}

// 카카오 실시간 검색. 세계음식처럼 검색어가 여러 개면 검색어마다 1페이지씩만 본다 (호출 수 절약)
// 카카오에서 온 가게는 source: 'kakao' (다음 후보 찾기 때 결정 기록에서 상세 정보를 지운다)
async function kakaoPool(category, origin, radius) {
  const seen = new Map();
  const pages = category.queries.length > 1 ? 1 : MAX_PAGES;
  for (const query of category.queries) {
    for (let page = 1; page <= pages; page++) {
      const { places, isEnd } = await kakao.keywordSearch({ query, x: origin.x, y: origin.y, radius, page, food: true });
      for (const p of places) {
        if (!p.category.includes(query) || KAKAO_SKIP.test(p.category) || KAKAO_SKIP.test(p.name)) continue;
        const cuisine = category.queries.length > 1 ? kakaoCuisine(p.category, query) : '';
        seen.set(p.id, { ...p, cuisine, source: 'kakao' });
      }
      if (isEnd) break;
    }
  }
  return [...seen.values()];
}

// 저장된 가게 목록 + 카카오 실시간 검색 (같은 이름의 가게는 메뉴가 있는 목록 쪽을 쓴다)
// 카카오가 실패하거나 기준 위치가 없으면 목록만 쓴다
function sameName(a, b) {
  const n = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  const x = n(a);
  const y = n(b);
  return x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y));
}
async function mixedPool(places, category, origin, radius) {
  const list = listPool(places, category, origin, radius);
  if (!hasCoords(origin)) return list;
  try {
    const live = await kakaoPool(category, origin, radius);
    return [...list, ...live.filter((k) => !list.some((p) => sameName(p.name, k.name)))];
  } catch (err) {
    console.warn(`카카오 검색 실패(${category.label}), 저장된 목록으로만 뽑습니다:`, err.message);
    return list;
  }
}

// 카카오에서 온 가게는 다음 후보 찾기 때 상세 정보(주소·전화·좌표·카카오 분류)를 지우고, 투표·통계·별점·다시 보여 주기에
// 쓰는 것(장소 번호, 이름, 카테고리, 세부 종류, 카카오 장소 링크, 표·메뉴 집계)만 남긴다
const KAKAO_DETAIL_FIELDS = ['address', 'phone', 'x', 'y', 'distance', 'category', 'label', 'memo'];
function forgetKakaoDetails(state) {
  const strip = (o) => {
    if (!o || o.source !== 'kakao') return;
    for (const f of KAKAO_DETAIL_FIELDS) delete o[f];
  };
  strip(state.lastWinner);
  for (const h of state.history || []) {
    strip(h.winner);
    for (const c of h.candidates || []) strip(c);
  }
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

// 한 곳 고르기 (left: 고를 수 있는 가게, picked: 같은 카테고리에서 이미 뽑은 가게, recent: 최근에 나온 가게 id)
// 1) 세부 종류(일식, 베트남 …)를 먼저 같은 확률로 고른다. 가게 수가 많은 종류(예: 중식)만 자주 나오지 않게.
//    이미 뽑은 종류는 가능하면 피한다.
// 2) 그 종류 안에서는 최근에 나오지 않은 가게를 고르고, 다 나왔으면 그 종류의 기록만 비우고 다시 시작
function choosePlace(left, picked, recent) {
  const usedCuisines = new Set(picked.map((p) => p.cuisine).filter(Boolean));
  const unused = left.filter((p) => !p.cuisine || !usedCuisines.has(p.cuisine));
  const kindPool = unused.length ? unused : left;
  const kind = randomItem([...new Set(kindPool.map((p) => p.cuisine || ''))]);
  const inKind = kindPool.filter((p) => (p.cuisine || '') === kind);
  let fresh = inKind.filter((p) => !recent.includes(p.id));
  if (fresh.length === 0) {
    const ids = new Set(inKind.map((p) => p.id));
    recent = recent.filter((id) => !ids.has(id));
    fresh = inKind;
  }
  const pick = randomItem(fresh);
  return { pick, recent: [...recent, pick.id] };
}

// 후보 한 곳만 바꾸기: 같은 카테고리에서 지금 후보들과 겹치지 않는 가게를 하나 고른다 (없으면 null)
async function pickReplacement(state, cat, origin, radius, poolFor, { exclude = new Set(), others = [] } = {}) {
  const lastWinner = state.lastWinner;
  const left = (await poolFor(cat)).filter((p) => !exclude.has(p.id) && (!lastWinner || p.id !== lastWinner.id));
  if (!left.length) return null;
  const chosen = choosePlace(left, others, state.recent[cat.key] || []);
  state.recent[cat.key] = chosen.recent;
  return { ...chosen.pick, distance: distanceOrNull(origin, chosen.pick), categoryKey: cat.key, categoryLabel: cat.label, pinned: false };
}

// 카테고리마다 정해진 수(count)만큼 뽑는다 (한식 1, 세계음식 2, 분식 1).
// - 직전 확정 가게는 같은 카테고리 자리에 다시 노출(위치를 알면 반경 안일 때만)
// - 나머지는 세부 종류를 먼저 고른 뒤(종류별 같은 확률) 그 종류에서 이전에 노출된 적 없는 곳 위주로 랜덤, 다 돌면 그 종류 기록을 비우고 다시 시작
// - exclude(가게 id 모음)에 든 가게(별점 기준 미달)는 뽑지도, 다시 노출하지도 않는다
// - includeLast가 false면 직전 확정 가게를 다시 보여 주지 않고, 그 가게는 이번 후보에서 아예 뺀다
// poolFor(category) -> Promise<place[]>
async function pickCandidates(state, origin, radius, poolFor, exclude = new Set(), { includeLast = true } = {}) {
  const candidates = [];
  const missing = [];
  const lastWinner = state.lastWinner;
  const meta = (cat) => ({ categoryKey: cat.key, categoryLabel: cat.label });

  for (const cat of CATEGORIES) {
    let slots = cat.count || 1;
    const picked = [];
    const all = await poolFor(cat);
    if (includeLast && lastWinner && lastWinner.categoryKey === cat.key && !exclude.has(lastWinner.id)) {
      // 카카오에서 온 지난번 가게는 상세 정보를 지웠으므로 이번 카카오 검색 결과에서 다시 찾아 쓴다 (없으면 다시 보여 주지 않음)
      const base = lastWinner.source === 'kakao' ? all.find((p) => p.id === lastWinner.id) : stripWinner(lastWinner);
      const d = base ? distanceOrNull(origin, base) : null;
      if (base && (d === null || d <= radius)) {
        picked.push({ ...base, cuisine: base.cuisine || lastWinner.cuisine, distance: d, ...meta(cat), pinned: true });
        slots--;
      }
    }

    const pool = all.filter((p) => (!lastWinner || p.id !== lastWinner.id) && !exclude.has(p.id));
    let recent = state.recent[cat.key] || [];
    for (let i = 0; i < slots; i++) {
      const left = pool.filter((p) => !picked.some((x) => x.id === p.id));
      if (!left.length) break;
      const chosen = choosePlace(left, picked, recent);
      recent = chosen.recent;
      picked.push({ ...chosen.pick, distance: distanceOrNull(origin, chosen.pick), ...meta(cat), pinned: false });
    }
    state.recent[cat.key] = recent;
    if (!picked.length) missing.push(cat.label);
    candidates.push(...picked);
  }
  return { candidates, missing };
}

function stripWinner(w) {
  const { id, name, category, cuisine, address, phone, url, naverUrl, naverPlaceId, memo, menus, x, y, source } = w;
  return { id, name, category, cuisine, address, phone, url, naverUrl, naverPlaceId, memo, menus, x, y, source };
}

// 투표 값: { candidateId, menus: [...] } (메뉴 여러 개 선택 가능)
// 예전 형식(가게 id 문자열, { menu: '하나' })도 읽을 수 있게 맞춘다
function readVote(v) {
  if (typeof v === 'string') return { candidateId: v, menus: [], name: '' };
  const menus = Array.isArray(v.menus) ? v.menus : v.menu ? [v.menu] : [];
  return { candidateId: v.candidateId, menus, name: v.name || '' };
}

function tally(round) {
  const counts = Object.fromEntries(round.candidates.map((c) => [c.id, 0]));
  // 가게별 메뉴 선택 수(한 사람이 여러 메뉴를 고르면 각각 센다). 메뉴를 고르지 않은 사람은 "" 키로 센다.
  const menuCounts = Object.fromEntries(round.candidates.map((c) => [c.id, {}]));
  for (const raw of Object.values(round.votes)) {
    const { candidateId, menus } = readVote(raw);
    if (!(candidateId in counts)) continue;
    counts[candidateId]++;
    for (const key of menus.length ? menus : ['']) {
      menuCounts[candidateId][key] = (menuCounts[candidateId][key] || 0) + 1;
    }
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

module.exports = { CATEGORIES, pickCandidates, pickReplacement, kakaoPool, mixedPool, forgetKakaoDetails, listPool, tally, readVote, distanceMeters, hasCoords, randomItem };
