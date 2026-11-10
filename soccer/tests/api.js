const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soccer-'));
  const store = new Store(path.join(dir, 'state.json'), { teamName: '테스트FC' });
  const app = createApp({ store, editPassword: '비번123' });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, key } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-edit-key'] = encodeURIComponent(key);
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { store, call, dir, close: () => server.close() };
}

const KEY = '비번123';

test('보기는 누구나, 편집은 비밀번호가 있어야 한다', async (t) => {
  const s = await setup();
  t.after(s.close);
  const st = await s.call('GET', '/api/state');
  assert.equal(st.status, 200);
  assert.equal(st.body.team.name, '테스트FC');
  assert.deepEqual(st.body.strategies, []);

  assert.equal((await s.call('POST', '/api/strategies', { body: {} })).status, 401);
  assert.equal((await s.call('POST', '/api/strategies', { body: {}, key: '틀림' })).status, 401);
  assert.equal((await s.call('POST', '/api/login', { key: KEY })).status, 200);
});

test('비밀번호를 5번 틀리면 잠긴다', async (t) => {
  const s = await setup();
  t.after(s.close);
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { key: 'x' })).status, 401);
  assert.equal((await s.call('POST', '/api/login', { key: KEY })).status, 429);
});

test('전술 만들기: 11명씩 기본 위치와 장면 하나', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await s.call('POST', '/api/strategies', { body: { title: '빌드업', formation: '4-3-3' }, key: KEY });
  assert.equal(r.status, 201);
  const st = r.body.strategy;
  assert.equal(st.title, '빌드업');
  assert.equal(st.rev, 1);
  assert.equal(st.lineup.length, 11);
  assert.equal(st.lineup[0].pos, 'GK');
  assert.equal(st.scenes.length, 1);
  assert.equal(st.scenes[0].home.length, 11);
  assert.equal(st.scenes[0].away.length, 11);
  // 우리 팀은 아래쪽, 상대는 위쪽
  assert.ok(st.scenes[0].home.every(([, y]) => y > 52.5));
  assert.ok(st.scenes[0].away.every(([, y]) => y < 52.5));
  const v = (await s.call('GET', '/api/version')).body.version;
  assert.equal(v, r.body.version);
});

test('전술 수정: 입력값을 정리하고, 다른 사람이 먼저 고쳤으면 409', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { strategy } = (await s.call('POST', '/api/strategies', { body: {}, key: KEY })).body;
  const edited = JSON.parse(JSON.stringify(strategy));
  edited.title = '  압박  ';
  edited.scenes[0].home[0] = [999, -50]; // 경기장 밖 좌표는 잘린다
  edited.scenes[0].arrows = [
    { kind: 'run', owner: 'h9', points: [[10, 80], [20, 60]] },
    { kind: 'fly', points: [[1, 1], [2, 2]] }, // 없는 종류는 버린다
    { kind: 'pass', owner: 'evil', points: [[1, 1], [5, 5]] }, // 잘못된 owner는 null
    { kind: 'dribble', owner: 'h5', withBall: true, points: [[1, 1]] }, // 점 하나는 버린다
  ];
  edited.scenes.push({ title: '2단계' });
  const r = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: edited }, key: KEY });
  assert.equal(r.status, 200);
  const saved = r.body.strategy;
  assert.equal(saved.rev, 2);
  assert.equal(saved.title, '압박');
  assert.deepEqual(saved.scenes[0].home[0], [71, -3]);
  assert.equal(saved.scenes[0].arrows.length, 2);
  assert.equal(saved.scenes[0].arrows[0].owner, 'h9');
  assert.equal(saved.scenes[0].arrows[1].owner, null);
  assert.equal(saved.scenes.length, 2);
  assert.equal(saved.scenes[1].home.length, 11);

  const stale = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: edited }, key: KEY });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.strategy.rev, 2);
});

test('선수단 저장, 지운 선수는 라인업에서도 빠진다, 파일에 남는다', async (t) => {
  const s = await setup();
  t.after(s.close);
  const team = await s.call('PUT', '/api/team', {
    body: { name: '우리FC', players: [{ name: '김골키', number: 1, pos: 'GK' }, { name: '이공격', number: '9', pos: 'ST' }, { name: '' }] },
    key: KEY,
  });
  assert.equal(team.status, 200);
  const [gk, st9] = team.body.team.players;
  assert.equal(team.body.team.players.length, 2);
  assert.equal(st9.number, 9);

  const lineup = Array.from({ length: 11 }, () => ({ pos: 'CM', playerId: null }));
  lineup[0] = { pos: 'GK', playerId: gk.id };
  lineup[10] = { pos: 'ST', playerId: st9.id, role: '침투' };
  lineup[5] = { pos: 'CM', playerId: 'ghost' }; // 없는 선수는 비운다
  const { strategy } = (await s.call('POST', '/api/strategies', { body: { lineup }, key: KEY })).body;
  assert.equal(strategy.lineup[0].playerId, gk.id);
  assert.equal(strategy.lineup[10].role, '침투');
  assert.equal(strategy.lineup[5].playerId, null);

  await s.call('PUT', '/api/team', { body: { name: '우리FC', players: [gk] }, key: KEY });
  const after = (await s.call('GET', '/api/state')).body.strategies[0];
  assert.equal(after.lineup[10].playerId, null);
  assert.equal(after.lineup[0].playerId, gk.id);

  const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.team.name, '우리FC');
  assert.equal(onDisk.strategies.length, 1);
});

test('전술 삭제', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { strategy } = (await s.call('POST', '/api/strategies', { body: {}, key: KEY })).body;
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`)).status, 401);
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`, { key: KEY })).status, 200);
  assert.equal((await s.call('GET', '/api/state')).body.strategies.length, 0);
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`, { key: KEY })).status, 404);
});
