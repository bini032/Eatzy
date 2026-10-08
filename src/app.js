const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { AppError } = require('./errors');
const kakao = require('./kakao');
const { CATEGORIES, pickCandidates, tally, randomItem } = require('./lunch');

const RADIUS_OPTIONS = [300, 500, 1000, 1500, 2000];

function keyMatches(input, expected) {
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function validCoords(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
}

function createApp({ store, adminKey, defaultPlaceQuery, defaultOrigin }) {
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const state = () => store.state;

  async function resolveOrigin() {
    if (state().settings.origin) return state().settings.origin;
    let origin;
    if (defaultOrigin) {
      origin = { name: defaultPlaceQuery, x: defaultOrigin.x, y: defaultOrigin.y, source: 'default' };
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
      totalVotes: t.totalVotes,
      tiedIds: t.tiedIds,
      needsDraw: t.needsDraw,
      leaderId: t.leaderId,
      draw: round.draw,
      myVote: voterId ? round.votes[voterId] || null : null,
      winner: round.winner || null,
      finishedAt: round.finishedAt || null,
    };
  }

  app.get('/api/state', (req, res) => {
    const s = state();
    res.json({
      categories: CATEGORIES,
      radiusOptions: RADIUS_OPTIONS,
      defaultPlace: defaultPlaceQuery,
      settings: s.settings,
      round: publicRound(s.round, req.query.voter),
      lastWinner: s.lastWinner,
      history: s.history.slice(-10).reverse(),
    });
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
      const addr = await kakao.coordToAddress(x, y);
      s.settings.origin = { name: '내 현재 위치', address: addr || `${y.toFixed(5)}, ${x.toFixed(5)}`, x, y, source: 'current' };
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

  // 맛집 찾기 = 새 투표 시작
  app.post('/api/rounds', async (req, res) => {
    const s = state();
    const active = s.round && s.round.status === 'voting' && Object.keys(s.round.votes).length > 0;
    if (active && !keyMatches(req.body?.key, adminKey)) {
      throw new AppError(403, '이미 투표가 진행 중입니다. 다시 뽑으려면 관리자 키가 필요합니다.');
    }
    const origin = await resolveOrigin();
    const radius = s.settings.radius;
    const { candidates, missing } = await pickCandidates(s, origin, radius);
    if (candidates.length === 0) {
      throw new AppError(404, `반경 ${radius}m 안에서 맛집을 찾지 못했습니다. 반경을 넓히거나 위치를 바꿔 보세요.`);
    }
    s.round = {
      id: crypto.randomUUID(),
      status: 'voting',
      createdAt: new Date().toISOString(),
      origin: { name: origin.name, address: origin.address, x: origin.x, y: origin.y },
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
    if (round.status !== 'voting') throw new AppError(409, '이미 결정이 완료된 투표입니다.');
    const voterId = String(req.body?.voterId || '');
    const candidateId = req.body?.candidateId;
    if (!/^[\w-]{8,64}$/.test(voterId)) throw new AppError(400, '투표자 정보가 올바르지 않습니다.');
    if (candidateId === null) {
      delete round.votes[voterId];
    } else {
      if (!round.candidates.some((c) => c.id === candidateId)) throw new AppError(400, '후보에 없는 가게입니다.');
      round.votes[voterId] = candidateId;
    }
    store.save();
    res.json({ round: publicRound(round, voterId) });
  });

  // 동점일 때 랜덤 뽑기. 같은 동점 상황에서 여러 번 눌러도 결과는 한 번만 정해진다.
  app.post('/api/rounds/:id/draw', (req, res) => {
    const round = currentRound(req.params.id);
    if (round.status !== 'voting') throw new AppError(409, '이미 결정이 완료된 투표입니다.');
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
    if (round.status !== 'voting') throw new AppError(409, '이미 결정이 완료된 투표입니다.');
    const t = tally(round);
    if (t.totalVotes === 0) throw new AppError(409, '아직 투표가 없습니다.');
    if (t.needsDraw) throw new AppError(409, '동점입니다. 먼저 랜덤 뽑기를 진행해 주세요.');

    const winner = round.candidates.find((c) => c.id === t.leaderId);
    round.status = 'done';
    round.winner = { ...winner, votes: t.counts[winner.id], byDraw: t.tiedIds.length > 1 };
    round.finishedAt = new Date().toISOString();

    const s = state();
    s.lastWinner = { ...winner, decidedAt: round.finishedAt };
    s.history.push({ roundId: round.id, decidedAt: round.finishedAt, winner: round.winner, totalVotes: t.totalVotes });
    if (s.history.length > 100) s.history = s.history.slice(-100);
    store.save();
    res.json({ round: publicRound(round, req.body?.voterId) });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return app;
}

module.exports = { createApp };
