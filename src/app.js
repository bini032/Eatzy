const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const { AppError } = require('./errors');
const kakao = require('./kakao');
const { CATEGORIES, pickCandidates, kakaoPool, listPool, tally, readVote, randomItem, distanceMeters, hasCoords } = require('./lunch');
const { loadPlaces, validatePlaces, cleanMenus } = require('./places');
const { reverseGeocode } = require('./geocode');
const { buildStats, kstMonth } = require('./stats');
const { estimateTotal } = require('./price');
const { translate, pickLang } = require('./i18n');
const { defaultState } = require('./store');
const { cleanName, userIdFor } = require('./users');
const { hashPassword, verifyPassword, tooManyFailures, recordFailure, clearFailures } = require('./auth');
const { checkEmbeddable } = require('./frame');
const MAX_SESSIONS_PER_USER = 10;

const MAX_GROUPS = 200;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const MAX_MENUS_PER_VOTE = 10;
const MAX_MANUAL_CANDIDATES = 12;
const ADMIN_NAME = 'sb'; // 이 이름(대소문자 무관)은 관리자 전용

// { voterId: { menus } } -> { 메뉴: 개수 }
function countOrders(orders) {
  const counts = {};
  for (const o of Object.values(orders || {})) {
    for (const m of o.menus) counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
}

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
  // 배포 버전: Render가 넣어 주는 커밋 값(없으면 서버 시작 시각). 화면 파일 주소에 붙여 예전 파일이 캐시되지 않게 한다
  const build = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || Date.now().toString(36);
  const indexHtml = fs
    .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace(/(href|src)="\/(style\.css|i18n\.js|app\.js)"/g, `$1="/$2?v=${build}"`)
    .replace('{{BUILD}}', build);
  // 기본 화면과 그룹 링크(/g/그룹id)는 같은 화면을 쓴다. 화면이 주소에서 그룹 id를 읽어 API에 x-group으로 보낸다
  const sendIndex = (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  };
  app.get(['/', '/index.html', '/g/:id'], sendIndex);
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  // 요청마다 그룹 상태를 고른다. 이후 코드는 state()로 현재 그룹 상태에 접근한다
  const groupCtx = new AsyncLocalStorage();
  const state = () => groupCtx.getStore().state;
  const groupId = () => groupCtx.getStore().id;

  // ---------- 계정과 로그인 ----------
  // 로그인 세션: 화면이 x-session 헤더로 보내는 토큰. DB에는 토큰의 해시만 저장한다
  app.use('/api', (req, res, next) => {
    const token = req.get('x-session');
    const session = token ? store.state.sessions[sha256(token)] : null;
    const user = session ? store.state.users[session.userId] : null;
    req.user = user ? { id: session.userId, name: user.name, super: Boolean(user.super) } : null;
    req.sessionKey = user ? sha256(token) : null;
    next();
  });

  const userView = (u) => (u ? { id: u.id, name: u.name, isSuper: u.super } : null);

  function requireUser(req) {
    if (!req.user) throw new AppError(401, '로그인해 주세요.', 'no_user');
    return req.user;
  }

  // 관리자: 전체 관리자(SB), 이 그룹을 만든 계정, 또는 관리자 키(ADMIN_KEY, 업로드 스크립트용)
  function isAdminReq(req) {
    if (req.user && req.user.super) return true;
    const meta = state().meta;
    if (req.user && meta && meta.ownerId && meta.ownerId === req.user.id) return true;
    return keyMatches(req.get('x-admin-key') ?? req.body?.key, adminKey);
  }

  // 가입 겸 로그인: 처음 쓰는 이름이면 가입, 있는 이름이면 비밀번호 확인.
  // SB는 전체 관리자 계정이다. 처음 만들 때만 관리자 키(ADMIN_KEY)를 확인하고, 이후에는 정한 비밀번호로 로그인한다.
  app.post('/api/auth/login', (req, res) => {
    const name = cleanName(req.body?.name);
    const password = String(req.body?.password ?? '');
    if (!name || !password) throw new AppError(400, '이름과 비밀번호를 입력해 주세요.');
    const id = userIdFor(name);
    const users = store.state.users;
    const failKey = name.toLowerCase();
    if (tooManyFailures(failKey)) throw new AppError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const now = new Date().toISOString();
    let isNew = false;

    const isSb = name.toLowerCase() === ADMIN_NAME;
    if (isSb && !(users[id] && users[id].hash)) {
      // SB 계정 최초 생성: 다른 사람이 먼저 SB를 가져가지 못하게 관리자 키 확인
      if (!keyMatches(req.body?.adminKey, adminKey)) {
        recordFailure(failKey);
        throw new AppError(403, 'SB 계정을 처음 만들 때는 관리자 키가 필요합니다.', 'need_admin_key');
      }
      if (password.length < 4 || password.length > 64) throw new AppError(400, '비밀번호는 4자 이상 64자 이하로 입력해 주세요.');
      users[id] = { name: 'SB', super: true, ...hashPassword(password), createdAt: now, lastSeenAt: now };
      isNew = true;
    } else if (users[id]) {
      if (!verifyPassword(password, users[id].salt, users[id].hash)) {
        recordFailure(failKey);
        throw new AppError(403, '비밀번호가 올바르지 않습니다.');
      }
      users[id].lastSeenAt = now;
    } else {
      if (password.length < 4 || password.length > 64) throw new AppError(400, '비밀번호는 4자 이상 64자 이하로 입력해 주세요.');
      users[id] = { name, ...hashPassword(password), createdAt: now, lastSeenAt: now };
      isNew = true;
    }
    clearFailures(failKey);

    // 새 세션 발급 (계정당 최근 10개만 유지)
    const token = crypto.randomBytes(32).toString('base64url');
    const sessions = store.state.sessions;
    sessions[sha256(token)] = { userId: id, createdAt: now, lastSeenAt: now };
    const mine = Object.entries(sessions).filter(([, s]) => s.userId === id).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))) delete sessions[k];
    store.save();
    res.status(isNew ? 201 : 200).json({ token, user: userView({ id, name: users[id].name, super: Boolean(users[id].super) }), isNew });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionKey) {
      delete store.state.sessions[req.sessionKey];
      store.save();
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: userView(requireUser(req)) });
  });

  // 새 그룹 만들기: 로그인한 계정이 그 그룹의 관리자가 된다 (그룹 미들웨어보다 먼저)
  app.post('/api/groups', (req, res) => {
    const owner = requireUser(req);
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw new AppError(400, '그룹 이름을 입력해 주세요.');
    const groups = store.state.groups;
    if (Object.keys(groups).length > MAX_GROUPS) throw new AppError(429, '그룹을 더 만들 수 없습니다.');
    let id;
    do id = crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    while (id.length < 6 || groups[id]);
    groups[id] = { ...defaultState(), meta: { name, owner: owner.name, ownerId: owner.id, createdAt: new Date().toISOString() } };
    store.save();
    res.status(201).json({ id, name });
  });

  app.use('/api', (req, res, next) => {
    const id = String(req.get('x-group') || req.query.g || 'default');
    const groupState = store.state.groups[id];
    if (!groupState) throw new AppError(404, '그룹을 찾을 수 없습니다.', 'no_group');
    groupCtx.run({ id, state: groupState }, next);
  });

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
    if (!isAdminReq(req)) throw new AppError(403, '관리자 권한이 필요합니다.');
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
      if (!places.length) throw new AppError(502, '기본 위치 "{place}"를 찾지 못했습니다.', undefined, { place: defaultPlaceQuery });
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

  // 투표/주문 요청자: 로그인한 계정. 같은 계정이면 어느 기기에서 들어와도 같은 사람의 표·메뉴로 이어진다.
  function voterFrom(req) {
    const user = requireUser(req);
    return { voterId: user.id, name: user.name };
  }

  // 결정 후 주문(메뉴 선택)이 바뀌면 결과와 통계 기록의 메뉴 집계를 다시 계산한다
  function refreshWinnerOrders(round) {
    const counts = countOrders(round.orders);
    const estimate = estimateTotal(counts);
    Object.assign(round.winner, { menuCounts: counts, estimatedTotal: estimate.total, unknownPriceCount: estimate.unknown });
    const h = state().history.find((x) => x.roundId === round.id);
    if (h) h.winner = round.winner;
  }

  function publicRound(round, voterId) {
    if (!round) return null;
    const t = tally(round);
    // 가게별 투표자 이름과 고른 메뉴 (투표자 id는 내보내지 않는다)
    const voters = Object.fromEntries(round.candidates.map((c) => [c.id, []]));
    for (const raw of Object.values(round.votes)) {
      const v = readVote(raw);
      if (voters[v.candidateId]) voters[v.candidateId].push({ name: v.name, menus: v.menus });
    }
    const orders = round.orders
      ? Object.entries(round.orders).map(([id, o]) => ({ name: o.name, menus: o.menus, mine: id === voterId }))
      : null;
    return {
      id: round.id,
      status: round.status,
      source: round.source,
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
      voters,
      orders,
      myOrder: voterId && round.orders && round.orders[voterId] ? round.orders[voterId].menus : null,
      winner: round.winner || null,
      finishedAt: round.finishedAt || null,
    };
  }

  // 배포 확인용: 저장소 종류와 가게 목록 상태 (비밀 값은 포함하지 않음)
  app.get('/api/health', (req, res) => {
    const src = placeSource();
    res.json({
      ok: true,
      build,
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
      group: { id: groupId(), name: s.meta ? s.meta.name : null, owner: s.meta ? s.meta.owner : null, isDefault: groupId() === 'default' },
      me: req.user ? { ...userView(req.user), isAdmin: isAdminReq(req) } : null,
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
      round: publicRound(s.round, req.user && req.user.id),
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
        name: (geo && geo.name) || '', // 화면에서 "OO (내 위치)" / "내 현재 위치"로 번역해 표시
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
      if (errors.length) throw new AppError(400, '저장할 수 있는 가게가 없습니다. {errors}', undefined, { errors: errors.slice(0, 5).join(' / ') });
      throw new AppError(400, '저장할 가게가 없습니다.');
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
    if ((active || doneToday) && !isAdminReq(req)) {
      if (doneToday) throw new AppError(403, CLOSED_MESSAGE, 'closed');
      throw new AppError(403, '이미 투표가 진행 중입니다. 다시 뽑으려면 관리자 키가 필요합니다.');
    }
    // 직접 고르기: 목록에서 고른 가게(id)와 직접 입력한 가게({ name, category, ... })로 투표를 시작
    if (Array.isArray(req.body?.manual)) {
      s.round = newRound(manualCandidates(req.body.manual), [], null, s.settings.radius, 'manual');
      store.save();
      return res.status(201).json({ round: publicRound(s.round) });
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
          ? '등록된 가게 중 반경 {radius}m 안에 있는 곳이 없습니다. 반경을 넓히거나 위치를 바꿔 보세요.'
          : '반경 {radius}m 안에서 맛집을 찾지 못했습니다. 반경을 넓히거나 위치를 바꿔 보세요.',
        undefined,
        { radius }
      );
    }
    // 메뉴: 앱에서 입력/추가한 메뉴 > 가게 목록 파일의 메뉴
    for (const c of candidates) {
      c.menus = s.menus[c.id] || c.menus || [];
    }
    s.round = newRound(candidates, missing, origin, radius, src.type);
    store.save();
    res.status(201).json({ round: publicRound(s.round) });
  });

  app.post('/api/rounds/:id/vote', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    const { voterId, name } = voterFrom(req);
    const candidateId = req.body?.candidateId;
    // menus: 고른 메뉴 전체 목록 (예전 화면 호환을 위해 menu 하나도 받는다)
    const rawMenus = Array.isArray(req.body?.menus) ? req.body.menus : req.body?.menu ? [req.body.menu] : [];
    const menus = [...new Set(rawMenus.map(String))];
    if (candidateId === null) {
      delete round.votes[voterId];
    } else {
      const candidate = round.candidates.find((c) => c.id === candidateId);
      if (!candidate) throw new AppError(400, '후보에 없는 가게입니다.');
      if (menus.length > MAX_MENUS_PER_VOTE) throw new AppError(400, '메뉴는 {n}개까지 고를 수 있습니다.', undefined, { n: MAX_MENUS_PER_VOTE });
      if (menus.some((m) => !(candidate.menus || []).includes(m))) throw new AppError(400, '이 가게 메뉴에 없는 항목입니다.');
      round.votes[voterId] = { candidateId, menus, name };
    }
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 관리자가 후보 가게의 메뉴를 직접 입력/수정. 다음에 같은 가게가 나와도 이 메뉴를 쓴다.
  app.post('/api/rounds/:id/candidates/:cid/menus', (req, res) => {
    const round = currentRound(req.params.id);
    requireAdmin(req);
    const candidate = round.candidates.find((c) => c.id === req.params.cid);
    if (!candidate) throw new AppError(404, '후보에 없는 가게입니다.');
    // 결정 후에는 결정된 가게의 메뉴만 고칠 수 있다
    if (round.status !== 'voting' && !(round.winner && round.winner.id === candidate.id)) throw closedError();
    if (!Array.isArray(req.body?.menus)) throw new AppError(400, '메뉴 목록이 올바르지 않습니다.');

    const menus = cleanMenus(req.body.menus);
    const s = state();
    if (menus.length) s.menus[candidate.id] = menus;
    else delete s.menus[candidate.id];
    candidate.menus = menus;
    // 목록에서 빠진 메뉴를 고른 표는 가게 투표만 남기고 메뉴는 미정으로 돌린다.
    for (const [voter, raw] of Object.entries(round.votes)) {
      const v = readVote(raw);
      if (v.candidateId === candidate.id) round.votes[voter] = { ...v, menus: v.menus.filter((m) => menus.includes(m)) };
    }
    if (round.winner && round.winner.id === candidate.id) {
      round.winner.menus = menus;
      for (const o of Object.values(round.orders || {})) o.menus = o.menus.filter((m) => menus.includes(m));
      refreshWinnerOrders(round);
    }
    store.save();
    res.json({ round: publicRound(round, req.user && req.user.id) });
  });

  // 누구나 메뉴 하나를 추가하고 바로 그 메뉴를 내 선택에 넣는다. (수정/삭제는 관리자만 위 API로)
  // 결정 후에는 결정된 가게에 메뉴를 추가하고 내 주문에 넣는다.
  app.post('/api/rounds/:id/candidates/:cid/menu-items', (req, res) => {
    const round = currentRound(req.params.id);
    const candidate = round.candidates.find((c) => c.id === req.params.cid);
    if (!candidate) throw new AppError(404, '후보에 없는 가게입니다.');
    const ordering = round.status === 'done';
    if (ordering && !(round.winner && round.winner.id === candidate.id)) throw closedError();
    const { voterId, name } = voterFrom(req);
    const [menu] = cleanMenus([req.body?.menu ?? '']);
    if (!menu) throw new AppError(400, '메뉴 이름을 입력해 주세요.');

    const current = candidate.menus || [];
    if (!current.includes(menu)) {
      const menus = cleanMenus([...current, menu]);
      if (!menus.includes(menu)) throw new AppError(400, '이 가게에는 메뉴를 더 추가할 수 없습니다.');
      candidate.menus = menus;
      state().menus[candidate.id] = menus;
      if (ordering) round.winner.menus = menus;
    }
    if (ordering) {
      const prevOrder = round.orders[voterId] ? round.orders[voterId].menus.filter((m) => m !== menu) : [];
      round.orders[voterId] = { name, menus: [...prevOrder, menu].slice(-MAX_MENUS_PER_VOTE) };
      refreshWinnerOrders(round);
      store.save();
      return res.json({ round: publicRound(round, voterId) });
    }
    // 같은 가게에 이미 투표했다면 고른 메뉴에 추가, 아니면 이 가게 + 이 메뉴로 투표
    const prev = round.votes[voterId] ? readVote(round.votes[voterId]) : null;
    const kept = prev && prev.candidateId === candidate.id ? prev.menus.filter((m) => m !== menu) : [];
    round.votes[voterId] = { candidateId: candidate.id, menus: [...kept, menu].slice(-MAX_MENUS_PER_VOTE), name };
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  function newRound(candidates, missing, origin, radius, source) {
    return {
      id: crypto.randomUUID(),
      status: 'voting',
      createdAt: new Date().toISOString(),
      source,
      origin: origin ? { name: origin.name, address: origin.address, source: origin.source, x: origin.x, y: origin.y } : null,
      radius,
      candidates,
      missing,
      votes: {},
      draw: null,
    };
  }

  function manualCandidates(items) {
    if (!items.length) throw new AppError(400, '가게를 한 곳 이상 골라 주세요.');
    if (items.length > MAX_MANUAL_CANDIDATES) throw new AppError(400, '가게는 {n}곳까지 고를 수 있습니다.', undefined, { n: MAX_MANUAL_CANDIDATES });
    const s = state();
    const known = new Map(basePlaces().map((p) => [p.id, p]));
    const added = [];
    const picked = new Map();
    for (const item of items) {
      let place = item && item.id && known.get(String(item.id));
      if (!place) {
        const { places } = validatePlaces([{ name: item && item.name, category: item && item.category, address: item && item.address, menus: item && item.menus }]);
        if (!places.length) throw new AppError(400, '직접 입력한 가게 정보가 올바르지 않습니다.');
        place = known.get(places[0].id) || places[0];
        if (!known.has(place.id)) {
          known.set(place.id, place);
          added.push(place);
        }
      }
      picked.set(place.id, place);
    }
    // 직접 입력한 가게는 저장 목록에 넣어 다음에도 검색할 수 있게 한다
    if (added.length) s.places = [...basePlaces(), ...added];
    const origin = s.settings.origin;
    return [...picked.values()].map((p) => {
      const cat = CATEGORIES.find((c) => c.label === p.category);
      return {
        ...p,
        menus: s.menus[p.id] || p.menus || [],
        distance: hasCoords(origin) && hasCoords(p) ? Math.round(distanceMeters(origin, p)) : null,
        categoryKey: cat.key,
        categoryLabel: cat.label,
        pinned: false,
      };
    });
  }

  // 직접 고르기 화면용 가게 목록 (저장 목록, 없으면 restaurants.json)
  app.get('/api/place-list', (req, res) => {
    const s = state();
    res.json({
      places: basePlaces().map((p) => ({ id: p.id, name: p.name, category: p.category, address: p.address, menus: (s.menus[p.id] || p.menus || []).length })),
    });
  });

  // 결정 후 메뉴 고르기: 투표를 안 했거나 다른 가게에 투표한 사람도 결정된 가게의 메뉴를 고르고 바꿀 수 있다.
  app.post('/api/rounds/:id/order', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'done' || !round.winner) throw new AppError(409, '아직 가게가 결정되지 않았습니다.');
    const { voterId, name } = voterFrom(req);
    const menus = [...new Set((Array.isArray(req.body?.menus) ? req.body.menus : []).map(String))];
    if (menus.length > MAX_MENUS_PER_VOTE) throw new AppError(400, '메뉴는 {n}개까지 고를 수 있습니다.', undefined, { n: MAX_MENUS_PER_VOTE });
    if (menus.some((m) => !(round.winner.menus || []).includes(m))) throw new AppError(400, '이 가게 메뉴에 없는 항목입니다.');
    round.orders = round.orders || {};
    if (menus.length) round.orders[voterId] = { name, menus };
    else delete round.orders[voterId];
    refreshWinnerOrders(round);
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 가게 정보 링크를 화면 안에 띄울 수 있는지 확인. 아무 주소나 대신 요청하지 않도록 이 그룹 가게의 링크만 받는다
  app.get('/api/frame-check', async (req, res) => {
    const url = String(req.query.url || '');
    const s = state();
    const places = [...basePlaces(), ...((s.round && s.round.candidates) || []), ...(s.round && s.round.winner ? [s.round.winner] : [])];
    const known = new Set();
    for (const p of places) {
      if (p.url) known.add(p.url);
      if (p.naverPlaceId) known.add(`https://m.place.naver.com/restaurant/${encodeURIComponent(p.naverPlaceId)}/menu/list`);
    }
    if (!/^https?:\/\//.test(url) || !known.has(url)) throw new AppError(400, '확인할 수 없는 링크입니다.');
    res.json({ url, embeddable: await checkEmbeddable(url) });
  });

  // 전체 현황 (SB 전용): 모든 그룹의 진행 상황과 이번 달 통합 통계
  app.get('/api/admin/overview', (req, res) => {
    if (!(req.user && req.user.super)) throw new AppError(403, '전체 관리자(SB)만 볼 수 있습니다.');
    const month = kstMonth(Date.now());
    const totals = { groups: 0, users: Object.keys(store.state.users).length, decisions: 0, votes: 0 };
    const restaurants = new Map();
    const groups = Object.entries(store.state.groups).map(([id, g]) => {
      const st = buildStats(g.history || [], month, CATEGORIES);
      const members = new Set();
      for (const h of g.history || []) for (const v of h.voters || []) members.add(v.name.toLowerCase());
      for (const raw of Object.values((g.round && g.round.votes) || {})) {
        const v = readVote(raw);
        if (v.name) members.add(v.name.toLowerCase());
      }
      const last = (g.history || []).at(-1);
      totals.groups++;
      totals.decisions += st.summary.decisions;
      totals.votes += st.summary.totalVotes;
      for (const r of st.restaurants) {
        const cur = restaurants.get(r.name) || { name: r.name, category: r.category, count: 0 };
        cur.count += r.count;
        restaurants.set(r.name, cur);
      }
      const round = g.round;
      return {
        id,
        name: g.meta ? g.meta.name : null,
        owner: g.meta ? g.meta.owner : null,
        isDefault: id === 'default',
        createdAt: g.meta ? g.meta.createdAt : null,
        members: members.size,
        decisionsThisMonth: st.summary.decisions,
        decisionsTotal: (g.history || []).length,
        lastDecision: last ? { name: last.winner.name, at: last.decidedAt } : null,
        round: round ? { status: round.status, votes: Object.keys(round.votes || {}).length, winner: round.winner ? round.winner.name : null } : null,
      };
    });
    groups.sort((a, b) => (b.isDefault - a.isDefault) || String(b.lastDecision?.at || b.createdAt || '').localeCompare(String(a.lastDecision?.at || a.createdAt || '')));
    res.json({
      month,
      totals,
      groups,
      topRestaurants: [...restaurants.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    });
  });

  // 관리자 키 확인 (화면에서 SB로 등록할 때)
  app.get('/api/admin/check', (req, res) => {
    requireAdmin(req);
    res.json({ ok: true });
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
    res.json({ round: publicRound(round, req.user && req.user.id) });
  });

  app.post('/api/rounds/:id/complete', (req, res) => {
    const round = currentRound(req.params.id);
    requireAdmin(req);
    if (round.status !== 'voting') throw closedError();
    const t = tally(round);
    if (t.totalVotes === 0) throw new AppError(409, '아직 투표가 없습니다.');
    if (t.needsDraw) throw new AppError(409, '동점입니다. 먼저 랜덤 뽑기를 진행해 주세요.');

    const winner = round.candidates.find((c) => c.id === t.leaderId);
    round.status = 'done';
    // 결정된 가게에 투표한 사람의 메뉴로 주문 목록을 시작한다. 이후 누구나 결과 화면에서 메뉴를 고르거나 바꿀 수 있다.
    round.orders = {};
    for (const [id, raw] of Object.entries(round.votes)) {
      const v = readVote(raw);
      if (v.candidateId === winner.id && v.menus.length) round.orders[id] = { name: v.name, menus: v.menus };
    }
    const estimate = estimateTotal(t.menuCounts[winner.id]);
    round.winner = {
      ...winner,
      votes: t.counts[winner.id],
      menuCounts: t.menuCounts[winner.id],
      estimatedTotal: estimate.total,
      unknownPriceCount: estimate.unknown,
      byDraw: t.tiedIds.length > 1,
    };
    round.finishedAt = new Date().toISOString();

    const s = state();
    s.lastWinner = { ...winner, decidedAt: round.finishedAt };
    s.history.push({
      roundId: round.id,
      decidedAt: round.finishedAt,
      winner: round.winner,
      totalVotes: t.totalVotes,
      // 통계용: 후보별 득표, 투표자별 선택(선택 적중 랭킹)
      candidates: round.candidates.map((c) => ({ id: c.id, name: c.name, categoryLabel: c.categoryLabel, votes: t.counts[c.id] || 0 })),
      voters: Object.values(round.votes)
        .map(readVote)
        .filter((v) => v.name)
        .map((v) => ({ name: v.name, candidateId: v.candidateId })),
    });
    // 약 2년치 보관 (하루 1회 기준)
    if (s.history.length > 730) s.history = s.history.slice(-730);
    store.save();
    res.json({ round: publicRound(round, req.user && req.user.id) });
  });

  // 화면이 보낸 언어(x-lang)로 안내 메시지를 번역한다
  const msg = (req, text, params) => translate(text, pickLang(req.get('x-lang')), params);

  app.use('/api', (req, res) => res.status(404).json({ error: msg(req, '존재하지 않는 API입니다.') }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: msg(req, err.message, err.params), code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: msg(req, '요청 형식이 올바르지 않습니다.') });
    console.error(err);
    res.status(500).json({ error: msg(req, '서버 오류가 발생했습니다.') });
  });

  return app;
}

module.exports = { createApp };
