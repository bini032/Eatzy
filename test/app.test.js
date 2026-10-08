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
  return { call, store, calls, placesFile, close: () => server.close() };
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
    assert.equal(t.store.state.settings.origin.name, '더존을지타워');
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

    const next = (await t.call('POST', '/api/rounds', {})).body.round;
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
    assert.deepEqual(r.body.round.myVote, { candidateId: korean.id, menu: '테스트찌개' });
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
  assert.equal(a.state.round, null);
  a.state.history.push({ n: 1 });
  a.save();
  a.state.history.push({ n: 2 });
  a.save();
  await a.flush();
  assert.equal(JSON.parse(kv.get('eatzy:test')).history.length, 2, '마지막 상태가 저장됨');

  const b = new Store('/nonexistent/state.json', { redis });
  await b.init();
  assert.equal(b.state.history.length, 2);
  assert.deepEqual(b.state.menus, {});
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
    assert.deepEqual(r.body.round.myVote, { candidateId: snack.id, menu: '테스트떡볶이' });

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
    assert.equal(r.body.placeSource, '가게 목록');
  } finally {
    t.close();
  }
});
