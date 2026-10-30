const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const { AppError } = require('./errors');
const kakao = require('./kakao');
const { CATEGORIES, pickCandidates, pickReplacement, kakaoPool, mixedPool, forgetKakaoDetails, listPool, tally, readVote, randomItem, distanceMeters, hasCoords } = require('./lunch');
const { loadPlaces, validatePlaces, cleanMenus } = require('./places');
const { reverseGeocode, searchPlaces, geocodeAddress, cleanAddress } = require('./geocode');
const { buildStats, kstMonth } = require('./stats');
const { estimateTotal } = require('./price');
const { translate, pickLang } = require('./i18n');
const { defaultState } = require('./store');
const { cleanName, userIdFor } = require('./users');
const { hashPassword, verifyPassword, tooManyFailures, recordFailure, clearFailures } = require('./auth');
const { checkEmbeddable } = require('./frame');
const reviews = require('./reviews');
const MAX_SESSIONS_PER_USER = 10;
// 로그인 세션 쿠키: 브라우저 저장소(localStorage)가 지워져도 로그인이 유지되도록 같은 토큰을 HttpOnly 쿠키에도 둔다
const SESSION_COOKIE = 'eatzy_session';
const SESSION_COOKIE_DAYS = 365;
const MAX_MY_GROUPS = 30; // 계정별로 기억하는 최근 그룹 수
const GROUP_TOUCH_MS = 10 * 60 * 1000; // 같은 그룹을 계속 쓰는 동안은 10분에 한 번만 사용 시각을 저장

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

// lockDefaultGroup: 기본 그룹(/)은 입구 화면으로만 쓰고, 투표·설정 같은 변경은 그룹 링크(/g/그룹id)에서만 받는다
function createApp({ store, adminKey, defaultPlaceQuery, defaultOrigin, placesFile, lockDefaultGroup = false }) {
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
  // 헤더(x-session)를 먼저 보고, 없거나 만료된 토큰이면 쿠키를 본다
  const readCookie = (req, name) => {
    for (const part of String(req.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) {
        try {
          return decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  const sessionFor = (token) => {
    const session = token ? store.state.sessions[sha256(token)] : null;
    return session && store.state.users[session.userId] ? session : null;
  };
  const cookieOptions = (req, remember) => ({
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    // 자동 로그인이면 브라우저를 닫아도 남는 쿠키, 아니면 브라우저를 닫으면 지워지는 쿠키
    ...(remember ? { maxAge: SESSION_COOKIE_DAYS * 24 * 60 * 60 * 1000 } : {}),
  });
  app.use('/api', (req, res, next) => {
    const headerToken = req.get('x-session');
    const cookieToken = readCookie(req, SESSION_COOKIE);
    let token = headerToken;
    let session = sessionFor(headerToken);
    if (!session && cookieToken) {
      token = cookieToken;
      session = sessionFor(cookieToken);
    }
    const user = session ? store.state.users[session.userId] : null;
    req.user = user ? { id: session.userId, name: user.name, super: Boolean(user.super) } : null;
    req.sessionKey = user ? sha256(token) : null;
    // 화면에만 토큰이 남아 있고 쿠키가 없어졌으면 쿠키를 다시 넣는다
    if (session && token !== cookieToken) res.cookie(SESSION_COOKIE, token, cookieOptions(req, session.remember !== false));
    next();
  });

  const userView = (u) => (u ? { id: u.id, name: u.name, isSuper: u.super } : null);

  // 계정이 쓴 그룹 (최근 순). 마지막에 쓴 그룹이 맨 앞
  function myGroups(userId) {
    const used = (store.state.users[userId] && store.state.users[userId].groups) || {};
    return Object.entries(used)
      .filter(([id]) => id !== 'default' && store.state.groups[id])
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .map(([id, at]) => ({ id, name: (store.state.groups[id].meta && store.state.groups[id].meta.name) || id, lastUsedAt: at }));
  }
  function touchGroup(userId, id) {
    const user = store.state.users[userId];
    if (!user || id === 'default' || !store.state.groups[id]) return;
    const groups = (user.groups = user.groups || {});
    const now = Date.now();
    if (user.lastGroup === id && groups[id] && now - Date.parse(groups[id]) < GROUP_TOUCH_MS) return;
    groups[id] = new Date(now).toISOString();
    user.lastGroup = id;
    const old = Object.entries(groups).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(MAX_MY_GROUPS);
    for (const [k] of old) delete groups[k];
    store.save();
  }

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
  // SB는 전체 관리자 계정이다. 다른 계정처럼 처음 입력한 비밀번호로 가입되고, 이후에는 그 비밀번호로 로그인한다.
  app.post('/api/auth/login', async (req, res) => {
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
    if (users[id] && users[id].hash) {
      if (!verifyPassword(password, users[id].salt, users[id].hash)) {
        recordFailure(failKey);
        throw new AppError(403, '비밀번호가 올바르지 않습니다.');
      }
      users[id].lastSeenAt = now;
    } else {
      if (password.length < 4 || password.length > 64) throw new AppError(400, '비밀번호는 4자 이상 64자 이하로 입력해 주세요.');
      users[id] = { name: isSb ? 'SB' : name, ...(isSb ? { super: true } : {}), ...hashPassword(password), createdAt: now, lastSeenAt: now };
      isNew = true;
    }
    clearFailures(failKey);

    // 새 세션 발급 (계정당 최근 10개만 유지)
    const token = crypto.randomBytes(32).toString('base64url');
    const remember = req.body?.remember !== false;
    const sessions = store.state.sessions;
    sessions[sha256(token)] = { userId: id, createdAt: now, lastSeenAt: now, remember };
    const mine = Object.entries(sessions).filter(([, s]) => s.userId === id).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))) delete sessions[k];
    store.save();
    await store.flush(); // 응답 전에 DB 저장을 끝내 둔다 (곧바로 서버가 재시작돼도 로그인이 남도록)
    res.cookie(SESSION_COOKIE, token, cookieOptions(req, remember));
    res.status(isNew ? 201 : 200).json({
      token,
      user: userView({ id, name: users[id].name, super: Boolean(users[id].super) }),
      isNew,
      groups: myGroups(id),
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionKey) {
      delete store.state.sessions[req.sessionKey];
      store.save();
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
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
    touchGroup(owner.id, id);
    store.save();
    res.status(201).json({ id, name });
  });

  app.use('/api', (req, res, next) => {
    const id = String(req.get('x-group') || req.query.g || 'default');
    const groupState = store.state.groups[id];
    if (!groupState) throw new AppError(404, '그룹을 찾을 수 없습니다.', 'no_group');
    if (lockDefaultGroup && id === 'default' && req.method !== 'GET') throw new AppError(403, '그룹으로 입장해 주세요.', 'enter_group');
    if (req.user) touchGroup(req.user.id, id); // 마지막에 쓴 그룹 기억 (다음 로그인 때 기본으로 선택)
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
  // optional: 카카오로 기본 위치를 못 찾아도 null로 넘어간다 (등록된 가게 목록으로 뽑을 때는 위치가 없어도 되므로)
  async function resolveOrigin(optional = false) {
    if (state().settings.origin) return state().settings.origin;
    if (optional && !defaultOrigin && kakaoEnabled()) {
      try {
        return await resolveOrigin(false);
      } catch (err) {
        console.warn('기본 위치를 찾지 못해 위치 없이 진행합니다:', err.message);
        return null;
      }
    }
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
      for (const p of v.picks) if (voters[p.candidateId]) voters[p.candidateId].push({ name: v.name, menus: p.menus });
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
    const filter = reviews.ratingFilter(s.settings);
    const src = placeSource();
    res.json({
      group: { id: groupId(), name: s.meta ? s.meta.name : null, owner: s.meta ? s.meta.owner : null, isDefault: groupId() === 'default' },
      me: req.user ? { ...userView(req.user), isAdmin: isAdminReq(req), groups: myGroups(req.user.id) } : null,
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
      ratings: reviews.ratingSummary(s.reviews, filter, req.user && req.user.id),
      ratingFilter: filter,
      ratingOptions: { minRating: reviews.MIN_RATING_OPTIONS, minReviews: reviews.MIN_REVIEWS_OPTIONS },
    });
  });

  // 월간 통계: ?month=YYYY-MM (한국 시간) 또는 all. 기본은 이번 달
  app.get('/api/stats', (req, res) => {
    const q = String(req.query.month || '');
    const month = q === 'all' || /^\d{4}-\d{2}$/.test(q) ? q : kstMonth(Date.now());
    const s = state();
    res.json({ ...buildStats(s.history || [], month, CATEGORIES), ratings: reviews.buildRatingStats(s.reviews, month, reviews.ratingFilter(s.settings)) });
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
    } else if (mode === 'current' || mode === 'map') {
      // 내 현재 위치 또는 지도에서 누른 지점: 좌표로 주변 이름과 주소를 찾아 둔다
      if (!validCoords(x, y)) throw new AppError(400, '좌표가 올바르지 않습니다.');
      const geo = await reverseGeocode(x, y);
      s.settings.origin = {
        name: (geo && geo.name) || '', // 화면에서 "OO (내 위치)" / "내 현재 위치"로 번역해 표시
        address: (geo && geo.address) || `${y.toFixed(5)}, ${x.toFixed(5)}`,
        attribution: (geo && geo.attribution) || '',
        x,
        y,
        source: mode,
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
    try {
      res.json(await searchPlaces(q.slice(0, 50)));
    } catch (err) {
      console.warn('장소 검색 실패:', err.message);
      throw new AppError(502, '장소 검색에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });

  // ---------- 가게 목록 관리 (관리자) ----------
  // CLI 업로드(scripts/upload-places.js)와 관리자 화면이 함께 쓴다. 키는 x-admin-key 헤더 또는 body.key
  // 기본 목록(restaurants.json)에는 있는데 이 그룹의 저장 목록(DB)에는 없는 가게
  // (그룹 목록이 한 번 DB에 저장되면 이후 파일에 추가한 가게는 자동으로 들어오지 않으므로 관리자가 가져온다)
  function fileOnlyPlaces() {
    const s = state();
    if (!(s.places || []).length || !placesFile) return [];
    const have = new Set(s.places.map((p) => p.id));
    return loadPlaces(placesFile).places.filter((p) => !have.has(p.id));
  }

  app.get('/api/admin/places', (req, res) => {
    requireAdmin(req);
    res.json({ places: savedPlacesView(), fileOnly: fileOnlyPlaces().length });
  });

  // 기본 목록의 새 가게를 이 그룹 목록에 추가 (이미 있는 가게는 건드리지 않음)
  app.post('/api/admin/places/import-file', (req, res) => {
    requireAdmin(req);
    const s = state();
    const add = fileOnlyPlaces();
    if (add.length) {
      s.places = [...s.places, ...add];
      store.save();
    }
    res.json({ added: add.length, places: savedPlacesView(), fileOnly: 0 });
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
    const before = new Map(basePlaces().map((p) => [p.id, p]));
    const byId = new Map(mode === 'replace' ? [] : before);
    for (const p of places) {
      // 새로 올린 항목에 좌표가 없으면 앱에서 채워 둔 좌표를 유지한다 (파일을 다시 올려도 좌표가 지워지지 않게)
      const old = before.get(p.id);
      if (old && !hasCoords(p) && hasCoords(old)) Object.assign(p, { x: old.x, y: old.y, coordSource: old.coordSource || '' });
      byId.set(p.id, p);
      // 앱에서 따로 저장된 메뉴가 있으면 새로 올린 메뉴를 합친다
      if (s.menus[p.id] && p.menus.length) s.menus[p.id] = cleanMenus([...s.menus[p.id], ...p.menus]);
    }
    s.places = [...byId.values()];
    store.save();
    res.json({ saved: places.length, total: s.places.length, errors, places: savedPlacesView() });
  });

  // 카카오 키 점검 (관리자): 브라우저에서 /api/admin/kakao-check 를 열면 결과를 보여 준다 (로그인 쿠키로 인증)
  app.get('/api/admin/kakao-check', async (req, res) => {
    requireAdmin(req);
    if (!kakaoEnabled()) return res.json({ ok: false, keySet: false, error: msg(req, '서버에 KAKAO_REST_API_KEY가 설정되지 않아 맛집을 검색할 수 없습니다.') });
    try {
      const { places } = await kakao.keywordSearch({ query: defaultPlaceQuery, size: 3 });
      res.json({ ok: true, keySet: true, query: defaultPlaceQuery, results: places.map((p) => p.name) });
    } catch (err) {
      res.json({ ok: false, keySet: true, error: err instanceof AppError ? msg(req, err.message, err.params) : err.message });
    }
  });

  // ---------- 주소로 좌표 자동 채우기 (관리자) ----------
  // OpenStreetMap Nominatim은 초당 1건까지라 가게가 많으면 1분 가까이 걸린다. 백그라운드로 돌리고 화면은 진행 상황을 조회한다.
  const geocodeJobs = new Map(); // 그룹id -> { running, total, done, found, approx, failed: [이름], startedAt, finishedAt, error }
  const jobView = (id) => geocodeJobs.get(id) || { running: false, total: 0, done: 0, found: 0, approx: 0, failed: [] };

  app.get('/api/admin/geocode', (req, res) => {
    requireAdmin(req);
    res.json(jobView(groupId()));
  });

  app.post('/api/admin/geocode', (req, res) => {
    requireAdmin(req);
    const gid = groupId();
    if (jobView(gid).running) return res.json(jobView(gid));
    const s = state();
    // 파일 목록을 쓰고 있었다면 DB 목록으로 옮겨 좌표를 저장한다
    if (!(s.places || []).length) s.places = basePlaces().map((p) => ({ ...p }));
    const targets = s.places.filter((p) => !hasCoords(p));
    const job = { running: true, total: targets.length, done: 0, found: 0, approx: 0, failed: [], startedAt: new Date().toISOString() };
    geocodeJobs.set(gid, job);
    runGeocode(job, targets.map((p) => ({ id: p.id, name: p.name, address: p.address }))).catch((err) => {
      job.error = err.message;
      job.running = false;
    });
    res.status(202).json(job);
  });

  async function runGeocode(job, targets) {
    const cache = new Map(); // 같은 주소(같은 건물의 여러 가게)는 한 번만 찾는다
    for (const t of targets) {
      try {
        const key = cleanAddress(t.address).query;
        if (!key) throw new Error('no address');
        if (!cache.has(key)) cache.set(key, await geocodeAddress(t.address));
        const r = cache.get(key);
        // 그사이 목록이 바뀌었을 수 있으니 현재 목록에서 다시 찾아 좌표가 비어 있을 때만 넣는다
        const cur = (state().places || []).find((p) => p.id === t.id);
        if (r && cur && !hasCoords(cur)) {
          Object.assign(cur, { x: r.x, y: r.y, coordSource: r.precise ? 'osm' : 'osm-street' });
          job.found++;
          if (!r.precise) job.approx++;
        } else if (!r) {
          job.failed.push(t.name);
        }
      } catch (err) {
        job.failed.push(t.name);
        if (err.message !== 'no address') job.error = err.message;
      }
      job.done++;
      if (job.done % 10 === 0) store.save();
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
    store.save();
  }

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
    // 누구나: 결정이 끝난 다음 날(또는 첫 투표)에 한 번 후보 찾기.
    // 관리자만: 투표가 시작된 뒤 다시 찾기, 오늘 결정된 결과를 새 투표로 넘기기
    const voting = s.round && s.round.status === 'voting';
    const doneToday = s.round && s.round.status === 'done' && kstDate(s.round.finishedAt) === kstDate(Date.now());
    if ((voting || doneToday) && !isAdminReq(req)) {
      if (doneToday) throw new AppError(403, CLOSED_MESSAGE, 'closed');
      throw new AppError(403, '이미 후보가 정해져 투표 중입니다. 후보 다시 찾기는 관리자만 할 수 있습니다.', 'voting');
    }
    // 새 후보를 찾을 때마다 지난 결정 기록에 남은 카카오 가게의 상세 정보를 지운다 (투표·통계에 쓰는 것만 남김)
    forgetKakaoDetails(s);
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
    const origin = await resolveOrigin(src.type === 'list');
    const radius = s.settings.radius;
    // 저장된 목록이 있으면 카카오 실시간 검색 결과를 섞는다 (화면에서 끌 수 있음, 카카오 키가 있을 때만)
    const mixKakao = src.type === 'list' && kakaoEnabled() && req.body?.includeKakao !== false;
    const poolFor = poolForSource(mixKakao ? 'mixed' : src.type, src, origin, radius);
    // 별점 기준 미달 가게는 자동 후보에서 뺀다 (직접 고르기는 그대로 허용)
    const exclude = reviews.excludedIds(s.reviews, reviews.ratingFilter(s.settings));
    // includeLast: 지난번 결정 가게를 후보에 다시 넣을지 (화면에서 고름, 기본 넣음)
    const includeLast = req.body?.includeLast !== false;
    const { candidates, missing } = await pickCandidates(s, origin, radius, poolFor, exclude, { includeLast });
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
    s.round = newRound(candidates, missing, origin, radius, mixKakao ? 'mixed' : src.type);
    store.save();
    res.status(201).json({ round: publicRound(s.round) });
  });

  // 후보 한 곳만 바꾸기 (관리자, 투표 중): 같은 카테고리의 다른 가게로 바꾸고 그 후보에 들어온 표는 취소한다
  app.post('/api/rounds/:id/candidates/:cid/replace', async (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    requireAdmin(req);
    const idx = round.candidates.findIndex((c) => c.id === req.params.cid);
    if (idx < 0) throw new AppError(404, '후보를 찾을 수 없습니다.');
    const old = round.candidates[idx];
    const s = state();
    let next;
    if (req.body?.placeId || req.body?.place) {
      // 직접 고르기: 목록의 가게(placeId) 또는 직접 입력한 가게({ name, category, cuisine })
      const item = req.body.placeId ? { id: String(req.body.placeId) } : req.body.place;
      if (item.id && !basePlaces().some((p) => p.id === item.id)) throw new AppError(404, '저장된 목록에 없는 가게입니다.');
      [next] = manualCandidates([item]);
      if (round.candidates.some((c, i) => i !== idx && c.id === next.id)) throw new AppError(409, '이미 후보에 있는 가게입니다.');
    } else {
      // 랜덤: 같은 카테고리에서 지금 후보들과 겹치지 않는 가게
      const cat = CATEGORIES.find((c) => c.key === old.categoryKey) || CATEGORIES.find((c) => c.label === old.categoryLabel);
      const src = placeSource();
      if (!cat || !src.type) throw new AppError(409, '바꿀 수 있는 다른 가게가 없습니다.');
      const origin = round.origin;
      const radius = round.radius || s.settings.radius;
      // 이번 투표가 카카오를 섞어 뽑은 것이면 바꿀 때도 섞는다
      const poolFor = poolForSource(round.source === 'mixed' && src.type === 'list' && kakaoEnabled() ? 'mixed' : src.type, src, origin, radius);
      const exclude = reviews.excludedIds(s.reviews, reviews.ratingFilter(s.settings));
      for (const c of round.candidates) exclude.add(c.id);
      const others = round.candidates.filter((c, i) => i !== idx && c.categoryKey === cat.key);
      next = await pickReplacement(s, cat, origin, radius, poolFor, { exclude, others });
      if (!next) throw new AppError(409, '바꿀 수 있는 다른 가게가 없습니다.');
      next.menus = s.menus[next.id] || next.menus || [];
    }
    round.candidates[idx] = next;
    // 바뀐 후보에 들어온 표는 취소하고, 동점 뽑기 결과도 다시 정하게 한다
    let removed = 0;
    for (const [voter, raw] of Object.entries(round.votes)) {
      const v = readVote(raw);
      const picks = v.picks.filter((p) => p.candidateId !== old.id);
      if (picks.length === v.picks.length) continue;
      removed++;
      if (picks.length) round.votes[voter] = { name: v.name, picks };
      else delete round.votes[voter];
    }
    round.draw = null;
    store.save();
    res.json({ round: publicRound(round, req.user && req.user.id), replaced: { from: old.name, to: next.name, removedVotes: removed } });
  });

  app.post('/api/rounds/:id/vote', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    const { voterId, name } = voterFrom(req);
    const candidateId = req.body?.candidateId;
    // menus: 그 가게에서 고른 메뉴 전체 목록 (예전 화면 호환을 위해 menu 하나도 받는다)
    const rawMenus = Array.isArray(req.body?.menus) ? req.body.menus : req.body?.menu ? [req.body.menu] : [];
    const menus = [...new Set(rawMenus.map(String))];
    // 여러 가게에 투표할 수 있다: candidateId 가게의 표를 넣거나 고치고(remove: true면 그 가게 표만 취소), candidateId가 null이면 내 표 전부 취소
    const prev = round.votes[voterId] ? readVote(round.votes[voterId]).picks : [];
    if (candidateId === null) {
      delete round.votes[voterId];
    } else {
      const candidate = round.candidates.find((c) => c.id === candidateId);
      if (!candidate) throw new AppError(400, '후보에 없는 가게입니다.');
      let picks = prev.filter((p) => p.candidateId !== candidateId);
      if (!req.body?.remove) {
        if (menus.length > MAX_MENUS_PER_VOTE) throw new AppError(400, '메뉴는 {n}개까지 고를 수 있습니다.', undefined, { n: MAX_MENUS_PER_VOTE });
        if (menus.some((m) => !(candidate.menus || []).includes(m))) throw new AppError(400, '이 가게 메뉴에 없는 항목입니다.');
        // 후보 순서대로 둔다
        picks = [...picks, { candidateId, menus }].sort(
          (a, b) => round.candidates.findIndex((c) => c.id === a.candidateId) - round.candidates.findIndex((c) => c.id === b.candidateId)
        );
      }
      if (picks.length) round.votes[voterId] = { name, picks };
      else delete round.votes[voterId];
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
      round.votes[voter] = { name: v.name, picks: v.picks.map((p) => (p.candidateId === candidate.id ? { ...p, menus: p.menus.filter((m) => menus.includes(m)) } : p)) };
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
    // 이 가게에 이미 투표했다면 고른 메뉴에 추가, 아니면 이 가게 표를 하나 더한다 (다른 가게 표는 그대로)
    const prev = round.votes[voterId] ? readVote(round.votes[voterId]).picks : [];
    const mine = prev.find((p) => p.candidateId === candidate.id);
    const kept = mine ? mine.menus.filter((m) => m !== menu) : [];
    const picks = [...prev.filter((p) => p.candidateId !== candidate.id), { candidateId: candidate.id, menus: [...kept, menu].slice(-MAX_MENUS_PER_VOTE) }].sort(
      (a, b) => round.candidates.findIndex((c) => c.id === a.candidateId) - round.candidates.findIndex((c) => c.id === b.candidateId)
    );
    round.votes[voterId] = { name, picks };
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 후보를 뽑을 가게 모음: list(저장 목록), mixed(저장 목록 + 카카오 실시간), kakao(카카오만)
  function poolForSource(type, src, origin, radius) {
    if (type === 'mixed') return (cat) => mixedPool(src.places, cat, origin, radius);
    if (type === 'list') return async (cat) => listPool(src.places, cat, origin, radius);
    return (cat) => kakaoPool(cat, origin, radius);
  }

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
      places: basePlaces().map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        cuisine: p.cuisine || '',
        address: p.address,
        menus: (s.menus[p.id] || p.menus || []).length,
        menuText: (s.menus[p.id] || p.menus || []).join(' '), // 메뉴 이름으로도 검색할 수 있게
        rating: reviews.placeRating(s.reviews[p.id]),
      })),
    });
  });

  // ---------- 후기·별점 ----------
  // 별점을 남길 수 있는 가게: 이 그룹의 가게 목록, 지금 투표 후보, 결정 기록에 있는 가게
  function findPlace(id) {
    const s = state();
    const fromRound = s.round && s.round.candidates.find((c) => c.id === id);
    if (fromRound) return { name: fromRound.name, category: fromRound.categoryLabel || fromRound.category };
    const fromHistory = [...s.history].reverse().find((h) => h.winner && h.winner.id === id);
    if (fromHistory) return { name: fromHistory.winner.name, category: fromHistory.winner.categoryLabel || fromHistory.winner.category };
    const fromList = basePlaces().find((p) => p.id === id);
    if (fromList) return { name: fromList.name, category: fromList.category };
    if (s.reviews[id]) return { name: s.reviews[id].name, category: s.reviews[id].category };
    return null;
  }
  const ratingsView = (req) => reviews.ratingSummary(state().reviews, reviews.ratingFilter(state().settings), req.user && req.user.id);

  // 가게 후기 목록 (최근 순)
  app.get('/api/reviews/:placeId', (req, res) => {
    const entry = state().reviews[req.params.placeId];
    const items = entry ? Object.entries(entry.items) : [];
    res.json({
      rating: reviews.placeRating(entry),
      reviews: items
        .map(([uid, r]) => ({ name: r.name, rating: r.rating, comment: r.comment || '', at: r.at, mine: Boolean(req.user && uid === req.user.id) }))
        .sort((a, b) => b.at.localeCompare(a.at)),
    });
  });

  // 별점 남기기/고치기: 한 사람당 가게마다 하나
  app.post('/api/reviews', (req, res) => {
    const user = requireUser(req);
    const placeId = String(req.body?.placeId || '');
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError(400, '별점은 1~5 사이로 골라 주세요.');
    const place = findPlace(placeId);
    if (!place) throw new AppError(404, '가게를 찾을 수 없습니다.');
    const comment = String(req.body?.comment || '').trim().replace(/\s+/g, ' ').slice(0, reviews.MAX_COMMENT);
    const s = state();
    const entry = (s.reviews[placeId] = s.reviews[placeId] || { name: place.name, category: place.category, items: {} });
    entry.name = place.name;
    entry.category = place.category;
    entry.items[user.id] = { name: user.name, rating, comment, at: new Date().toISOString() };
    store.save();
    res.json({ ratings: ratingsView(req) });
  });

  app.delete('/api/reviews/:placeId', (req, res) => {
    const user = requireUser(req);
    const s = state();
    const entry = s.reviews[req.params.placeId];
    if (entry && entry.items[user.id]) {
      delete entry.items[user.id];
      if (!Object.keys(entry.items).length) delete s.reviews[req.params.placeId];
      store.save();
    }
    res.json({ ratings: ratingsView(req) });
  });

  // 별점 낮은 가게 제외 기준 (관리자)
  app.post('/api/settings/rating', (req, res) => {
    requireAdmin(req);
    const minRating = Number(req.body?.minRating);
    const minReviews = Number(req.body?.minReviews);
    if (!reviews.MIN_RATING_OPTIONS.includes(minRating) || !reviews.MIN_REVIEWS_OPTIONS.includes(minReviews)) {
      throw new AppError(400, '지원하지 않는 별점 기준입니다.');
    }
    const s = state();
    s.settings.ratingFilter = { minRating, minReviews };
    store.save();
    res.json({ ratingFilter: s.settings.ratingFilter, ratings: ratingsView(req) });
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

  // 동점일 때 랜덤 뽑기 (관리자). 같은 동점에서 그냥 다시 눌러도 결과는 그대로이고,
  // redraw로 완료 전까지 몇 번이든 다시 뽑을 수 있다 (count: 몇 번째 뽑기인지)
  app.post('/api/rounds/:id/draw', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    if (!isAdminReq(req)) throw new AppError(403, '랜덤 뽑기는 관리자만 할 수 있습니다.');
    const t = tally(round);
    if (t.tiedIds.length < 2) throw new AppError(409, '동점인 가게가 없어 랜덤 뽑기가 필요하지 않습니다.');
    const redraw = Boolean(req.body?.redraw) && !t.needsDraw;
    if (t.needsDraw || redraw) {
      const count = redraw ? (round.draw.count || 1) + 1 : 1;
      round.draw = { tiedIds: t.tiedIds, winnerId: randomItem(t.tiedIds), at: new Date().toISOString(), count };
      store.save();
    }
    res.json({ round: publicRound(round, req.user && req.user.id) });
  });

  // 뽑기 취소 (관리자): 동점 상태로 되돌린다
  app.delete('/api/rounds/:id/draw', (req, res) => {
    requireAdmin(req);
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw closedError();
    round.draw = null;
    store.save();
    res.json({ round: publicRound(round, req.user && req.user.id) });
  });

  // 결정 기록 지우기 (관리자): 잘못 확정했거나 연습으로 만든 결정을 기록·통계에서 뺀다
  app.delete('/api/history/:roundId', (req, res) => {
    requireAdmin(req);
    const s = state();
    const i = s.history.findIndex((h) => h.roundId === req.params.roundId);
    if (i < 0) throw new AppError(404, '결정 기록을 찾을 수 없습니다.');
    const [removed] = s.history.splice(i, 1);
    // 지운 결정이 화면에 떠 있는 결과면 결과 화면도 내리고, "지난번 결정 가게"는 남은 마지막 기록으로 되돌린다
    if (s.round && s.round.id === removed.roundId) s.round = null;
    if (s.lastWinner && s.lastWinner.decidedAt === removed.decidedAt) {
      const last = s.history.at(-1);
      s.lastWinner = last ? { ...last.winner, decidedAt: last.decidedAt } : null;
    }
    store.save();
    res.json({ ok: true, removed: { roundId: removed.roundId, name: removed.winner && removed.winner.name } });
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
      const pick = v.picks.find((p) => p.candidateId === winner.id);
      if (pick && pick.menus.length) round.orders[id] = { name: v.name, menus: pick.menus };
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
        .map((v) => ({ name: v.name, candidateIds: v.picks.map((p) => p.candidateId) })),
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
