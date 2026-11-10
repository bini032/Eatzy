const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

const TEAM = '비번123'; // 팀 편집 비밀번호 (계정 등록용)

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soccer-'));
  const store = new Store(path.join(dir, 'state.json'), { teamName: '테스트FC' });
  const app = createApp({ store, editPassword: TEAM, adminNames: ['감독'] });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, key } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-session'] = key;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // 계정을 만들고(처음이면) 세션 토큰을 돌려준다
  const login = async (name, password = 'pw1234') => {
    const r = await call('POST', '/api/login', { body: { name, password, teamPassword: TEAM } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
  };
  const KEY = await login('코치');
  return { store, call, login, dir, KEY, close: () => server.close() };
}

test('보기는 누구나, 편집은 로그인한 전략 제시자만', async (t) => {
  const s = await setup();
  t.after(s.close);
  const st = await s.call('GET', '/api/state');
  assert.equal(st.status, 200);
  assert.equal(st.body.team.name, '테스트FC');
  assert.deepEqual(st.body.strategies, []);
  assert.equal(st.body.me, null);
  assert.equal(st.body.users, undefined); // 계정 정보는 내보내지 않는다
  assert.equal(st.body.sessions, undefined);

  assert.equal((await s.call('POST', '/api/strategies', { body: {} })).status, 401);
  assert.equal((await s.call('POST', '/api/strategies', { body: {}, key: 'nope' })).status, 401);
  const me = await s.call('GET', '/api/state', { key: s.KEY });
  assert.deepEqual(me.body.me, { id: '코치', name: '코치', admin: false });
});

test('처음 쓰는 이름은 팀 비밀번호로 등록, 다음부터는 개인 비밀번호', async (t) => {
  const s = await setup();
  t.after(s.close);
  const noTeam = await s.call('POST', '/api/login', { body: { name: '새사람', password: 'abcd' } });
  assert.equal(noTeam.status, 404);
  assert.equal(noTeam.body.needTeamPassword, true);
  assert.equal((await s.call('POST', '/api/login', { body: { name: '새사람', password: 'abcd', teamPassword: 'x' } })).status, 401);
  assert.equal((await s.call('POST', '/api/login', { body: { name: '새사람', password: 'ab', teamPassword: TEAM } })).status, 400);
  const ok = await s.call('POST', '/api/login', { body: { name: ' 새사람 ', password: 'abcd', teamPassword: TEAM } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, '새사람');
  assert.equal((await s.call('POST', '/api/login', { body: { name: '새사람', password: 'abcd' } })).status, 200);
  assert.equal((await s.call('POST', '/api/login', { body: { name: '새사람', password: 'wrong' } })).status, 401);
  // 로그아웃하면 토큰이 더는 통하지 않는다
  await s.call('POST', '/api/logout', { key: ok.body.token });
  assert.equal((await s.call('POST', '/api/strategies', { body: {}, key: ok.body.token })).status, 401);
  // 비밀번호는 해시로만 저장
  assert.ok(!fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8').includes('abcd'));
});

test('작성자와 관리자만 전술을 고치거나 지울 수 있다', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { strategy } = (await s.call('POST', '/api/strategies', { body: { title: '코치 전술', author: '가짜' }, key: s.KEY })).body;
  assert.equal(strategy.author, '코치'); // 작성자는 로그인한 사람으로 정해진다
  assert.equal(strategy.ownerId, '코치');
  const other = await s.login('선수A');
  const put = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: { ...strategy, title: '뺏기' } }, key: other });
  assert.equal(put.status, 403);
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`, { key: other })).status, 403);
  // 관리자(ADMIN_NAMES)는 고칠 수 있고, 작성자는 그대로
  const boss = await s.login('감독');
  const byBoss = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: { ...strategy, title: '감독 수정' } }, key: boss });
  assert.equal(byBoss.status, 200);
  assert.equal(byBoss.body.strategy.title, '감독 수정');
  assert.equal(byBoss.body.strategy.author, '코치');
  assert.equal(byBoss.body.strategy.ownerId, '코치');
});

test('계정 전에 만든 전술은 작성자 이름이 같은 사람이 이어받는다', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.store.state.strategies.push({ id: 'old1', rev: 1, author: '코치', ownerId: undefined, title: '옛 전술', lineup: [], scenes: [] });
  const other = await s.login('선수A');
  assert.equal((await s.call('PUT', '/api/strategies/old1', { body: { baseRev: 1, strategy: { title: 'x' } }, key: other })).status, 403);
  const r = await s.call('PUT', '/api/strategies/old1', { body: { baseRev: 1, strategy: { title: '이어받음' } }, key: s.KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.strategy.ownerId, '코치');
});

test('비밀번호를 5번 틀리면 잠긴다', async (t) => {
  const s = await setup();
  t.after(s.close);
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { body: { name: '코치', password: 'x' } })).status, 401);
  assert.equal((await s.call('POST', '/api/login', { body: { name: '코치', password: 'pw1234' } })).status, 429);
});

test('전술 만들기: 11명씩 기본 위치와 장면 하나', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await s.call('POST', '/api/strategies', { body: { title: '빌드업', formation: '4-3-3' }, key: s.KEY });
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
  const { strategy } = (await s.call('POST', '/api/strategies', { body: {}, key: s.KEY })).body;
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
  edited.lineup[3] = { pos: 'CB', name: '용병 김씨', number: '23' };
  edited.awayLineup[9] = { pos: 'ST', name: '상대 에이스', number: 10 };
  const r = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: edited }, key: s.KEY });
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
  assert.deepEqual(saved.lineup[3], { pos: 'CB', playerId: null, name: '용병 김씨', number: 23, role: '' });
  assert.deepEqual(saved.awayLineup[9], { pos: 'ST', name: '상대 에이스', number: 10 });

  const stale = await s.call('PUT', `/api/strategies/${strategy.id}`, { body: { baseRev: 1, strategy: edited }, key: s.KEY });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.strategy.rev, 2);
});

test('선수단 저장, 지운 선수는 라인업에서도 빠진다, 파일에 남는다', async (t) => {
  const s = await setup();
  t.after(s.close);
  const team = await s.call('PUT', '/api/team', {
    body: { name: '우리FC', players: [{ name: '김골키', number: 1, pos: 'GK' }, { name: '이공격', number: '9', pos: 'ST' }, { name: '' }] },
    key: s.KEY,
  });
  assert.equal(team.status, 200);
  const [gk, st9] = team.body.team.players;
  assert.equal(team.body.team.players.length, 2);
  assert.equal(st9.number, 9);

  const lineup = Array.from({ length: 11 }, () => ({ pos: 'CM', playerId: null }));
  lineup[0] = { pos: 'GK', playerId: gk.id };
  lineup[10] = { pos: 'ST', playerId: st9.id, role: '침투' };
  lineup[5] = { pos: 'CM', playerId: 'ghost' }; // 없는 선수는 비운다
  const { strategy } = (await s.call('POST', '/api/strategies', { body: { lineup }, key: s.KEY })).body;
  assert.equal(strategy.lineup[0].playerId, gk.id);
  assert.equal(strategy.lineup[10].role, '침투');
  assert.equal(strategy.lineup[5].playerId, null);
  assert.equal(strategy.awayLineup.length, 11);
  assert.equal(strategy.awayLineup[0].pos, 'GK');

  await s.call('PUT', '/api/team', { body: { name: '우리FC', players: [gk] }, key: s.KEY });
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
  const { strategy } = (await s.call('POST', '/api/strategies', { body: {}, key: s.KEY })).body;
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`)).status, 401);
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`, { key: s.KEY })).status, 200);
  assert.equal((await s.call('GET', '/api/state')).body.strategies.length, 0);
  assert.equal((await s.call('DELETE', `/api/strategies/${strategy.id}`, { key: s.KEY })).status, 404);
});
