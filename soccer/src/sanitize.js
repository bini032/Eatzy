const crypto = require('crypto');
const F = require('../public/formations');

// 화면에서 보낸 값을 그대로 저장하지 않고 허용된 모양으로만 다시 만든다
const LIMITS = { players: 40, scenes: 30, arrows: 60, points: 80 };
const KINDS = ['run', 'pass', 'dribble'];
const OWNER = /^(h|a)(10|[0-9])$|^ball$/;

const newId = () => crypto.randomBytes(6).toString('hex');

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// 메모처럼 줄바꿈을 살리는 긴 글
function text(v, max) {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').slice(0, max) : '';
}

function id(v) {
  return typeof v === 'string' && /^[a-z0-9]{1,24}$/.test(v) ? v : newId();
}

function point(v, fallback) {
  const ok = Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]);
  const [x, y] = ok ? v : fallback;
  const clamp = (n, lo, hi) => Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
  return [clamp(x, -3, F.W + 3), clamp(y, -3, F.L + 3)];
}

function eleven(v, defaults) {
  return defaults.map((d, i) => point(Array.isArray(v) ? v[i] : null, [d.x, d.y]));
}

function arrow(a) {
  if (!a || !KINDS.includes(a.kind) || !Array.isArray(a.points)) return null;
  const pts = a.points.slice(0, LIMITS.points).map((p) => point(p, [NaN, NaN]));
  if (pts.length < 2) return null;
  return {
    id: id(a.id),
    kind: a.kind,
    owner: typeof a.owner === 'string' && OWNER.test(a.owner) ? a.owner : null,
    withBall: a.kind === 'dribble' && a.withBall === true,
    points: pts,
  };
}

function scene(s, homeDefault, awayDefault) {
  s = s && typeof s === 'object' ? s : {};
  return {
    id: id(s.id),
    title: str(s.title, 40),
    memo: text(s.memo, 1000),
    home: eleven(s.home, homeDefault),
    away: eleven(s.away, awayDefault),
    ball: point(s.ball, [F.W / 2, F.L / 2]),
    arrows: (Array.isArray(s.arrows) ? s.arrows : []).slice(0, LIMITS.arrows).map(arrow).filter(Boolean),
  };
}

function strategy(input, playerIds) {
  const s = input && typeof input === 'object' ? input : {};
  const formation = F.NAMES.includes(s.formation) ? s.formation : F.DEFAULT;
  const awayFormation = F.NAMES.includes(s.awayFormation) ? s.awayFormation : F.DEFAULT;
  const homeDefault = F.positions(formation, 'home');
  const awayDefault = F.positions(awayFormation, 'away');
  const lineupIn = Array.isArray(s.lineup) ? s.lineup : [];
  const lineup = homeDefault.map((d, i) => {
    const l = lineupIn[i] && typeof lineupIn[i] === 'object' ? lineupIn[i] : {};
    return {
      pos: str(l.pos, 6) || d.pos,
      playerId: typeof l.playerId === 'string' && playerIds.has(l.playerId) ? l.playerId : null,
      role: text(l.role, 300),
    };
  });
  const scenesIn = Array.isArray(s.scenes) && s.scenes.length ? s.scenes.slice(0, LIMITS.scenes) : [null];
  return {
    title: str(s.title, 60) || '새 전술',
    author: str(s.author, 30),
    memo: text(s.memo, 3000),
    formation,
    awayFormation,
    lineup,
    scenes: scenesIn.map((sc) => scene(sc, homeDefault, awayDefault)),
  };
}

function team(input) {
  const t = input && typeof input === 'object' ? input : {};
  const players = (Array.isArray(t.players) ? t.players : [])
    .slice(0, LIMITS.players)
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = str(p.name, 20);
      if (!name) return null;
      const n = Number(p.number);
      return {
        id: id(p.id),
        name,
        number: p.number !== '' && p.number != null && Number.isInteger(n) && n >= 0 && n <= 99 ? n : null,
        pos: str(p.pos, 6),
      };
    })
    .filter(Boolean);
  return { name: str(t.name, 40), players };
}

module.exports = { strategy, team, newId, LIMITS };
