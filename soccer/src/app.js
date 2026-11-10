const path = require('path');
const crypto = require('crypto');
const express = require('express');
const clean = require('./sanitize');

const MAX_FAILS = 5; // 비밀번호를 연속으로 이만큼 틀리면
const LOCK_MS = 10 * 60 * 1000; // 이 시간 동안 같은 IP의 로그인을 막는다
const MAX_SESSIONS = 2000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const shaHex = (s) => sha(s).toString('hex');
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');

// 이름으로 계정 id를 만든다 (대소문자·공백 차이는 같은 사람으로 본다)
const userIdFor = (name) => String(name).trim().replace(/\s+/g, ' ').toLowerCase();

// 보기는 누구나 한다. 전략 제시자는 개인 계정(이름 + 개인 비밀번호)으로 로그인하고,
// 처음 등록할 때만 팀 편집 비밀번호(EDIT_PASSWORD)가 필요하다.
// 전술은 만든 사람(ownerId)과 관리자(ADMIN_NAMES)만 고치거나 지울 수 있다. 선수단은 전략 제시자 모두 고칠 수 있다.
function createApp({ store, editPassword, adminNames = [] }) {
  const app = express();
  app.set('trust proxy', 1); // Render 같은 프록시 뒤에서 접속자 IP를 읽기 위해
  app.use(express.json({ limit: '400kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

  const doc = () => store.state;
  const admins = new Set(adminNames.map(userIdFor).filter(Boolean));
  const fails = new Map(); // ip -> { n, until }

  function locked(req) {
    const f = fails.get(req.ip || 'unknown');
    if (f && f.until && f.until <= Date.now()) fails.delete(req.ip || 'unknown');
    return !!(f && f.until > Date.now());
  }
  function failed(req) {
    const ip = req.ip || 'unknown';
    const n = (fails.get(ip)?.n || 0) + 1;
    if (fails.size > 1000) fails.clear();
    fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
  }

  function publicUser(id) {
    const u = doc().users[id];
    return u ? { id, name: u.name, admin: admins.has(id) } : null;
  }

  // x-session 헤더의 로그인 토큰으로 사용자를 찾는다 (서버에는 토큰 해시만 저장)
  function userFrom(req) {
    const token = req.get('x-session');
    if (!token) return null;
    const s = doc().sessions[shaHex(token)];
    return s ? publicUser(s.userId) : null;
  }

  function needUser(req, res, next) {
    const user = userFrom(req);
    if (!user) return res.status(401).json({ error: '로그인이 필요합니다. 다시 로그인하세요.' });
    req.user = user;
    next();
  }

  // 만든 사람, 관리자. 계정이 생기기 전에 만든 전술(ownerId 없음)은 작성자 이름이 같은 사람
  function canEdit(user, s) {
    if (!user) return false;
    if (user.admin) return true;
    if (s.ownerId) return s.ownerId === user.id;
    return !!s.author && userIdFor(s.author) === user.id;
  }

  const playerIds = () => new Set(doc().team.players.map((p) => p.id));
  const find = (id) => doc().strategies.find((s) => s.id === id);

  app.get('/api/state', (req, res) => {
    const { version, team, strategies } = doc();
    res.json({ version, team, strategies, me: userFrom(req) });
  });

  // 화면이 몇 초마다 확인해서 바뀌었을 때만 /api/state를 다시 받는다
  app.get('/api/version', (req, res) => res.json({ version: doc().version }));

  // 로그인. 처음 쓰는 이름이면 teamPassword(팀 편집 비밀번호)를 받아 계정을 만든다
  app.post('/api/login', async (req, res) => {
    if (locked(req)) return res.status(429).json({ error: '비밀번호를 여러 번 틀렸습니다. 10분 뒤에 다시 시도하세요.' });
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 20) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || !password) return res.status(400).json({ error: '이름과 비밀번호를 입력하세요.' });
    const id = userIdFor(name);
    const users = doc().users;
    let user = users[id];
    if (user) {
      if (!sameText(hashPassword(password, user.salt), user.hash)) {
        failed(req);
        return res.status(401).json({ error: '비밀번호가 맞지 않습니다.' });
      }
    } else {
      if (typeof body.teamPassword !== 'string' || !body.teamPassword) {
        return res.status(404).json({ error: '처음 쓰는 이름입니다. 팀 편집 비밀번호를 함께 입력하면 등록됩니다.', needTeamPassword: true });
      }
      if (!sameText(body.teamPassword, editPassword)) {
        failed(req);
        return res.status(401).json({ error: '팀 편집 비밀번호가 맞지 않습니다.', needTeamPassword: true });
      }
      if (password.length < 4) return res.status(400).json({ error: '개인 비밀번호는 4자 이상으로 정하세요.', needTeamPassword: true });
      if (Object.keys(users).length >= 200) return res.status(400).json({ error: '계정은 200개까지 만들 수 있습니다.' });
      const salt = crypto.randomBytes(16).toString('hex');
      user = users[id] = { name, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
    }
    fails.delete(req.ip || 'unknown');
    const token = crypto.randomBytes(24).toString('hex');
    const sessions = doc().sessions;
    sessions[shaHex(token)] = { userId: id, createdAt: new Date().toISOString() };
    // 오래된 세션부터 정리
    const keys = Object.keys(sessions);
    if (keys.length > MAX_SESSIONS) {
      keys.sort((a, b) => sessions[a].createdAt.localeCompare(sessions[b].createdAt));
      for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete sessions[k];
    }
    await store.save();
    res.json({ token, user: publicUser(id), version: doc().version });
  });

  app.post('/api/logout', async (req, res) => {
    const token = req.get('x-session');
    if (token && doc().sessions[shaHex(token)]) {
      delete doc().sessions[shaHex(token)];
      await store.save();
    }
    res.json({ ok: true, version: doc().version });
  });

  app.put('/api/team', needUser, async (req, res) => {
    const team = clean.team(req.body);
    if (!team.name) team.name = doc().team.name;
    doc().team = team;
    // 지워진 선수는 전술의 라인업에서도 뺀다
    const ids = playerIds();
    for (const s of doc().strategies) {
      for (const l of s.lineup) if (l.playerId && !ids.has(l.playerId)) l.playerId = null;
    }
    await store.save();
    res.json({ version: doc().version, team });
  });

  app.post('/api/strategies', needUser, async (req, res) => {
    if (doc().strategies.length >= 100) return res.status(400).json({ error: '전술은 100개까지 저장할 수 있습니다.' });
    const now = new Date().toISOString();
    const s = {
      id: clean.newId(),
      rev: 1,
      createdAt: now,
      updatedAt: now,
      ...clean.strategy(req.body, playerIds()),
      author: req.user.name,
      ownerId: req.user.id,
    };
    doc().strategies.push(s);
    await store.save();
    res.status(201).json({ version: doc().version, strategy: s });
  });

  // baseRev가 서버의 rev와 다르면 그 사이 다른 곳에서 고친 것이므로 덮어쓰지 않는다
  app.put('/api/strategies/:id', needUser, async (req, res) => {
    const cur = find(req.params.id);
    if (!cur) return res.status(404).json({ error: '전술을 찾을 수 없습니다. 지워졌을 수 있습니다.' });
    if (!canEdit(req.user, cur)) return res.status(403).json({ error: `작성자(${cur.author || '알 수 없음'})만 수정할 수 있습니다.` });
    const body = req.body || {};
    if (body.baseRev !== cur.rev) {
      return res.status(409).json({ error: '다른 곳에서 먼저 이 전술을 고쳤습니다. 최신 내용을 불러옵니다.', strategy: cur });
    }
    const { author, ownerId } = cur;
    Object.assign(cur, clean.strategy(body.strategy, playerIds()), {
      author,
      // 계정 전 전술은 작성자 본인이 처음 저장할 때 주인이 정해진다
      ownerId: ownerId || (userIdFor(author || '') === req.user.id ? req.user.id : null),
      rev: cur.rev + 1,
      updatedAt: new Date().toISOString(),
    });
    await store.save();
    res.json({ version: doc().version, strategy: cur });
  });

  app.delete('/api/strategies/:id', needUser, async (req, res) => {
    const i = doc().strategies.findIndex((s) => s.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '전술을 찾을 수 없습니다.' });
    if (!canEdit(req.user, doc().strategies[i])) return res.status(403).json({ error: '작성자만 삭제할 수 있습니다.' });
    doc().strategies.splice(i, 1);
    await store.save();
    res.json({ version: doc().version });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소입니다.' }));

  // 잘못된 JSON 등
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '서버 오류가 났습니다.' : '요청 형식이 올바르지 않습니다.' });
  });

  return app;
}

module.exports = { createApp, userIdFor };
