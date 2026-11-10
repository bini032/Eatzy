// 상황별 다음 장면 추천 (규칙 기반). 지금 위치에서 공을 가진 쪽, 공이 있는 구역, 근처 선수를 보고
// 흔히 쓰는 패턴의 동선을 지금 선수 위치에 맞춰 만든다. AI가 아니라 정해 둔 규칙이므로 결과는 출발점으로만 쓴다.
// 좌표: 미터 단위, x 0~68(우리 팀 기준 왼쪽 → 오른쪽), y 0(상대 골라인) ~ 105(우리 골라인). 우리 팀은 위로 공격.
(function () {
  const H = Array.from({ length: 11 }, (_, i) => 'h' + i);
  const A = Array.from({ length: 11 }, (_, i) => 'a' + i);
  const OWN_GOAL = [34, 105];
  const THEIR_GOAL = [34, 0];

  const r1 = (v) => Math.round(v * 10) / 10;
  const clampP = (p) => [r1(Math.min(66.5, Math.max(1.5, p[0]))), r1(Math.min(103.5, Math.max(1.5, p[1])))];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const toward = (from, to, len) => {
    const l = d(from, to) || 1;
    return [from[0] + ((to[0] - from[0]) / l) * len, from[1] + ((to[1] - from[1]) / l) * len];
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  function make(pos, labels) {
    const isGK = (k) => labels[k] === 'GK';
    const field = (keys) => keys.filter((k) => !isGK(k));
    const nearestTo = (keys, p, exclude = []) => {
      let best = null;
      let bd = Infinity;
      for (const k of keys) {
        if (exclude.includes(k)) continue;
        const dd = d(pos[k], p);
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      }
      return best;
    };
    // 휘어진 달리기: 가운데 점을 옆으로 살짝 민다
    const run = (owner, to, bend = 0) => {
      const from = pos[owner];
      const end = clampP(to);
      const pts = [from];
      if (bend && d(from, end) > 6) {
        const m = lerp(from, end, 0.5);
        const l = d(from, end);
        pts.push(clampP([m[0] - ((end[1] - from[1]) / l) * bend, m[1] + ((end[0] - from[0]) / l) * bend]));
      }
      pts.push(end);
      return { kind: 'run', owner, withBall: false, points: pts.map((p) => [r1(p[0]), r1(p[1])]) };
    };
    const dribble = (owner, to) => ({ kind: 'dribble', owner, withBall: true, points: [pos[owner], clampP(to)].map((p) => [r1(p[0]), r1(p[1])]) });
    const pass = (to, via) => ({
      kind: 'pass',
      owner: 'ball',
      withBall: false,
      points: [pos.ball, ...(via ? [clampP(via)] : []), to[1] < 0 ? [r1(to[0]), r1(to[1])] : clampP(to)].map((p) => [r1(p[0]), r1(p[1])]),
    });
    return { isGK, field, nearestTo, run, dribble, pass };
  }

  // 지금 상황 판단
  function analyze(pos) {
    const ball = pos.ball;
    let holder = null;
    let hd = 3.5;
    for (const k of [...H, ...A]) {
      const dd = d(pos[k], ball);
      if (dd < hd) {
        hd = dd;
        holder = k;
      }
    }
    const team = holder ? holder[0] : null;
    const side = ball[0] < 20 ? 'left' : ball[0] > 48 ? 'right' : 'center';
    const third = ball[1] < 35 ? 'attack' : ball[1] > 70 ? 'defense' : 'middle';
    const corner = (ball[1] < 4 || ball[1] > 101) && (ball[0] < 7 || ball[0] > 61);
    // 공이 골문 안(슈팅 뒤)
    const goal = Math.abs(ball[0] - 34) < 5 && (ball[1] < 0.3 || ball[1] > 104.7) ? (ball[1] < 1 ? 'for' : 'against') : null;
    const text = [
      corner ? (ball[1] < 4 ? '우리 코너킥' : '상대 코너킥') : team === 'h' ? '우리 공' : team === 'a' ? '상대 공' : '주인 없는 공',
      side === 'left' ? '왼쪽 측면' : side === 'right' ? '오른쪽 측면' : '중앙',
      third === 'attack' ? '상대 진영' : third === 'defense' ? '우리 진영' : '미드필드',
    ].join(' · ');
    if (goal) return { ball, goal, text: goal === 'for' ? '공이 상대 골문 안 (슈팅 뒤)' : '공이 우리 골문 안' };
    return { ball, holder, team, side, third, corner, text };
  }

  // ---------- 우리 공 ----------
  function attackIdeas(pos, s, h) {
    const out = [];
    const hk = s.holder;
    const hp = pos[hk];
    const mates = h.field(H).filter((k) => k !== hk);
    const awayField = h.field(A);
    const sx = s.side === 'left' ? -1 : 1; // 바깥쪽 방향
    const edgeX = s.side === 'left' ? 4 : 64;
    const byAdvance = [...mates].sort((a, b) => pos[a][1] - pos[b][1]); // 상대 골대에 가까운 순

    // 1) 측면 오버래핑
    if (s.side !== 'center' && hp[1] > 22 && hp[1] < 88) {
      const behind = mates.filter((k) => (s.side === 'left' ? pos[k][0] < 26 : pos[k][0] > 42) && pos[k][1] > hp[1] + 2);
      const ov = h.nearestTo(behind, hp);
      if (ov) {
        const fwd = byAdvance.find((k) => k !== ov);
        const arrows = [h.dribble(hk, [hp[0] - sx * 9, hp[1] - 6]), h.run(ov, [edgeX, hp[1] - 16], -sx * 2)];
        if (fwd) arrows.push(h.run(fwd, [34 + sx * 6, Math.max(12, pos[fwd][1] - 10)], sx * 2));
        out.push({ title: '측면 오버래핑', desc: '공 가진 선수는 안쪽으로 드리블, 뒤의 선수가 바깥으로 올라간다. 다음 장면에서 바깥으로 패스.', arrows });
      }
    }
    // 2) 크로스 & 박스 침투
    if (s.side !== 'center' && hp[1] < 45) {
      const box = [34, 12];
      const targets = [
        [s.side === 'left' ? 29 : 39, 7], // 니어 포스트
        [34, 10], // 중앙
        [s.side === 'left' ? 40 : 28, 6], // 파 포스트
      ];
      // 박스 침투는 이미 앞쪽에 있는 선수만 (멀리 뒤에 있는 선수가 60m를 뛰지 않게)
      const runners = mates
        .filter((k) => pos[k][1] < Math.max(hp[1] + 15, 45) && d(pos[k], box) < 45)
        .sort((a, b) => d(pos[a], box) - d(pos[b], box))
        .slice(0, 3);
      if (runners.length) {
        const arrows = [h.pass([34, 10], [(hp[0] + 34) / 2, Math.min(hp[1], 12)])];
        const used = new Set();
        for (const t of targets) {
          const k = h.nearestTo(runners.filter((x) => !used.has(x)), t);
          if (!k) break;
          used.add(k);
          arrows.push(h.run(k, t, 1.5));
        }
        out.push({ title: '크로스 & 박스 침투', desc: '니어 포스트, 중앙, 파 포스트로 나눠 들어가고 중앙으로 크로스.', arrows });
      }
    }
    // 3) 측면 돌파
    if (s.side !== 'center' && hp[1] >= 25 && hp[1] < 75) {
      const fwd = byAdvance[0];
      const arrows = [h.dribble(hk, [edgeX + (s.side === 'left' ? 1 : -1), Math.max(14, hp[1] - 20)])];
      if (fwd) arrows.push(h.run(fwd, [s.side === 'left' ? 29 : 39, Math.max(10, pos[fwd][1] - 14)], sx));
      out.push({ title: '측면 돌파', desc: '터치라인을 따라 드리블로 전진, 공격수는 니어 포스트 쪽으로 따라 들어간다.', arrows });
    }
    // 4) 원투 패스 (패스하고 뛰기)
    if (hp[1] > 15) {
      const near = mates.filter((k) => d(pos[k], hp) < 25 && pos[k][1] <= hp[1] + 5);
      const t = h.nearestTo(near, hp);
      if (t) {
        const go = toward(hp, THEIR_GOAL, 14);
        out.push({
          title: '원투 패스',
          desc: `가까운 동료(${h.label(t)})에게 패스하고 바로 앞 공간으로 뛴다. 다음 장면에서 동료가 돌려준다.`,
          arrows: [h.pass([pos[t][0], pos[t][1] + 1]), h.run(hk, go, sx * 1.5)],
        });
      }
    }
    // 5) 뒷공간 스루패스
    const fwd = byAdvance.find((k) => pos[k][1] < hp[1] + 10);
    if (fwd) {
      const lineY = Math.min(...awayField.map((k) => pos[k][1])); // 상대 맨 뒤 수비 라인
      let ty = Math.max(6, lineY - 7);
      if (ty >= pos[fwd][1] - 3) ty = Math.max(6, pos[fwd][1] - 12);
      const target = [pos[fwd][0] + (34 - pos[fwd][0]) * 0.3, ty];
      if (d(pos.ball, target) < 45) {
        out.push({
          title: '뒷공간 스루패스',
          desc: `가장 앞의 ${h.label(fwd)}가 수비 라인 뒤로 뛰고, 그 앞 공간으로 패스.`,
          arrows: [h.run(fwd, target, pos[fwd][0] < 34 ? 2 : -2), h.pass(target)],
        });
      }
    }
    // 6) 롱볼 역습
    if (hp[1] > 55 && byAdvance.length) {
      const f1 = byAdvance[0];
      const chx = pos[f1][0] < 34 ? 14 : 54;
      const target = [chx, Math.max(10, pos[f1][1] - 25)];
      const arrows = [h.run(f1, target, chx < 34 ? 2 : -2), h.pass(target, lerp(pos.ball, target, 0.5))];
      const f2 = byAdvance[1];
      if (f2) arrows.push(h.run(f2, [34, Math.max(12, pos[f2][1] - 20)]));
      out.push({ title: '롱볼 역습', desc: '공격수가 측면 뒷공간으로 뛰고 길게 보낸다. 다른 공격수는 중앙으로 같이 뛴다.', arrows });
    }
    // 7) 반대편 전환
    if (s.side !== 'center') {
      const far = mates.filter((k) => (s.side === 'left' ? pos[k][0] > 44 : pos[k][0] < 24) && Math.abs(pos[k][1] - hp[1]) < 25);
      // 주변에 상대가 가장 적은 선수
      const space = (k) => Math.min(...awayField.map((a) => d(pos[a], pos[k])));
      const t = far.sort((a, b) => space(b) - space(a))[0];
      if (t) {
        const to = [pos[t][0], pos[t][1] - 6];
        out.push({ title: '반대편 전환', desc: `공이 몰린 쪽 반대편의 ${h.label(t)}에게 길게 바꿔 준다. 받는 선수는 앞으로 나오며 받는다.`, arrows: [h.run(t, to), h.pass(to, [34, Math.min(hp[1], to[1]) - 4])] });
      }
    }
    // 8) 슈팅
    if (d(pos.ball, THEIR_GOAL) < 26 && s.side === 'center') {
      out.unshift({ title: '슈팅', desc: '골대 구석으로 바로 슈팅.', arrows: [h.pass([pos.ball[0] < 34 ? 37 : 31, -1])] });
    }
    return out;
  }

  // ---------- 상대 공 ----------
  function defendIdeas(pos, s, h) {
    const out = [];
    const ak = s.holder;
    const ap = pos[ak];
    const ours = h.field(H);
    const theirs = h.field(A).filter((k) => k !== ak);

    // 1) 2명 압박 (공 가진 선수 + 가까운 패스 길)
    const p1 = h.nearestTo(ours, ap);
    if (p1) {
      const arrows = [h.run(p1, toward(ap, OWN_GOAL, 1.6))];
      const t = h.nearestTo(theirs, ap);
      const p2 = h.nearestTo(ours, t ? lerp(ap, pos[t], 0.45) : ap, [p1]);
      if (t && p2) arrows.push(h.run(p2, lerp(ap, pos[t], 0.45)));
      out.push({ title: '2명 압박', desc: '가장 가까운 선수가 공 가진 상대를 막고, 다음 선수가 가장 가까운 패스 길을 막는다.', arrows });
    }
    // 2) 전방 압박 (상대 진영)
    if (s.third === 'attack') {
      const front = ours.filter((k) => pos[k][1] < 60);
      const used = new Set();
      const arrows = [];
      const presser = h.nearestTo(front, ap);
      if (presser) {
        used.add(presser);
        arrows.push(h.run(presser, toward(ap, OWN_GOAL, 1.5), 1.5));
      }
      // 나머지 앞 선수는 공 근처의 상대를 하나씩 맡는다 (상대와 공 사이에 선다)
      const targets = [...theirs].sort((a, b) => d(pos[a], ap) - d(pos[b], ap)).slice(0, 4);
      for (const t of targets) {
        const k = h.nearestTo(front.filter((x) => !used.has(x)), pos[t]);
        if (!k) break;
        used.add(k);
        arrows.push(h.run(k, toward(pos[t], ap, 2.5)));
      }
      if (arrows.length) out.push({ title: '전방 압박', desc: '한 명은 공 가진 선수, 나머지는 가까운 패스 받을 선수 앞을 막는다.', arrows });
    }
    // 3) 공 쪽으로 슬라이드
    if (ap[1] > 30) {
      const avgX = ours.reduce((n, k) => n + pos[k][0], 0) / (ours.length || 1);
      const dx = Math.max(-10, Math.min(10, (ap[0] - avgX) * 0.5));
      const arrows = Math.abs(dx) > 1.5 ? ours.map((k) => h.run(k, [pos[k][0] + dx, pos[k][1]])).filter((a) => d(a.points[0], a.points[a.points.length - 1]) > 1.5) : [];
      if (arrows.length) out.push({ title: '공 쪽으로 슬라이드', desc: '두 줄 모양을 유지한 채 공이 있는 쪽으로 다같이 이동. 반대편은 비워도 된다.', arrows });
    }
    // 4) 라인 내리고 좁히기 (우리 진영)
    if (ap[1] > 50) {
      const arrows = ours
        .map((k) => {
          const p = pos[k];
          const nx = p[0] + (ap[0] - p[0]) * 0.25;
          const ny = Math.min(100, p[1] + Math.min(7, (102 - p[1]) * 0.3));
          return h.run(k, [nx, ny]);
        })
        .filter((a) => d(a.points[0], a.points[a.points.length - 1]) > 1.5);
      if (arrows.length) out.push({ title: '라인 내리고 좁히기', desc: '뒷공간을 내주지 않게 다같이 조금 물러서고 공 쪽으로 좁힌다.', arrows });
    }
    return out;
  }

  // ---------- 코너킥 ----------
  function cornerIdeas(pos, s, h) {
    const ours = h.field(H);
    const left = pos.ball[0] < 34;
    if (s.ball[1] < 4) {
      const kicker = h.nearestTo(ours, pos.ball);
      const rest = ours.filter((k) => k !== kicker).sort((a, b) => d(pos[a], [34, 12]) - d(pos[b], [34, 12]));
      const targets = [[left ? 30 : 38, 6], [34, 8], [left ? 39 : 29, 5], [34, 13]];
      const used = new Set();
      const arrows = [h.pass([34, 7.5], [pos.ball[0] + (34 - pos.ball[0]) * 0.5, 4])];
      for (const t of targets) {
        const k = h.nearestTo(rest.slice(0, 6).filter((x) => !used.has(x)), t);
        if (!k) break;
        used.add(k);
        arrows.push(h.run(k, t, 1.2));
      }
      return [{ title: '코너킥 공격', desc: '니어, 중앙, 파 포스트, 페널티 스폿으로 나눠 동시에 뛰고 골문 쪽으로 휘어지는 크로스.', arrows }];
    }
    // 상대 코너킥: 지역 수비 자리
    const zones = [[left ? 31 : 37, 101], [34, 100.5], [left ? 38 : 30, 101], [30, 97], [34, 96], [38, 97], [left ? 27 : 41, 98], [34, 91], [left ? 44 : 24, 95]];
    const used = new Set();
    const arrows = [];
    for (const z of zones) {
      const k = h.nearestTo(ours.filter((x) => !used.has(x)), z);
      if (!k) break;
      used.add(k);
      if (d(pos[k], z) > 1.5) arrows.push(h.run(k, z));
    }
    return [{ title: '코너킥 수비 (지역)', desc: '골문 앞 구역을 나눠 맡는다. 한 명은 박스 밖에서 흘러나온 공 대비.', arrows }];
  }

  // pos: { h0..h10, a0..a10, ball: [x, y] }, labels: { h0: 'GK', ..., a0: 'GK', ... }
  function suggest(pos, labels) {
    const h = make(pos, labels);
    h.label = (k) => labels[k] || k;
    const s = analyze(pos);
    if (s.goal) return { situation: s.text, ideas: [], note: '슈팅으로 끝난 장면입니다. 새 상황은 공과 선수를 옮겨서 시작하세요.' };
    let ideas = [];
    if (s.corner) ideas = cornerIdeas(pos, s, h);
    else if (s.team === 'h') ideas = attackIdeas(pos, s, h);
    else if (s.team === 'a') ideas = defendIdeas(pos, s, h);
    else {
      const k = h.nearestTo(h.field(H), pos.ball);
      if (k) ideas = [{ title: '공 먼저 잡기', desc: '가장 가까운 우리 선수가 공으로 달려간다.', arrows: [h.run(k, pos.ball)] }];
    }
    ideas = ideas.filter((x) => x.arrows.length).slice(0, 4);
    return { situation: s.text, ideas };
  }

  window.Suggest = { suggest };
})();
