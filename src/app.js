const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { AppError } = require('./errors');
const kakao = require('./kakao');
const { CATEGORIES, pickCandidates, kakaoPool, listPool, tally, readVote, randomItem } = require('./lunch');
const { loadPlaces, validatePlaces, cleanMenus } = require('./places');
const { reverseGeocode } = require('./geocode');
const { buildStats, kstMonth } = require('./stats');

const RADIUS_OPTIONS = [300, 500, 1000, 1500, 2000];
const CLOSED_MESSAGE = '투표가 완료되었습니다! 담당자에게 직접 문의해주세요.';

// 완료된 투표에 투표/메뉴 추가 등을 시도할 때. 화면은 code로 안내 창을 띄운다.
function closedError() {
  return new AppError(409, CLOSED_MESSAGE, 'closed');
}

// 한국 시간 기준 날짜 (YYYY-MM-DD)
function kstDate(value) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function keyMatches(input, expected) {
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function validCoords(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
}

function createApp({ store, adminKey, defaultPlaceQuery, defaultOrigin, placesFile }) {
  const app = express();
  app.use(express.json({ limit: '1mb' })); // 가게 목록 일괄 업로드 때문에 넉넉하게
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const state = () => store.state;

  const kakaoEnabled = () => Boolean(process.env.KAKAO_REST_API_KEY);

  // 가게 후보 출처 우선순위: 저장된 가게 목록(DB) > restaurants.json > 카카오 검색
  function placeSource() {
    const saved = state().places || [];
    if (saved.length) return { type: 'list', origin: 'db', places: saved, errors: [] };
    const list = placesFile ? loadPlaces(placesFile) : { places: [], errors: [] };
    if (list.errors.length) console.warn(`[가게 목록] ${list.errors.length}개 항목 오류:\n- ${list.errors.join('\n- ')}`);
    if (list.places.length) return { type: 'list', origin: 'file', places: list.places, errors: list.errors };
    if (kakaoEnabled()) return { type: 'kakao', origin: null, places: [], errors: list.errors };
    return { type: null, origin: null, places: [], errors: list.errors };
  }

  function requireAdmin(req) {
    const key = req.get('x-admin-key') ?? req.body?.key;
    if (!keyMatches(key, adminKey)) throw new AppError(403, '관리자 키가 올바르지 않습니다.');
  }

  // 저장된 목록이 비어 있으면 restaurants.json을 기준으로 삼는다.
  // (관리자가 한 곳만 추가/수정해도 파일의 나머지 가게가 사라지지 않도록)
  function basePlaces() {
    const s = state();
    if ((s.places || []).length) return s.places;
    return placesFile ? loadPlaces(placesFile).places : [];
  }

  // 관리자 화면용: 앱에서 추가/편집한 메뉴를 반영한 목록
  function savedPlacesView() {
    const s = state();
    return basePlaces().map((p) => ({ ...p, menus: s.menus[p.id] || p.menus || [] }));
  }

  // 기준 위치. 카카오 키도 고정 좌표도 없으면 null (등록 목록 모드에서 거리 계산 생략)
  async function resolveOrigin() {
    if (state().settings.origin) return state().settings.origin;
    let origin;
    if (defaultOrigin) {
      origin = { name: defaultPlaceQuery, x: defaultOrigin.x, y: defaultOrigin.y, source: 'default' };
    } else if (!kakaoEnabled()) {
      return null;
    } else {
      const { places } = await kakao.keywordSearch({ query: defaultPlaceQuery, size: 1 });
      if (!places.length) throw new AppError(502, `기본 위치 "${defaultPlaceQuery}"를 찾지 못했습니다.`);
      origin = { name: places[0].name, address: places[0].address, x: places[0].x, y: places[0].y, source: 'default' };
    }
    state().settings.origin = origin;
    store.save();
    return origin;
  }

  function currentRound(id) {
    const round = state().round;
    if (!round || round.id !== id) throw new AppError(409, '이미 새로운 투표가 시작되었습니다. 화면을 새로고침해 주세요.');
    return round;
  }

  function publicRound(round, voterId) {
    if (!round) return null;
    const t = tally(round);
    return {
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      origin: round.origin,
      radius: round.radius,
      missing: round.missing,
      candidates: round.candidates,
      counts: t.counts,
      menuCounts: t.menuCounts,
      totalVotes: t.totalVotes,
      tiedIds: t.tiedIds,
      needsDraw: t.needsDraw,
      leaderId: t.leaderId,
      draw: round.draw,
      myVote: voterId && round.votes[voterId] ? readVote(round.votes[voterId]) : null,
      winner: round.winner || null,
      finishedAt: round.finishedAt || null,
    };
  }

  // 배포 확인용: 저장소 종류와 가게 목록 상태 (비밀 값은 포함하지 않음)
  app.get('/api/health', (req, res) => {
    const src = placeSource();
    res.json({
      ok: true,
      storage: store.redis ? 'Upstash Redis' : '파일 (재시작하면 기록이 사라질 수 있음)',
      placeSource:
        src.origin === 'db' ? '저장된 가게 목록 (DB)' : src.origin === 'file' ? '가게 목록 파일' : src.type === 'kakao' ? '카카오 검색' : '없음 (가게 등록 필요)',
      placesCount: src.places.length,
    });
  });

  app.get('/api/state', (req, res) => {
    const s = state();
    const src = placeSource();
    res.json({
      source: src.type,
      placesOrigin: src.origin,
      placesCount: src.places.length,
      placesErrors: src.errors.length,
      kakaoEnabled: kakaoEnabled(),
      defaultLocatable: Boolean(defaultOrigin) || kakaoEnabled(),
      categories: CATEGORIES,
      radiusOptions: RADIUS_OPTIONS,
      defaultPlace: defaultPlaceQuery,
      settings: s.settings,
      round: publicRound(s.round, req.query.voter),
      lastWinner: s.lastWinner,
      history: s.history.slice(-10).reverse(),
    });
  });

  // 월간 통계: ?month=YYYY-MM (한국 시간) 또는 all. 기본은 이번 달
  app.get('/api/stats', (req, res) => {
    const q = String(req.query.month || '');
    const month = q === 'all' || /^\d{4}-\d{2}$/.test(q) ? q : kstMonth(Date.now());
    res.json(buildStats(state().history || [], month, CATEGORIES));
  });

  // 위치 지정: 기본 위치(더존을지타워), 브라우저 현재 위치 좌표, 장소 검색 결과
  app.post('/api/location', async (req, res) => {
    const { mode, name, address } = req.body || {};
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    const s = state();

    if (req.body?.radius !== undefined) {
      const radius = Number(req.body.radius);
      if (!RADIUS_OPTIONS.includes(radius)) throw new AppError(400, '지원하지 않는 반경입니다.');
      s.settings.radius = radius;
    }

    if (mode === 'default') {
      s.settings.origin = null;
      await resolveOrigin();
    } else if (mode === 'current') {
      if (!validCoords(x, y)) throw new AppError(400, '좌표가 올바르지 않습니다.');
      const geo = await reverseGeocode(x, y);
      s.settings.origin = {
        name: geo && geo.name ? `${geo.name} (내 위치)` : '내 현재 위치',
        address: (geo && geo.address) || `${y.toFixed(5)}, ${x.toFixed(5)}`,
        attribution: (geo && geo.attribution) || '',
        x,
        y,
        source: 'current',
      };
    } else if (mode === 'place') {
      if (!validCoords(x, y) || !name) throw new AppError(400, '장소 정보가 올바르지 않습니다.');
      s.settings.origin = { name: String(name).slice(0, 80), address: String(address || '').slice(0, 200), x, y, source: 'place' };
    } else if (mode !== undefined) {
      throw new AppError(400, '알 수 없는 위치 지정 방식입니다.');
    }
    store.save();
    res.json({ settings: s.settings });
  });

  app.get('/api/places', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new AppError(400, '검색어를 입력해 주세요.');
    const { places } = await kakao.keywordSearch({ query: q.slice(0, 50), size: 10 });
    res.json({ places });
  });

  // ---------- 가게 목록 관리 (관리자) ----------
  // CLI 업로드(scripts/upload-places.js)와 관리자 화면이 함께 쓴다. 키는 x-admin-key 헤더 또는 body.key
  app.get('/api/admin/places', (req, res) => {
    requireAdmin(req);
    res.json({ places: savedPlacesView() });
  });

  // body: { places: [...], mode: 'merge' | 'replace' }. merge는 같은 가게(이름+주소)면 덮어쓰고 나머지는 추가
  app.post('/api/admin/places', (req, res) => {
    requireAdmin(req);
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
    const { places, errors } = validatePlaces(req.body?.places);
    if (!places.length && (errors.length || mode === 'merge')) {
      throw new AppError(400, errors.length ? `저장할 수 있는 가게가 없습니다. ${errors.slice(0, 5).join(' / ')}` : '저장할 가게가 없습니다.');
    }
    const s = state();
    const byId = new Map(mode === 'replace' ? [] : basePlaces().map((p) => [p.id, p]));
    for (const p of places) {
      byId.set(p.id, p);
      // 앱에서 따로 저장된 메뉴가 있으면 새로 올린 메뉴를 합친다
      if (s.menus[p.id] && p.menus.length) s.menus[p.id] = cleanMenus([...s.menus[p.id], ...p.menus]);
    }
    s.places = [...byId.values()];
    store.save();
    res.json({ saved: places.length, total: s.places.length, errors, places: savedPlacesView() });
  });

  app.delete('/api/admin/places/:id', (req, res) => {
    requireAdmin(req);
    const s = state();
    const base = basePlaces();
    const rest = base.filter((p) => p.id !== req.params.id);
    if (rest.length === base.length) throw new AppError(404, '저장된 목록에 없는 가게입니다.');
    s.places = rest;
    delete s.menus[req.params.id];
    store.save();
    res.json({ places: savedPlacesView() });
  });

  // 맛집 찾기 = 새 투표 시작
  app.post('/api/rounds', async (req, res) => {
    const s = state();
    const active = s.round && s.round.status === 'voting' && Object.keys(s.round.votes).length > 0;
    // 오늘 완료된 결과는 관리자만 새 투표로 넘길 수 있다 (다음 날부터는 누구나 시작 가능)
    const doneToday = s.round && s.round.status === 'done' && kstDate(s.round.finishedAt) === kstDate(Date.now());
    if ((active || doneToday) && !keyMatches(req.body?.key, adminKey)) {
      if (doneToday) throw new AppError(403, CLOSED_MESSAGE, 'closed');
      throw new AppError(403, '이미 투표가 진행 중입니다. 다시 뽑으려면 관리자 키가 필요합니다.');
    }
    const src = placeSource();
    if (!src.type) {
      throw new AppError(503, '가게 목록(restaurants.json)이 비어 있고 KAKAO_REST_API_KEY도 없어 후보를 뽑을 수 없습니다. README를 참고해 가게를 등록해 주세요.');
    }
    const origin = await resolveOrigin();
    const radius = s.settings.radius;
    const poolFor = src.type === 'list' ? async (cat) => listPool(src.places, cat, origin, radius) : (cat) => kakaoPool(cat, origin, radius);
    const { candidates, missing } = await pickCandidates(s, origin, radius, poolFor);
    if (candidates.length === 0) {
      throw new AppError(
        404,
        src.type === 'list'
          ? `등록된 가게 중 반경 ${radius}m 안에 있는 곳이 없습니다. 반경을 넓히거나 위치를 바꿔 보세요.`
          : `반경 ${radius}m 안에서 맛집을 찾지 못했습니다. 반경을 넓히거나 위치를 바꿔 보세요.`
      );
    }
    // 메뉴: 앱에서 입력/추가한 메뉴 > 가게 목록 파일의 메뉴
    for (const c of candidates) {
      c.menus = s.menus[c.id] || c.menus || [];
    }
    s.round = {
      id: crypto.randomUUID(),
      status: 'voting',
      createdAt: new Date().toISOString(),
      source: src.type,
      origin: origin ? { name: origin.name, address: origin.address, x: origin.x, y: origin.y } : null,
      radius,
      candidates,
      missing,
      votes: {},
      draw: null,
    };
    store.save();
    res.status(201).json({ round: publicRound(s.round) });
  });

  app.post('/api/rounds/:id/vote', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    const voterId = String(req.body?.voterId || '');
    const candidateId = req.body?.candidateId;
    const menu = req.body?.menu ? String(req.body.menu) : null;
    if (!/^[\w-]{8,64}$/.test(voterId)) throw new AppError(400, '투표자 정보가 올바르지 않습니다.');
    if (candidateId === null) {
      delete round.votes[voterId];
    } else {
      const candidate = round.candidates.find((c) => c.id === candidateId);
      if (!candidate) throw new AppError(400, '후보에 없는 가게입니다.');
      if (menu && !(candidate.menus || []).includes(menu)) throw new AppError(400, '이 가게 메뉴에 없는 항목입니다.');
      round.votes[voterId] = { candidateId, menu };
    }
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 관리자가 후보 가게의 메뉴를 직접 입력/수정. 다음에 같은 가게가 나와도 이 메뉴를 쓴다.
  app.post('/api/rounds/:id/candidates/:cid/menus', (req, res) => {
    const round = currentRound(req.params.id);
    if (!keyMatches(req.body?.key, adminKey)) throw new AppError(403, '관리자 키가 올바르지 않습니다.');
    if (round.status !== 'voting') throw closedError();
    const candidate = round.candidates.find((c) => c.id === req.params.cid);
    if (!candidate) throw new AppError(404, '후보에 없는 가게입니다.');
    if (!Array.isArray(req.body?.menus)) throw new AppError(400, '메뉴 목록이 올바르지 않습니다.');

    const menus = cleanMenus(req.body.menus);
    const s = state();
    if (menus.length) s.menus[candidate.id] = menus;
    else delete s.menus[candidate.id];
    candidate.menus = menus;
    // 목록에서 빠진 메뉴를 고른 표는 가게 투표만 남기고 메뉴는 미정으로 돌린다.
    for (const [voter, raw] of Object.entries(round.votes)) {
      const v = readVote(raw);
      if (v.candidateId === candidate.id && v.menu && !menus.includes(v.menu)) round.votes[voter] = { ...v, menu: null };
    }
    store.save();
    res.json({ round: publicRound(round, req.body?.voterId) });
  });

  // 누구나 메뉴 하나를 추가하고 바로 그 메뉴로 투표. (수정/삭제는 관리자만 위 API로)
  app.post('/api/rounds/:id/candidates/:cid/menu-items', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    const candidate = round.candidates.find((c) => c.id === req.params.cid);
    if (!candidate) throw new AppError(404, '후보에 없는 가게입니다.');
    const voterId = String(req.body?.voterId || '');
    if (!/^[\w-]{8,64}$/.test(voterId)) throw new AppError(400, '투표자 정보가 올바르지 않습니다.');
    const [menu] = cleanMenus([req.body?.menu ?? '']);
    if (!menu) throw new AppError(400, '메뉴 이름을 입력해 주세요.');

    const current = candidate.menus || [];
    if (!current.includes(menu)) {
      const menus = cleanMenus([...current, menu]);
      if (!menus.includes(menu)) throw new AppError(400, '이 가게에는 메뉴를 더 추가할 수 없습니다.');
      candidate.menus = menus;
      state().menus[candidate.id] = menus;
    }
    round.votes[voterId] = { candidateId: candidate.id, menu };
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 동점일 때 랜덤 뽑기. 같은 동점 상황에서 여러 번 눌러도 결과는 한 번만 정해진다.
  app.post('/api/rounds/:id/draw', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    const t = tally(round);
    if (t.tiedIds.length < 2) throw new AppError(409, '동점인 가게가 없어 랜덤 뽑기가 필요하지 않습니다.');
    if (t.needsDraw) {
      round.draw = { tiedIds: t.tiedIds, winnerId: randomItem(t.tiedIds), at: new Date().toISOString() };
      store.save();
    }
    res.json({ round: publicRound(round, req.body?.voterId) });
  });

  app.post('/api/rounds/:id/complete', (req, res) => {
    const round = currentRound(req.params.id);
    if (!keyMatches(req.body?.key, adminKey)) throw new AppError(403, '관리자 키가 올바르지 않습니다.');
    if (round.status !== 'voting') throw closedError();
    const t = tally(round);
    if (t.totalVotes === 0) throw new AppError(409, '아직 투표가 없습니다.');
    if (t.needsDraw) throw new AppError(409, '동점입니다. 먼저 랜덤 뽑기를 진행해 주세요.');

    const winner = round.candidates.find((c) => c.id === t.leaderId);
    round.status = 'done';
    round.winner = { ...winner, votes: t.counts[winner.id], menuCounts: t.menuCounts[winner.id], byDraw: t.tiedIds.length > 1 };
    round.finishedAt = new Date().toISOString();

    const s = state();
    s.lastWinner = { ...winner, decidedAt: round.finishedAt };
    s.history.push({
      roundId: round.id,
      decidedAt: round.finishedAt,
      winner: round.winner,
      totalVotes: t.totalVotes,
      // 통계용: 후보별 득표
      candidates: round.candidates.map((c) => ({ id: c.id, name: c.name, categoryLabel: c.categoryLabel, votes: t.counts[c.id] || 0 })),
    });
    // 약 2년치 보관 (하루 1회 기준)
    if (s.history.length > 730) s.history = s.history.slice(-730);
    store.save();
    res.json({ round: publicRound(round, req.body?.voterId) });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return app;
}

module.exports = { createApp };
