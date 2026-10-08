const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

// 테스트용 가짜 카카오 응답 (실제 가게 정보 아님)
const ORIGIN = { x: 126.98, y: 37.566 };
function fakePlaces(label, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${label}-${i}`,
    place_name: `테스트${label}${i}`,
    category_name: `음식점 > ${label} > 테스트`,
    road_address_name: `테스트로 ${i}`,
    phone: '',
    place_url: `https://example.com/${label}${i}`,
    x: String(ORIGIN.x + i * 0.0005),
    y: String(ORIGIN.y),
    distance: String(i * 40),
  }));
}

const realFetch = global.fetch;
function installFakeKakao({ counts = { 한식: 3, 중식: 2, 양식: 2, 분식: 2 } } = {}) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname === 'nominatim.openstreetmap.org') {
      calls.push(u);
      return new Response(
        JSON.stringify({ name: '테스트빌딩', address: { city: '테스트시', borough: '테스트구', road: '테스트로', house_number: '9', quarter: '테스트동' } })
      );
    }
    if (u.hostname !== 'dapi.kakao.com') return realFetch(url, opts);
    calls.push(u);
    const query = u.searchParams.get('query');
    let documents = [];
    if (u.pathname.endsWith('coord2address.json')) {
      documents = [{ road_address: { address_name: '테스트시 테스트로 1' } }];
    } else if (query === '더존을지타워') {
      documents = [{ id: 'origin', place_name: '더존을지타워', x: String(ORIGIN.x), y: String(ORIGIN.y), road_address_name: '테스트 주소' }];
    } else if (query in counts) {
      documents = Number(u.searchParams.get('page')) === 1 ? fakePlaces(query, counts[query]) : [];
    }
    return new Response(JSON.stringify({ documents, meta: { is_end: true } }), { status: 200 });
  };
  return calls;
}

async function setup(opts = {}) {
  process.env.KAKAO_REST_API_KEY = 'test';
  if (opts.noKakao) delete process.env.KAKAO_REST_API_KEY;
  const calls = installFakeKakao(opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eatzy-'));
  const store = new Store(path.join(dir, 'state.json'));
  const placesFile = path.join(dir, 'restaurants.json');
  if (opts.places) fs.writeFileSync(placesFile, JSON.stringify(opts.places));
  const app = createApp({ store, adminKey: 'hs', defaultPlaceQuery: '더존을지타워', defaultOrigin: null, placesFile });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await realFetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, store, calls, placesFile, base, close: () => server.close() };
}

test.afterEach(() => {
  global.fetch = realFetch;
});

const V1 = 'voter-aaaa-1111';
const V2 = 'voter-bbbb-2222';
const V3 = 'voter-cccc-3333';

test('카테고리별로 한 곳씩 후보를 뽑는다', async () => {
  const t = await setup();
  try {
    const r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.round.candidates.map((c) => c.categoryLabel), ['한식', '중식', '양식', '분식']);
    assert.equal(t.store.state.groups.default.settings.origin.name, '더존을지타워');
  } finally {
    t.close();
  }
});

test('매번 이전에 나오지 않은 곳을 뽑고, 다 돌면 다시 시작한다', async () => {
  const t = await setup({ counts: { 한식: 3, 중식: 1, 양식: 1, 분식: 1 } });
  try {
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.call('POST', '/api/rounds', {});
      seen.push(r.body.round.candidates.find((c) => c.categoryKey === 'korean').id);
    }
    assert.equal(new Set(seen).size, 3);
    const r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.body.round.candidates.length, 4);
  } finally {
    t.close();
  }
});

test('투표, 동점 랜덤 뽑기, 관리자 키로 완료', async () => {
  const t = await setup();
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const [a, b] = round.candidates;
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: a.id });
    let r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: b.id });
    assert.equal(r.body.round.needsDraw, true);

    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    assert.equal(r.status, 409, '동점이면 완료 불가');

    r = await t.call('POST', `/api/rounds/${round.id}/draw`, {});
    const drawn = r.body.round.leaderId;
    assert.ok([a.id, b.id].includes(drawn));
    r = await t.call('POST', `/api/rounds/${round.id}/draw`, {});
    assert.equal(r.body.round.leaderId, drawn, '다시 눌러도 결과 유지');

    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'wrong' });
    assert.equal(r.status, 403);
    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    assert.equal(r.status, 200);
    assert.equal(r.body.round.winner.id, drawn);
    assert.equal(r.body.round.winner.byDraw, true);

    const s = await t.call('GET', '/api/state');
    assert.equal(s.body.round.status, 'done');
    assert.equal(s.body.history[0].winner.id, drawn);

    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: a.id });
    assert.equal(r.status, 409, '완료 후 투표 불가');
  } finally {
    t.close();
  }
});

test('투표 중 다시 뽑기는 관리자 키 필요, 투표가 바뀌면 동점 결과 무효', async () => {
  const t = await setup();
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const [a, b] = round.candidates;
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: a.id });
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: b.id });
    await t.call('POST', `/api/rounds/${round.id}/draw`, {});
    let r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: a.id });
    assert.equal(r.body.round.leaderId, a.id);
    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: null });
    assert.equal(r.body.round.needsDraw, false, '같은 동점 조합이면 이전 뽑기 결과 유지');

    r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.status, 403);
    r = await t.call('POST', '/api/rounds', { key: 'hs' });
    assert.equal(r.status, 201);
  } finally {
    t.close();
  }
});

test('최종 결정된 가게는 다음 투표에 같은 카테고리로 다시 노출된다', async () => {
  const t = await setup();
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const chinese = round.candidates.find((c) => c.categoryKey === 'chinese');
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: chinese.id });
    await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });

    const next = (await t.call('POST', '/api/rounds', { key: 'hs' })).body.round;
    const slot = next.candidates.find((c) => c.categoryKey === 'chinese');
    assert.equal(slot.id, chinese.id);
    assert.equal(slot.pinned, true);
  } finally {
    t.close();
  }
});

test('현재 위치/장소 지정으로 기준 위치를 바꾼다', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', '/api/location', { mode: 'current', x: 127.0, y: 37.5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.origin.source, 'current');
    assert.equal(r.body.settings.origin.address, '테스트시 테스트로 1');

    r = await t.call('POST', '/api/location', { mode: 'place', name: '테스트역', x: 126.99, y: 37.56, radius: 500 });
    assert.equal(r.body.settings.origin.name, '테스트역');
    assert.equal(r.body.settings.radius, 500);

    r = await t.call('POST', '/api/rounds', {});
    const k = t.calls.find((u) => u.searchParams.get('query') === '한식');
    assert.equal(k.searchParams.get('x'), '126.99');
    assert.equal(k.searchParams.get('radius'), '500');
    assert.equal(r.body.round.origin.name, '테스트역');

    r = await t.call('POST', '/api/location', { mode: 'current', x: 'abc', y: 1 });
    assert.equal(r.status, 400);
    r = await t.call('POST', '/api/location', { radius: 12345 });
    assert.equal(r.status, 400);

    r = await t.call('POST', '/api/location', { mode: 'default' });
    assert.equal(r.body.settings.origin.name, '더존을지타워');
  } finally {
    t.close();
  }
});

test('가게 목록도 API 키도 없으면 가짜 데이터 대신 명확한 오류를 준다', async () => {
  const t = await setup({ noKakao: true });
  try {
    const r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.status, 503);
    assert.match(r.body.error, /restaurants\.json/);
    assert.equal(t.calls.length, 0);
  } finally {
    t.close();
  }
});

// 테스트용 가짜 가게 목록 (실제 가게 아님)
const LIST = [
  { name: '목록한식A', category: '한식', x: 126.98, y: 37.566 },
  { name: '목록한식B', category: '한식', x: 127.1, y: 37.6 }, // 기준점에서 약 13km
  { name: '목록중식', category: '중식' },
  { name: '목록양식', category: '양식', address: '테스트로 1', url: 'https://example.com/w' },
  { name: '목록분식', category: '분식', memo: '테스트 메모' },
];

test('카카오 키 없이 등록된 가게 목록에서 뽑는다', async () => {
  const t = await setup({ noKakao: true, places: LIST });
  try {
    const s = await t.call('GET', '/api/state');
    assert.equal(s.body.source, 'list');
    assert.equal(s.body.placesCount, 5);
    assert.equal(s.body.kakaoEnabled, false);

    const r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.status, 201);
    assert.equal(r.body.round.origin, null);
    assert.deepEqual(r.body.round.candidates.map((c) => c.categoryLabel), ['한식', '중식', '양식', '분식']);
    assert.equal(t.calls.length, 0, '카카오 호출 없음');
  } finally {
    t.close();
  }
});

test('목록 모드: 현재 위치를 지정하면 좌표 있는 가게는 반경으로 거른다', async () => {
  const t = await setup({ noKakao: true, places: LIST });
  try {
    await t.call('POST', '/api/location', { mode: 'current', x: 126.98, y: 37.566, radius: 1000 });
    for (let i = 0; i < 4; i++) {
      const r = await t.call('POST', '/api/rounds', {});
      const korean = r.body.round.candidates.find((c) => c.categoryKey === 'korean');
      assert.equal(korean.name, '목록한식A');
      assert.equal(korean.distance, 0);
      assert.equal(r.body.round.candidates.find((c) => c.categoryKey === 'chinese').distance, null);
    }
  } finally {
    t.close();
  }
});

test('목록 파일 수정은 재시작 없이 반영되고, 형식 오류 항목은 제외된다', async () => {
  const t = await setup({ noKakao: true, places: LIST });
  try {
    fs.writeFileSync(t.placesFile, JSON.stringify([...LIST, { name: '', category: '한식' }, { name: '이상한곳', category: '일식' }]));
    const s = await t.call('GET', '/api/state');
    assert.equal(s.body.placesCount, 5);
    assert.equal(s.body.placesErrors, 2);
  } finally {
    t.close();
  }
});

const MENU_LIST = [
  { name: '메뉴한식', category: '한식', menus: ['테스트찌개', '테스트볶음'] },
  { name: '메뉴중식', category: '중식' },
  { name: '메뉴양식', category: '양식' },
  { name: '메뉴분식', category: '분식' },
];

test('메뉴: 목록의 메뉴를 모두 보여 주고, 가게와 메뉴를 함께 투표한다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const korean = round.candidates.find((c) => c.categoryKey === 'korean');
    assert.deepEqual(korean.menus, ['테스트찌개', '테스트볶음']);
    const chinese = round.candidates.find((c) => c.categoryKey === 'chinese');
    assert.deepEqual(chinese.menus, []);

    let r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: korean.id, menu: '테스트찌개' });
    assert.deepEqual(r.body.round.myVote, { candidateId: korean.id, menus: ['테스트찌개'], name: '' });
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: korean.id, menu: '테스트찌개' });
    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: korean.id });
    assert.deepEqual(r.body.round.menuCounts[korean.id], { 테스트찌개: 2, '': 1 });
    assert.equal(r.body.round.counts[korean.id], 3);

    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: korean.id, menu: '없는메뉴' });
    assert.equal(r.status, 400);

    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    assert.deepEqual(r.body.round.winner.menuCounts, { 테스트찌개: 2, '': 1 });
  } finally {
    t.close();
  }
});

test('메뉴: 관리자가 직접 입력한 메뉴는 키가 필요하고, 다음 투표에도 유지된다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const chinese = round.candidates.find((c) => c.categoryKey === 'chinese');
    const url = `/api/rounds/${round.id}/candidates/${chinese.id}/menus`;

    let r = await t.call('POST', url, { key: 'wrong', menus: ['A'] });
    assert.equal(r.status, 403);
    r = await t.call('POST', url, { key: 'hs', menus: [' 짜장 ', '짬뽕', '짜장', ''] });
    assert.equal(r.status, 200);
    const updated = r.body.round.candidates.find((c) => c.id === chinese.id);
    assert.deepEqual(updated.menus, ['짜장', '짬뽕']);

    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: chinese.id, menu: '짬뽕' });
    r = await t.call('POST', url, { key: 'hs', menus: ['짜장'] });
    assert.deepEqual(r.body.round.menuCounts[chinese.id], { '': 1 }, '빠진 메뉴를 고른 표는 메뉴 미정으로');

    // 중식이 하나뿐이므로 다음 투표에도 같은 가게가 나오고, 입력한 메뉴가 유지된다
    const next = (await t.call('POST', '/api/rounds', { key: 'hs' })).body.round;
    assert.deepEqual(next.candidates.find((c) => c.id === chinese.id).menus, ['짜장']);
  } finally {
    t.close();
  }
});

test('Upstash Redis 저장소: 시작 시 불러오고, 바뀔 때마다 최신 상태를 저장한다', async () => {
  const kv = new Map();
  const seen = [];
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://redis.test');
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    const [cmd, key, value] = JSON.parse(opts.body);
    seen.push(cmd);
    if (cmd === 'GET') return new Response(JSON.stringify({ result: kv.get(key) ?? null }));
    kv.set(key, value);
    return new Response(JSON.stringify({ result: 'OK' }));
  };
  const redis = { url: 'https://redis.test', token: 'tok', key: 'eatzy:test' };

  const a = new Store('/nonexistent/state.json', { redis });
  await a.init();
  assert.equal(a.state.groups.default.round, null);
  a.state.groups.default.history.push({ n: 1 });
  a.save();
  a.state.groups.default.history.push({ n: 2 });
  a.save();
  await a.flush();
  assert.equal(JSON.parse(kv.get('eatzy:test')).groups.default.history.length, 2, '마지막 상태가 저장됨');

  const b = new Store('/nonexistent/state.json', { redis });
  await b.init();
  assert.equal(b.state.groups.default.history.length, 2);
  assert.deepEqual(b.state.groups.default.menus, {});

  // 예전 형식(그룹 없는 상태)은 기본 그룹으로 옮겨진다
  kv.set('eatzy:test', JSON.stringify({ history: [{ n: 'old' }], places: [] }));
  const c = new Store('/nonexistent/state.json', { redis });
  await c.init();
  assert.deepEqual(c.state.groups.default.history, [{ n: 'old' }]);
  assert.equal(c.state.groups.default.round, null);
});

test('Upstash Redis 저장소: 불러오기에 실패하면 시작하지 않도록 오류를 던진다', async () => {
  global.fetch = async () => new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 });
  const s = new Store('/nonexistent/state.json', { redis: { url: 'https://redis.test', token: 'bad', key: 'k' } });
  await assert.rejects(s.init(), /WRONGPASS/);
});

test('메뉴: 누구나 메뉴를 추가하면 그 메뉴로 투표되고, 다음 투표에도 남는다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const snack = round.candidates.find((c) => c.categoryKey === 'snack');
    const url = `/api/rounds/${round.id}/candidates/${snack.id}/menu-items`;

    let r = await t.call('POST', url, { voterId: V1, menu: '  테스트떡볶이 ' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.round.candidates.find((c) => c.id === snack.id).menus, ['테스트떡볶이']);
    assert.deepEqual(r.body.round.myVote, { candidateId: snack.id, menus: ['테스트떡볶이'], name: '' });

    r = await t.call('POST', url, { voterId: V2, menu: '테스트떡볶이' });
    assert.deepEqual(r.body.round.candidates.find((c) => c.id === snack.id).menus, ['테스트떡볶이'], '중복 추가 안 됨');
    assert.deepEqual(r.body.round.menuCounts[snack.id], { 테스트떡볶이: 2 });

    r = await t.call('POST', url, { voterId: V2, menu: '   ' });
    assert.equal(r.status, 400);

    const next = (await t.call('POST', '/api/rounds', { key: 'hs' })).body.round;
    assert.deepEqual(next.candidates.find((c) => c.id === snack.id).menus, ['테스트떡볶이']);
  } finally {
    t.close();
  }
});

test('/api/health: 저장소와 가게 목록 상태를 알려 준다', async () => {
  const t = await setup({ noKakao: true, places: LIST });
  try {
    const r = await t.call('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.placesCount, 5);
    assert.match(r.body.storage, /파일/);
    assert.equal(r.body.placeSource, '가게 목록 파일');
  } finally {
    t.close();
  }
});

test('현재 위치: 카카오 키가 없으면 OpenStreetMap으로 위치 이름과 주소를 가져온다', async () => {
  const t = await setup({ noKakao: true, places: LIST });
  try {
    const r = await t.call('POST', '/api/location', { mode: 'current', x: 126.98, y: 37.566 });
    assert.equal(r.body.settings.origin.name, '테스트빌딩');
    assert.equal(r.body.settings.origin.address, '테스트시 테스트구 테스트로 9');
    assert.match(r.body.settings.origin.attribution, /OpenStreetMap/);
    const q = t.calls.find((u) => u.hostname === 'nominatim.openstreetmap.org');
    assert.equal(q.searchParams.get('lat'), '37.566');
    assert.equal(q.searchParams.get('accept-language'), 'ko');
  } finally {
    t.close();
  }
});

test('가게 목록 DB: 관리자 키로 업로드/병합/삭제하고, 저장된 목록에서 후보를 뽑는다', async () => {
  const t = await setup({ noKakao: true });
  try {
    const up = (body, key = 'hs') =>
      realFetch(`${t.base}/api/admin/places`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
        body: JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));

    let r = await up({ places: [{ name: 'DB한식', category: '한식' }] }, 'wrong');
    assert.equal(r.status, 403);

    r = await up({ places: [{ name: 'DB한식', category: '한식', menus: ['테스트국밥'] }, { name: '오류', category: '일식' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, 1);
    assert.equal(r.body.errors.length, 1);

    let s = await t.call('GET', '/api/state');
    assert.equal(s.body.placesOrigin, 'db');
    assert.equal(s.body.placesCount, 1);

    // merge: 같은 가게는 덮어쓰고 새 가게는 추가
    r = await up({ places: [{ name: 'DB한식', category: '한식', memo: '수정됨' }, { name: 'DB중식', category: '중식' }] });
    assert.equal(r.body.total, 2);
    assert.equal(r.body.places.find((p) => p.name === 'DB한식').memo, '수정됨');

    const round = (await t.call('POST', '/api/rounds', {})).body.round;
    assert.deepEqual(round.candidates.map((c) => c.name).sort(), ['DB중식', 'DB한식']);
    assert.deepEqual(round.missing, ['양식', '분식']);

    // replace
    r = await up({ mode: 'replace', places: [{ name: 'DB분식', category: '분식' }] });
    assert.equal(r.body.total, 1);

    const id = r.body.places[0].id;
    const del = await realFetch(`${t.base}/api/admin/places/${id}`, { method: 'DELETE', headers: { 'x-admin-key': 'hs' } });
    assert.equal(del.status, 200);
    s = await t.call('GET', '/api/state');
    assert.equal(s.body.placesOrigin, null, '저장 목록이 비고 파일도 없으면 출처 없음');
  } finally {
    t.close();
  }
});

test('완료 후: 투표/메뉴 추가는 완료 안내를, 오늘 새 투표는 관리자 키를 요구한다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const korean = round.candidates.find((c) => c.categoryKey === 'korean');
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: korean.id, menu: '테스트찌개' });
    await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });

    for (const [p, body] of [
      [`/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: korean.id }],
      [`/api/rounds/${round.id}/candidates/${round.candidates.find((c) => c.categoryKey === 'chinese').id}/menu-items`, { voterId: V2, menu: '새메뉴' }],
      [`/api/rounds/${round.id}/draw`, {}],
    ]) {
      const r = await t.call('POST', p, body);
      assert.equal(r.status, 409, p);
      assert.equal(r.body.code, 'closed');
      assert.equal(r.body.error, '투표가 완료되었습니다! 담당자에게 직접 문의해주세요.');
    }

    let r = await t.call('POST', '/api/rounds', {});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'closed');
    r = await t.call('POST', '/api/rounds', { key: 'hs' });
    assert.equal(r.status, 201);
  } finally {
    t.close();
  }
});

test('네이버 장소 번호: 링크에서 번호를 뽑고, 저장 목록이 비어 있으면 파일 목록을 기준으로 수정한다', async () => {
  const { naverPlaceId } = require('../src/places');
  assert.equal(naverPlaceId('https://map.naver.com/p/entry/place/1234567?c=15.00'), '1234567');
  assert.equal(naverPlaceId('https://m.place.naver.com/restaurant/7654321/menu/list'), '7654321');
  assert.equal(naverPlaceId('1234567'), '1234567');
  assert.equal(naverPlaceId('https://naver.me/abc'), '');

  const t = await setup({ noKakao: true, places: LIST });
  try {
    const list = (await realFetch(`${t.base}/api/admin/places`, { headers: { 'x-admin-key': 'hs' } }).then((r) => r.json())).places;
    assert.equal(list.length, 5, '저장 목록이 비어 있으면 파일 목록을 보여 줌');

    const target = list.find((p) => p.name === '목록중식');
    const res = await realFetch(`${t.base}/api/admin/places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': 'hs' },
      body: JSON.stringify({ mode: 'merge', places: [{ ...target, naverUrl: 'https://map.naver.com/p/entry/place/1234567' }] }),
    }).then((r) => r.json());
    assert.equal(res.total, 5, '한 곳만 수정해도 나머지 파일 가게가 유지됨');
    assert.equal(res.places.find((p) => p.name === '목록중식').naverPlaceId, '1234567');

    const round = (await t.call('POST', '/api/rounds', {})).body.round;
    assert.equal(round.candidates.find((c) => c.categoryKey === 'chinese').naverPlaceId, '1234567');
  } finally {
    t.close();
  }
});

test('월간 통계: 결정 횟수, 가게/카테고리/메뉴 랭킹을 한국 시간 월 기준으로 집계한다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    // 두 번 투표를 진행해 기록을 만든다
    for (let i = 0; i < 2; i++) {
      const { round } = (await t.call('POST', '/api/rounds', { key: 'hs' })).body;
      const korean = round.candidates.find((c) => c.categoryKey === 'korean');
      const chinese = round.candidates.find((c) => c.categoryKey === 'chinese');
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: korean.id, menu: '테스트찌개' });
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: korean.id, menu: '테스트찌개' });
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: chinese.id });
      await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    }
    // 예전 형식 기록(후보 정보 없음)도 섞여 있을 수 있다
    t.store.state.groups.default.history.unshift({ roundId: 'old', decidedAt: '2020-01-15T03:00:00Z', winner: { id: 'x', name: '옛가게', categoryLabel: '분식', votes: 2 }, totalVotes: 3 });

    const r = await t.call('GET', '/api/stats');
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.decisions, 2);
    assert.equal(r.body.summary.totalVotes, 6);
    assert.equal(r.body.summary.avgVoters, 3);
    assert.equal(r.body.summary.topRestaurant, '메뉴한식');
    assert.deepEqual(r.body.restaurants.map((x) => [x.name, x.count, x.votes]), [['메뉴한식', 2, 4]]);
    assert.equal(r.body.categories.find((c) => c.label === '한식').count, 2);
    assert.deepEqual(r.body.menus.map((m) => [m.name, m.count]), [['테스트찌개', 4]]);
    assert.equal(r.body.popularCandidates.find((x) => x.name === '메뉴중식').count, 2);
    assert.ok(r.body.months.includes('2020-01'));

    const old = await t.call('GET', '/api/stats?month=2020-01');
    assert.equal(old.body.summary.decisions, 1);
    assert.equal(old.body.restaurants[0].name, '옛가게');

    const all = await t.call('GET', '/api/stats?month=all');
    assert.equal(all.body.summary.decisions, 3);
  } finally {
    t.close();
  }
});

test('메뉴 여러 개 선택: 메뉴별로 세고, 결정 시 가격 확인된 메뉴로 예상 총액을 계산한다', async () => {
  const { menuPrice, estimateTotal } = require('../src/price');
  assert.equal(menuPrice('짜장면 7,000원'), 7000);
  assert.equal(menuPrice('즉석떡볶이 4,000~8,000원'), null);
  assert.equal(menuPrice('테스트찌개'), null);
  assert.deepEqual(estimateTotal({ '짜장면 7,000원': 2, '짬뽕 8,500원': 1, 기타: 1, '': 1 }), { total: 22500, unknown: 1 });

  const places = [
    { name: '가격중식', category: '중식', menus: ['짜장면 7,000원', '짬뽕 8,500원', '군만두'] },
    { name: '가격한식', category: '한식' },
  ];
  const t = await setup({ noKakao: true, places });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const c = round.candidates.find((x) => x.categoryKey === 'chinese');
    let r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, candidateId: c.id, menus: ['짜장면 7,000원', '군만두'] });
    assert.deepEqual(r.body.round.myVote, { candidateId: c.id, menus: ['짜장면 7,000원', '군만두'], name: '' });
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, candidateId: c.id, menus: ['짜장면 7,000원', '짬뽕 8,500원'] });
    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: c.id, menus: [] });
    assert.equal(r.body.round.counts[c.id], 3, '메뉴를 여러 개 골라도 가게 표는 1인 1표');
    assert.deepEqual(r.body.round.menuCounts[c.id], { '짜장면 7,000원': 2, 군만두: 1, '짬뽕 8,500원': 1, '': 1 });

    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, candidateId: c.id, menus: ['없는메뉴'] });
    assert.equal(r.status, 400);

    // 직접 추가한 메뉴는 기존 선택에 더해진다
    r = await t.call('POST', `/api/rounds/${round.id}/candidates/${c.id}/menu-items`, { voterId: V1, menu: '탕수육 15,000원' });
    assert.deepEqual(r.body.round.myVote.menus, ['짜장면 7,000원', '군만두', '탕수육 15,000원']);

    // 관리자가 메뉴를 지우면 고른 메뉴에서도 빠진다
    r = await t.call('POST', `/api/rounds/${round.id}/candidates/${c.id}/menus`, { key: 'hs', voterId: V1, menus: ['짜장면 7,000원', '짬뽕 8,500원', '탕수육 15,000원'] });
    assert.deepEqual(r.body.round.myVote.menus, ['짜장면 7,000원', '탕수육 15,000원']);

    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    assert.equal(r.body.round.winner.estimatedTotal, 7000 * 2 + 8500 + 15000);
    assert.equal(r.body.round.winner.unknownPriceCount, 0);
  } finally {
    t.close();
  }
});

test('이름과 관리자: 투표에 이름이 남고, SB 이름은 관리자 키가 있어야 쓸 수 있다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const korean = round.candidates.find((c) => c.categoryKey === 'korean');
    let r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, name: '  홍길동  ', candidateId: korean.id, menus: ['테스트찌개'] });
    assert.deepEqual(r.body.round.voters[korean.id], [{ name: '홍길동', menus: ['테스트찌개'] }]);

    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, name: 'sb', candidateId: korean.id });
    assert.equal(r.status, 403);
    r = await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, name: 'SB', key: 'hs', candidateId: korean.id });
    assert.equal(r.status, 200);

    const check = await realFetch(`${t.base}/api/admin/check`, { headers: { 'x-admin-key': 'hs' } });
    assert.equal(check.status, 200);
    const bad = await realFetch(`${t.base}/api/admin/check`, { headers: { 'x-admin-key': 'x', 'x-lang': 'en' } }).then((x) => x.json());
    assert.equal(bad.error, 'The admin key is incorrect.', '서버 메시지 번역');
  } finally {
    t.close();
  }
});

test('결정 후 메뉴 고르기: 다른 가게에 투표했거나 투표 안 한 사람도 결정된 가게 메뉴를 고르고 바꾼다', async () => {
  const places = [
    { name: '주문중식', category: '중식', menus: ['짜장면 7,000원', '짬뽕 8,500원'] },
    { name: '주문한식', category: '한식', menus: ['김치찌개 9,000원'] },
  ];
  const t = await setup({ noKakao: true, places });
  try {
    const { round } = (await t.call('POST', '/api/rounds', {})).body;
    const chinese = round.candidates.find((c) => c.categoryKey === 'chinese');
    const korean = round.candidates.find((c) => c.categoryKey === 'korean');
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, name: '가', candidateId: chinese.id, menus: ['짜장면 7,000원'] });
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, name: '나', candidateId: chinese.id });
    await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, name: '다', candidateId: korean.id });

    let r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V3, name: '다', menus: ['짬뽕 8,500원'] });
    assert.equal(r.status, 409, '결정 전에는 주문 불가');

    r = await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    assert.deepEqual(r.body.round.orders, [{ name: '가', menus: ['짜장면 7,000원'], mine: false }], '결정된 가게에 투표하며 고른 메뉴로 시작');

    r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V3, name: '다', menus: ['짬뽕 8,500원'] });
    assert.deepEqual(r.body.round.myOrder, ['짬뽕 8,500원']);
    r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V2, name: '나', menus: ['짜장면 7,000원', '짬뽕 8,500원'] });
    r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V1, name: '가', menus: ['짬뽕 8,500원'] });
    assert.equal(r.body.round.winner.estimatedTotal, 8500 + 7000 + 8500 + 8500);
    assert.deepEqual(r.body.round.winner.menuCounts, { '짬뽕 8,500원': 3, '짜장면 7,000원': 1 });

    r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V1, name: '가', menus: ['김치찌개 9,000원'] });
    assert.equal(r.status, 400, '결정된 가게 메뉴만 가능');

    // 결정된 가게에 메뉴를 새로 추가하면 내 주문에 들어간다
    r = await t.call('POST', `/api/rounds/${round.id}/candidates/${chinese.id}/menu-items`, { voterId: V1, name: '가', menu: '탕수육' });
    assert.deepEqual(r.body.round.myOrder, ['짬뽕 8,500원', '탕수육']);
    assert.ok(r.body.round.winner.menus.includes('탕수육'));

    // 통계 기록에도 반영
    const st = await t.call('GET', '/api/stats');
    assert.equal(st.body.menus.find((m) => m.name === '짬뽕 8,500원').count, 3);

    // 메뉴를 모두 빼면 주문에서 빠진다
    r = await t.call('POST', `/api/rounds/${round.id}/order`, { voterId: V3, name: '다', menus: [] });
    assert.equal(r.body.round.myOrder, null);
  } finally {
    t.close();
  }
});

test('직접 고르기: 목록에서 고른 가게와 직접 입력한 가게로 투표를 시작하고, 입력한 가게는 목록에 저장된다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const list = (await t.call('GET', '/api/place-list')).body.places;
    assert.equal(list.length, 4);
    const korean = list.find((p) => p.category === '한식');

    let r = await t.call('POST', '/api/rounds', { manual: [] });
    assert.equal(r.status, 400);
    r = await t.call('POST', '/api/rounds', { manual: [{ name: '이름만' }] });
    assert.equal(r.status, 400, '카테고리 없는 직접 입력은 거부');

    r = await t.call('POST', '/api/rounds', { manual: [{ id: korean.id }, { name: '새로운집', category: '양식', menus: ['버거 9,000원'] }, { id: korean.id }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.round.source, 'manual');
    assert.deepEqual(r.body.round.candidates.map((c) => c.name), ['메뉴한식', '새로운집'], '중복 제거');
    assert.deepEqual(r.body.round.candidates[0].menus, ['테스트찌개', '테스트볶음']);
    assert.equal(r.body.round.candidates[1].categoryKey, 'western');

    const after = (await t.call('GET', '/api/place-list')).body.places;
    assert.equal(after.length, 5, '직접 입력한 가게가 목록에 추가됨');
  } finally {
    t.close();
  }
});

test('선택 적중 랭킹: 이름별로 내가 고른 가게가 결정된 비율을 월별로 보여 준다', async () => {
  const places = [
    { name: '적중1', category: '한식' },
    { name: '적중2', category: '중식' },
    { name: '적중3', category: '양식' },
    { name: '적중4', category: '분식' },
  ];
  const t = await setup({ noKakao: true, places });
  try {
    const V4 = 'voter-dddd-4444';
    for (let i = 0; i < 2; i++) {
      const { round } = (await t.call('POST', '/api/rounds', { key: 'hs' })).body;
      const [c1, c2, c3] = round.candidates;
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, name: 'SB', key: 'hs', candidateId: c1.id });
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V2, name: 'AA', candidateId: i === 0 ? c1.id : c2.id });
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V3, name: 'BB', candidateId: c2.id });
      await t.call('POST', `/api/rounds/${round.id}/vote`, { voterId: V4, name: 'CC', candidateId: c3.id });
      await t.call('POST', `/api/rounds/${round.id}/complete`, { key: 'hs' });
    }
    // 1회차: SB·AA가 고른 1번 결정, 2회차: AA·BB가 고른 2번 결정
    const st = (await t.call('GET', '/api/stats')).body;
    const byName = Object.fromEntries(st.people.map((p) => [p.name, p]));
    assert.deepEqual(st.people.map((p) => [p.name, p.wins, p.rounds, p.rate]), [
      ['AA', 2, 2, 100],
      ['SB', 1, 2, 50],
      ['BB', 1, 2, 50],
      ['CC', 0, 2, 0],
    ]);
    assert.equal(byName.SB.rounds, 2);
    assert.equal(st.people.at(-1).name, 'CC');
  } finally {
    t.close();
  }
});

test('그룹: 새 그룹을 만들면 따로 투표·통계를 쓰고, 그룹 관리자 키로만 관리한다', async () => {
  const t = await setup({ noKakao: true, places: MENU_LIST });
  try {
    const g = (method, p, body, group, headers = {}) =>
      realFetch(t.base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(group ? { 'x-group': group } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    let r = await g('POST', '/api/groups', { name: '   ' });
    assert.equal(r.status, 400);
    r = await g('POST', '/api/groups', { name: '  개발팀   점심 ', owner: '홍길동' });
    assert.equal(r.status, 201);
    const { id, adminToken } = r.body;
    assert.match(id, /^[a-z0-9]{6,8}$/);
    assert.equal(r.body.name, '개발팀 점심');

    r = await g('GET', '/api/state', null, id);
    assert.deepEqual(r.body.group, { id, name: '개발팀 점심', isDefault: false });
    assert.equal(r.body.placesCount, 4, '새 그룹도 기본 가게 목록에서 시작');

    r = await g('GET', '/api/state', null, 'nope123');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'no_group');

    // 그룹 투표는 기본 그룹과 분리된다
    const round = (await g('POST', '/api/rounds', {}, id)).body.round;
    await g('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, name: '가', candidateId: round.candidates[0].id }, id);
    const def = (await g('GET', '/api/state')).body;
    assert.equal(def.round, null, '기본 그룹에는 투표 없음');
    r = await g('POST', `/api/rounds/${round.id}/vote`, { voterId: V1, name: '가', candidateId: round.candidates[0].id });
    assert.equal(r.status, 409, '다른 그룹의 투표 id로는 투표 불가');

    // 그룹 관리자 키: 그 그룹에서만 통한다. 전체 관리자 키(hs)는 모든 그룹에서 통한다
    assert.equal((await g('GET', '/api/admin/check', null, id, { 'x-admin-key': adminToken })).status, 200);
    assert.equal((await g('GET', '/api/admin/check', null, 'default', { 'x-admin-key': adminToken })).status, 403);
    assert.equal((await g('GET', '/api/admin/check', null, id, { 'x-admin-key': 'hs' })).status, 200);
    r = await g('POST', `/api/rounds/${round.id}/complete`, { key: adminToken }, id);
    assert.equal(r.status, 200);
    assert.equal((await g('GET', '/api/stats', null, id)).body.summary.decisions, 1);
    assert.equal((await g('GET', '/api/stats')).body.summary.decisions, 0);

    // 그룹 링크도 같은 화면을 준다
    const page = await realFetch(`${t.base}/g/${id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
  } finally {
    t.close();
  }
});
