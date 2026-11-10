const path = require('path');
const crypto = require('crypto');
const express = require('express');
const clean = require('./sanitize');

const MAX_FAILS = 5; // 비밀번호를 연속으로 이만큼 틀리면
const LOCK_MS = 10 * 60 * 1000; // 이 시간 동안 같은 IP의 편집 요청을 막는다

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createApp({ store, editPassword }) {
  const app = express();
  app.set('trust proxy', 1); // Render 같은 프록시 뒤에서 접속자 IP를 읽기 위해
  app.use(express.json({ limit: '400kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

  const doc = () => store.state;
  const passHash = digest(editPassword);
  const fails = new Map(); // ip -> { n, until }

  // 보기는 누구나, 바꾸는 요청은 x-edit-key 헤더의 편집 비밀번호가 맞아야 한다
  function editor(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let f = fails.get(ip);
    if (f && f.until && f.until <= now) f = null; // 잠금 시간이 지나면 처음부터
    if (f && f.until > now) {
      return res.status(429).json({ error: '비밀번호를 여러 번 틀렸습니다. 10분 뒤에 다시 시도하세요.' });
    }
    let key = req.get('x-edit-key') || '';
    try {
      key = decodeURIComponent(key); // 한글 비밀번호도 헤더로 보낼 수 있게 화면에서 인코딩해서 보낸다
    } catch {}
    if (key && crypto.timingSafeEqual(digest(key), passHash)) {
      fails.delete(ip);
      return next();
    }
    if (!key) return res.status(401).json({ error: '편집하려면 비밀번호가 필요합니다.' });
    const n = (f ? f.n : 0) + 1;
    if (fails.size > 1000) fails.clear();
    fails.set(ip, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
    res.status(401).json({ error: '편집 비밀번호가 맞지 않습니다.' });
  }

  const playerIds = () => new Set(doc().team.players.map((p) => p.id));
  const find = (id) => doc().strategies.find((s) => s.id === id);

  app.get('/api/state', (req, res) => {
    const { version, team, strategies } = doc();
    res.json({ version, team, strategies });
  });

  // 화면이 몇 초마다 확인해서 바뀌었을 때만 /api/state를 다시 받는다
  app.get('/api/version', (req, res) => res.json({ version: doc().version }));

  app.post('/api/login', editor, (req, res) => res.json({ ok: true }));

  app.put('/api/team', editor, async (req, res) => {
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

  app.post('/api/strategies', editor, async (req, res) => {
    if (doc().strategies.length >= 100) return res.status(400).json({ error: '전술은 100개까지 저장할 수 있습니다.' });
    const now = new Date().toISOString();
    const s = { id: clean.newId(), rev: 1, createdAt: now, updatedAt: now, ...clean.strategy(req.body, playerIds()) };
    doc().strategies.push(s);
    await store.save();
    res.status(201).json({ version: doc().version, strategy: s });
  });

  // baseRev가 서버의 rev와 다르면 그 사이 다른 사람이 고친 것이므로 덮어쓰지 않는다
  app.put('/api/strategies/:id', editor, async (req, res) => {
    const cur = find(req.params.id);
    if (!cur) return res.status(404).json({ error: '전술을 찾을 수 없습니다. 다른 사람이 지웠을 수 있습니다.' });
    const body = req.body || {};
    if (body.baseRev !== cur.rev) {
      return res.status(409).json({ error: '다른 사람이 먼저 이 전술을 고쳤습니다. 최신 내용을 불러옵니다.', strategy: cur });
    }
    Object.assign(cur, clean.strategy(body.strategy, playerIds()), { rev: cur.rev + 1, updatedAt: new Date().toISOString() });
    await store.save();
    res.json({ version: doc().version, strategy: cur });
  });

  app.delete('/api/strategies/:id', editor, async (req, res) => {
    const i = doc().strategies.findIndex((s) => s.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '전술을 찾을 수 없습니다.' });
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

module.exports = { createApp };
