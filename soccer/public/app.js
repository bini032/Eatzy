/* 축구 전술 보드 화면. 서버 API는 상대 주소(api/...)로 불러서 /나 /soccer/ 어디에 올려도 동작한다. */
(function () {
  'use strict';
  const F = window.Formations;
  const W = F.W;
  const L = F.L;
  const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LM', 'RM', 'LW', 'RW', 'ST'];
  const KIND_LABEL = { run: '달리기', pass: '패스', dribble: '드리블' };
  const SPEEDS = [0.5, 1, 2];
  const KEYS = [...Array.from({ length: 11 }, (_, i) => 'h' + i), ...Array.from({ length: 11 }, (_, i) => 'a' + i), 'ball'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');

  // ---------- 브라우저 저장 (개인 편의용, 실패해도 동작) ----------
  const local = {
    get(k) {
      try {
        return localStorage.getItem(k) ?? sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v, remember = true) {
      try {
        (remember ? localStorage : sessionStorage).setItem(k, v);
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      } catch {}
    },
  };

  const S = {
    doc: null, // { version, team, strategies }
    key: local.get('soccer.key'), // 편집 비밀번호 (있으면 편집 가능)
    name: local.get('soccer.name') || '',
    route: { view: 'list' },
    work: null, // 편집 중인 전술 사본
    scene: 0,
    tool: 'move',
    undo: [],
    dirty: false,
    saving: null,
    saveTimer: null,
    drag: null,
    draw: null,
    play: null,
    speed: 1,
    roster: null, // 선수단 편집 사본
    rosterDirty: false,
  };

  const isEditor = () => !!S.key;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- 서버 ----------
  async function api(method, url, body, key = S.key) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-edit-key'] = encodeURIComponent(key);
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `서버 오류 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadDoc() {
    S.doc = await api('GET', 'api/state');
  }

  function strategyById(id) {
    return S.doc && S.doc.strategies.find((s) => s.id === id);
  }

  function replaceInDoc(st) {
    const i = S.doc.strategies.findIndex((s) => s.id === st.id);
    if (i >= 0) S.doc.strategies[i] = clone(st);
    else S.doc.strategies.push(clone(st));
  }

  function playersById() {
    const m = new Map();
    for (const p of S.doc.team.players) m.set(p.id, p);
    return m;
  }

  function logout(msg) {
    S.key = null;
    S.work = null;
    S.roster = null;
    local.del('soccer.key');
    if (msg) toast(msg);
    render();
  }

  // ---------- 저장 (편집 내용은 잠시 뒤 자동 저장) ----------
  function changed() {
    S.dirty = true;
    setStatus('저장 대기');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 900);
  }

  function saveNow() {
    clearTimeout(S.saveTimer);
    if (S.saving) return S.saving;
    if (!S.dirty || !S.work) return Promise.resolve();
    const w = S.work;
    S.dirty = false;
    setStatus('저장 중…');
    S.saving = (async () => {
      try {
        const r = await api('PUT', `api/strategies/${w.id}`, { baseRev: w.rev, strategy: w });
        w.rev = r.strategy.rev;
        replaceInDoc(r.strategy);
        S.doc.version = r.version;
        setStatus(S.dirty ? '저장 대기' : '저장됨');
      } catch (err) {
        if (err.status === 409 && err.data.strategy) {
          toast(err.message, 4000);
          replaceInDoc(err.data.strategy);
          if (S.work === w) {
            S.work = clone(err.data.strategy);
            S.undo = [];
            S.dirty = false;
          }
          render();
        } else if (err.status === 401) {
          logout(err.message);
        } else if (err.status === 404) {
          toast(err.message, 4000);
          S.doc.strategies = S.doc.strategies.filter((s) => s.id !== w.id);
          S.work = null;
          location.hash = '#/';
        } else {
          S.dirty = true;
          setStatus('저장 실패: 다시 시도 중', true);
          S.saveTimer = setTimeout(saveNow, 5000);
        }
      } finally {
        S.saving = null;
        if (S.dirty && S.work) {
          clearTimeout(S.saveTimer);
          S.saveTimer = setTimeout(saveNow, 900);
        }
      }
    })();
    return S.saving;
  }

  function setStatus(text, bad) {
    const el = $('#saveStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty || S.saving || S.rosterDirty) {
      saveNow();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- 화면 이동 ----------
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    if (parts[0] === 's' && parts[1]) return { view: 'strategy', id: parts[1], scene: Math.max(0, (parseInt(parts[2], 10) || 1) - 1) };
    if (parts[0] === 'roster') return { view: 'roster' };
    return { view: 'list' };
  }

  async function onRoute() {
    stopPlay();
    await saveNow();
    const prev = S.route;
    S.route = parseRoute();
    if (S.route.view === 'strategy') {
      if (prev.view !== 'strategy' || prev.id !== S.route.id) {
        S.work = null;
        S.undo = [];
        S.tool = 'move';
      }
      S.scene = S.route.scene;
    }
    if (S.route.view !== 'roster') {
      S.roster = null;
      S.rosterDirty = false;
    }
    render();
    window.scrollTo(0, 0);
  }

  function sceneHash(i) {
    history.replaceState(null, '', `#/s/${S.route.id}/${i + 1}`);
  }

  // ---------- 그리기 ----------
  function render() {
    if (!S.doc) return;
    $('#teamName').textContent = S.doc.team.name || '축구 전술 보드';
    document.title = `${S.doc.team.name || '축구'} 전술 보드`;
    const lock = $('#lockBtn');
    lock.textContent = isEditor() ? '✏️ 편집 중' : '🔒 보기';
    lock.classList.toggle('editing', isEditor());
    const inStrategy = S.route.view === 'strategy';
    $('#backBtn').hidden = !inStrategy;
    $('#tabs').hidden = inStrategy;
    for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === S.route.view);
    if (S.route.view === 'roster') renderRoster();
    else if (inStrategy) renderStrategy();
    else renderList();
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderList() {
    const list = [...S.doc.strategies].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    view.innerHTML = `
      <div class="row">
        <h2 class="grow">전술 ${list.length}개</h2>
        ${isEditor() ? '<button id="newBtn" class="primary">+ 새 전술</button>' : ''}
      </div>
      ${
        list.length
          ? `<div class="cards">${list
              .map(
                (s) => `<a class="card" href="#/s/${s.id}">
                  <b>${esc(s.title)}</b>
                  <div class="meta">${[s.author && esc(s.author), `장면 ${s.scenes.length}개`, `${esc(s.formation)} vs ${esc(s.awayFormation)}`, fmtDate(s.updatedAt)].filter(Boolean).join(' · ')}</div>
                  ${s.memo ? `<div class="memo">${esc(s.memo)}</div>` : ''}
                </a>`
              )
              .join('')}</div>`
          : `<div class="empty">아직 전술이 없습니다.<br>${
              isEditor() ? '“+ 새 전술”로 첫 전술을 만들어 보세요.' : '전략 제시자는 오른쪽 위 “🔒 보기”를 눌러 비밀번호를 입력하면 전술을 추가할 수 있습니다.'
            }</div>`
      }`;
    const nb = $('#newBtn');
    if (nb) nb.onclick = createStrategy;
  }

  async function createStrategy() {
    // 가장 최근 전술의 포메이션과 선수 배정을 이어받는다
    const last = [...S.doc.strategies].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
    const body = { title: '새 전술', author: S.name };
    if (last) {
      body.formation = last.formation;
      body.awayFormation = last.awayFormation;
      body.lineup = last.lineup.map((l) => ({ pos: l.pos, playerId: l.playerId, role: '' }));
    } else {
      // 첫 전술: 선수단을 등번호 순으로 채운다 (골키퍼 포지션 선수가 있으면 GK 자리에)
      const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
      const gk = players.find((p) => p.pos === 'GK');
      const rest = players.filter((p) => p !== gk);
      body.lineup = F.positions(F.DEFAULT, 'home').map((d, i) => ({ pos: d.pos, playerId: (i === 0 ? gk : rest[gk ? i - 1 : i])?.id || null, role: '' }));
    }
    try {
      const r = await api('POST', 'api/strategies', body);
      replaceInDoc(r.strategy);
      S.doc.version = r.version;
      location.hash = `#/s/${r.strategy.id}`;
    } catch (err) {
      if (err.status === 401) logout(err.message);
      else toast(err.message);
    }
  }

  // ---------- 전술 화면 ----------
  function current() {
    if (isEditor()) {
      const base = strategyById(S.route.id);
      if (!S.work && base) S.work = clone(base);
      return S.work;
    }
    return strategyById(S.route.id);
  }

  function renderStrategy() {
    const st = current();
    if (!st) {
      view.innerHTML = `<div class="empty">전술을 찾을 수 없습니다. 지워졌을 수 있습니다.<br><br><a href="#/" style="color:var(--accent)">목록으로</a></div>`;
      return;
    }
    S.scene = Math.min(S.scene, st.scenes.length - 1);
    const ed = isEditor();
    const sc = st.scenes[S.scene];
    const pm = playersById();
    view.innerHTML = `
      <div class="title-row">
        ${ed ? `<input id="stTitle" maxlength="60" value="${esc(st.title)}" aria-label="전술 이름" />` : `<h2>${esc(st.title)}</h2>`}
        ${ed ? `<span id="saveStatus" class="status">${S.dirty ? '저장 대기' : '저장됨'}</span>` : ''}
      </div>
      <div class="hint">${[st.author && `작성 ${esc(st.author)}`, `${esc(st.formation)} vs ${esc(st.awayFormation)}`, fmtDate(st.updatedAt)].filter(Boolean).join(' · ')}</div>

      <div class="scenes" id="sceneBar">
        <button id="playBtn" class="play">${S.play ? '■ 정지' : '▶ 재생'}</button>
        ${st.scenes.map((s, i) => `<button data-scene="${i}" class="${i === S.scene ? 'on' : ''}" title="${esc(s.title)}">${i + 1}${s.title ? ' ' + esc(s.title.slice(0, 8)) : ''}</button>`).join('')}
        ${ed ? '<button id="addScene" title="지금 장면에서 동선대로 움직인 다음 장면을 만듭니다">+ 장면</button>' : ''}
      </div>
      ${ed ? toolBar() : ''}

      <div class="pitch-wrap${ed ? ' edit' : ''}"><svg id="pitch" class="pitch ${ed ? 'editable' : ''}" viewBox="-3 -3 74 111" xmlns="http://www.w3.org/2000/svg">${fieldSvg()}<g id="dyn"></g></svg></div>
      <div class="legend">
        <span><i class="dot" style="background:var(--home)"></i>우리 팀 (위로 공격)</span>
        <span><i class="dot" style="background:var(--away)"></i>상대 팀</span>
        <span><i style="border-color:var(--run)"></i>달리기</span>
        <span><i style="border-color:var(--pass);border-top-style:dashed"></i>패스</span>
        <span><i style="border-color:var(--dribble);border-top-style:dotted"></i>드리블</span>
      </div>
      <div class="row end" style="margin-top:6px">
        <span class="hint grow" style="margin:0">재생 속도</span>
        <button id="speedBtn">${S.speed}x</button>
        <button id="linkBtn" title="이 전술 링크 복사">🔗 링크 복사</button>
      </div>

      ${ed ? editorPanel(st, sc) : `<div id="sceneMemo" class="scene-memo">${sceneMemoText(sc)}</div>`}

      <h3>전체 전략 메모</h3>
      ${ed ? `<textarea id="stMemo" rows="4" maxlength="3000" placeholder="이 전술의 목표, 핵심 약속 등">${esc(st.memo)}</textarea>` : st.memo ? `<div class="memo-box">${esc(st.memo)}</div>` : '<div class="hint">메모 없음</div>'}

      <h3>라인업 · 역할</h3>
      <div class="lineup">${st.lineup.map((l, i) => slotHtml(l, i, ed, pm, st)).join('')}</div>
      ${ed && !S.doc.team.players.length ? '<p class="hint">선수단 탭에서 선수를 등록하면 자리마다 선수를 배정할 수 있습니다.</p>' : ''}

      ${ed ? '<div class="row end" style="margin-top:24px"><button id="delStrategy" class="danger">전술 삭제</button></div>' : ''}
    `;
    bindStrategy(st);
    drawDyn();
  }

  function sceneMemoText(sc) {
    if (!sc.title && !sc.memo) return '';
    return `${sc.title ? `<b>${esc(sc.title)}</b>${sc.memo ? '\n' : ''}` : ''}${esc(sc.memo)}`;
  }

  function toolBar() {
    const toolBtn = (id, label, title) => `<button data-tool="${id}" class="${S.tool === id ? 'on' : ''}" title="${title}">${label}</button>`;
    return `<div class="tools" id="tools">
        ${toolBtn('move', '✋<small>이동</small>', '선수·공 옮기기')}
        ${toolBtn('run', '<span class="sw" style="border-color:var(--run)"></span><small>달리기</small>', '달리기 동선')}
        ${toolBtn('pass', '<span class="sw" style="border-color:var(--pass);border-top-style:dashed"></span><small>패스</small>', '패스')}
        ${toolBtn('dribble', '<span class="sw" style="border-color:var(--dribble);border-top-style:dotted"></span><small>드리블</small>', '드리블')}
        ${toolBtn('erase', '🧽<small>지우기</small>', '선 지우기')}
        <button id="undoBtn" title="되돌리기" ${S.undo.length ? '' : 'disabled'}>↶<small>취소</small></button>
      </div>
      <p class="hint tool-hint" id="toolHint">${toolHint()}</p>`;
  }

  function editorPanel(st, sc) {
    const opts = (sel) => F.NAMES.map((n) => `<option ${n === sel ? 'selected' : ''}>${n}</option>`).join('');
    return `
      <h3>장면 ${S.scene + 1}</h3>
      <div class="row"><input id="scTitle" class="grow" maxlength="40" placeholder="장면 이름 (예: 빌드업)" value="${esc(sc.title)}" /></div>
      <textarea id="scMemo" rows="3" maxlength="1000" placeholder="이 장면 설명 (재생할 때 함께 보입니다)" style="margin-top:6px">${esc(sc.memo)}</textarea>
      <div class="row" style="margin-top:6px">
        <button id="clearArrows" class="grow">이 장면 선 모두 지우기</button>
        <button id="delScene" class="danger grow" ${st.scenes.length > 1 ? '' : 'disabled'}>장면 삭제</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="grow">우리 포메이션<select id="homeF">${opts(st.formation)}</select></label>
        <label class="grow">상대 포메이션<select id="awayF">${opts(st.awayFormation)}</select></label>
      </div>`;
  }

  function toolHint() {
    return {
      move: '선수나 공을 끌어서 옮기세요.',
      run: '선수에서 시작해 달릴 길을 그리세요.',
      pass: '공에서 받을 곳까지 그리세요. 공이 따라갑니다.',
      dribble: '공 가진 선수에서 그리면 공과 함께 갑니다.',
      erase: '지울 선을 누르세요.',
    }[S.tool];
  }

  function slotHtml(l, i, ed, pm, st) {
    const p = l.playerId && pm.get(l.playerId);
    if (!ed) {
      return `<div class="slot"><div class="pos">${esc(l.pos)}</div><div>${p ? `${p.number != null ? '#' + p.number + ' ' : ''}<b>${esc(p.name)}</b>` : '<span class="hint">미배정</span>'}</div>${l.role ? `<div class="role">${esc(l.role)}</div>` : ''}</div>`;
    }
    const used = new Map(st.lineup.map((x, j) => [x.playerId, j]));
    const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
    return `<div class="slot">
      <div class="pos"><input data-pos="${i}" maxlength="6" value="${esc(l.pos)}" aria-label="포지션" /></div>
      <select data-player="${i}"><option value="">— 미배정 —</option>${players
        .map((pl) => {
          const j = used.get(pl.id);
          const mark = j != null && j !== i ? ` (${st.lineup[j].pos} 자리)` : '';
          return `<option value="${pl.id}" ${pl.id === l.playerId ? 'selected' : ''}>${pl.number != null ? '#' + pl.number + ' ' : ''}${esc(pl.name)}${pl.pos ? ' · ' + esc(pl.pos) : ''}${esc(mark)}</option>`;
        })
        .join('')}</select>
      <textarea data-role="${i}" rows="1" maxlength="300" placeholder="역할 메모 (예: 오버래핑 자제, 세트피스 키커)">${esc(l.role)}</textarea>
    </div>`;
  }

  function bindStrategy(st) {
    $('#sceneBar').onclick = (e) => {
      if (e.target.closest('#playBtn')) return;
      const b = e.target.closest('[data-scene]');
      if (!b) return;
      stopPlay();
      S.scene = +b.dataset.scene;
      sceneHash(S.scene);
      renderStrategy();
    };
    $('#playBtn').onclick = () => (S.play ? stopPlay() : startPlay());
    $('#speedBtn').onclick = (e) => {
      S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
      e.target.textContent = S.speed + 'x';
    };
    $('#linkBtn').onclick = copyLink;
    bindPitch();
    if (!isEditor()) return;

    const onText = (sel, fn) => {
      const el = $(sel);
      if (el) el.oninput = () => (fn(el.value), changed());
    };
    onText('#stTitle', (v) => (S.work.title = v));
    onText('#stMemo', (v) => (S.work.memo = v));
    onText('#scTitle', (v) => (S.work.scenes[S.scene].title = v));
    onText('#scMemo', (v) => (S.work.scenes[S.scene].memo = v));
    // 이름 바뀐 장면 버튼은 입력을 마쳤을 때 다시 그린다 (입력 중 포커스 유지)
    $('#scTitle').onchange = () => renderStrategy();

    $('#tools').onclick = (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      S.tool = b.dataset.tool;
      for (const x of document.querySelectorAll('[data-tool]')) x.classList.toggle('on', x === b);
      $('#toolHint').textContent = toolHint();
      drawDyn(); // 지우기 모드에서는 선을 누르기 쉽게 그린다
    };
    $('#undoBtn').onclick = undo;
    $('#clearArrows').onclick = () => {
      const sc = S.work.scenes[S.scene];
      if (!sc.arrows.length) return;
      pushUndo();
      sc.arrows = [];
      changed();
      drawDyn();
    };
    $('#delScene').onclick = () => {
      if (S.work.scenes.length < 2 || !confirm(`장면 ${S.scene + 1}을(를) 삭제할까요?`)) return;
      pushUndo();
      S.work.scenes.splice(S.scene, 1);
      S.scene = Math.max(0, S.scene - 1);
      sceneHash(S.scene);
      changed();
      renderStrategy();
    };
    $('#addScene').onclick = addScene;
    $('#homeF').onchange = (e) => applyFormation('home', e.target.value);
    $('#awayF').onchange = (e) => applyFormation('away', e.target.value);
    $('#delStrategy').onclick = deleteStrategy;

    const lineup = $('.lineup');
    lineup.oninput = (e) => {
      const t = e.target;
      if (t.dataset.pos != null) S.work.lineup[+t.dataset.pos].pos = t.value.trim();
      else if (t.dataset.role != null) S.work.lineup[+t.dataset.role].role = t.value;
      else return;
      changed();
      if (t.dataset.pos != null) drawDyn();
    };
    lineup.onchange = (e) => {
      const t = e.target;
      if (t.dataset.player == null) return;
      pushUndo();
      const i = +t.dataset.player;
      const id = t.value || null;
      // 다른 자리에 있던 선수를 고르면 그 자리는 비운다
      if (id) for (const l of S.work.lineup) if (l.playerId === id) l.playerId = null;
      S.work.lineup[i].playerId = id;
      changed();
      renderStrategy();
    };
  }

  function copyLink() {
    const url = location.href;
    const done = () => toast('링크를 복사했습니다.');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
    else prompt('링크를 복사하세요', url);
  }

  function pushUndo() {
    S.undo.push(JSON.stringify(S.work));
    if (S.undo.length > 40) S.undo.shift();
    const b = $('#undoBtn');
    if (b) b.disabled = false;
  }

  function undo() {
    const prev = S.undo.pop();
    if (!prev) return;
    const rev = S.work.rev;
    S.work = JSON.parse(prev);
    S.work.rev = rev; // 서버 기준 버전은 그대로 유지
    S.scene = Math.min(S.scene, S.work.scenes.length - 1);
    changed();
    renderStrategy();
  }

  function addScene() {
    stopPlay();
    pushUndo();
    const sc = S.work.scenes[S.scene];
    if (S.work.scenes.length >= 30) return toast('장면은 30개까지 만들 수 있습니다.');
    const next = clone(sc);
    const pos = nextPositions(sc);
    for (const k of KEYS) setPos(next, k, pos[k]);
    next.id = Math.random().toString(36).slice(2, 12);
    next.title = '';
    next.memo = '';
    next.arrows = [];
    S.work.scenes.splice(S.scene + 1, 0, next);
    S.scene += 1;
    sceneHash(S.scene);
    changed();
    renderStrategy();
    toast(sc.arrows.length ? '동선 끝 위치로 옮긴 다음 장면을 만들었습니다.' : '같은 위치로 다음 장면을 만들었습니다.');
  }

  function applyFormation(side, name) {
    const st = S.work;
    const label = side === 'home' ? '우리 팀' : '상대 팀';
    if (!confirm(`지금 장면(${S.scene + 1})의 ${label} 위치를 ${name} 기본 위치로 바꿀까요?${side === 'home' ? '\n선수 배정은 자리 순서대로 유지되고 포지션 이름이 바뀝니다.' : ''}`)) {
      $(side === 'home' ? '#homeF' : '#awayF').value = side === 'home' ? st.formation : st.awayFormation;
      return;
    }
    pushUndo();
    const ps = F.positions(name, side);
    const sc = st.scenes[S.scene];
    sc[side] = ps.map((p) => [p.x, p.y]);
    if (side === 'home') {
      st.formation = name;
      st.lineup.forEach((l, i) => (l.pos = ps[i].pos));
    } else st.awayFormation = name;
    changed();
    renderStrategy();
  }

  async function deleteStrategy() {
    if (!confirm(`“${S.work.title}” 전술을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    clearTimeout(S.saveTimer);
    S.dirty = false;
    try {
      const r = await api('DELETE', `api/strategies/${S.work.id}`);
      S.doc.strategies = S.doc.strategies.filter((s) => s.id !== S.work.id);
      S.doc.version = r.version;
      S.work = null;
      location.hash = '#/';
      toast('삭제했습니다.');
    } catch (err) {
      if (err.status === 401) logout(err.message);
      else toast(err.message);
    }
  }

  // ---------- 경기장 ----------
  function fieldSvg() {
    const stripes = Array.from({ length: 10 }, (_, i) => `<rect x="0" y="${i * 10.5}" width="${W}" height="10.5" fill="${i % 2 ? '#2b7a34' : '#2f8538'}"/>`).join('');
    const ln = 'stroke="#ffffffd0" stroke-width="0.28" fill="none"';
    const arrowDefs = ['run', 'pass', 'dribble']
      .map(
        (k) =>
          `<marker id="ah-${k}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="2.6" markerHeight="2.6" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--${k})"/></marker>`
      )
      .join('');
    return `<defs>${arrowDefs}</defs>
      <rect x="-3" y="-3" width="74" height="111" fill="#276d2f"/>
      ${stripes}
      <g ${ln}>
        <rect x="0" y="0" width="${W}" height="${L}"/>
        <line x1="0" y1="52.5" x2="${W}" y2="52.5"/>
        <circle cx="34" cy="52.5" r="9.15"/>
        <rect x="13.84" y="0" width="40.32" height="16.5"/>
        <rect x="24.84" y="0" width="18.32" height="5.5"/>
        <path d="M26.69,16.5 A9.15,9.15 0 0 0 41.31,16.5"/>
        <rect x="13.84" y="88.5" width="40.32" height="16.5"/>
        <rect x="24.84" y="99.5" width="18.32" height="5.5"/>
        <path d="M26.69,88.5 A9.15,9.15 0 0 1 41.31,88.5"/>
        <rect x="30.34" y="-1.8" width="7.32" height="1.8"/>
        <rect x="30.34" y="105" width="7.32" height="1.8"/>
      </g>
      <g fill="#ffffffd0"><circle cx="34" cy="52.5" r="0.35"/><circle cx="34" cy="11" r="0.3"/><circle cx="34" cy="94" r="0.3"/></g>`;
  }

  function getPos(sc, k) {
    if (k === 'ball') return sc.ball;
    return (k[0] === 'h' ? sc.home : sc.away)[+k.slice(1)];
  }
  function setPos(sc, k, p) {
    const v = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    if (k === 'ball') sc.ball = v;
    else (k[0] === 'h' ? sc.home : sc.away)[+k.slice(1)] = v;
  }

  // 장면의 동선(화살표)을 끝까지 따라갔을 때의 위치
  function nextPositions(sc) {
    const pos = {};
    for (const k of KEYS) pos[k] = getPos(sc, k);
    for (const a of sc.arrows) {
      const end = a.points[a.points.length - 1];
      if (a.owner) pos[a.owner] = end;
      if (a.kind === 'dribble' && a.withBall) pos.ball = end;
    }
    return pos;
  }

  function pathD(pts) {
    let d = `M${pts[0][0]},${pts[0][1]}`;
    if (pts.length === 2) return d + ` L${pts[1][0]},${pts[1][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q${pts[i][0]},${pts[i][1]} ${mx},${my}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last[0]},${last[1]}`;
  }

  function arrowSvg(a, opacity = 1) {
    const style = {
      run: 'style="stroke:var(--run)" stroke-width="0.45"',
      pass: 'style="stroke:var(--pass)" stroke-width="0.45" stroke-dasharray="1.4 0.9"',
      dribble: 'style="stroke:var(--dribble)" stroke-width="0.55" stroke-dasharray="0.15 0.75" stroke-linecap="round"',
    }[a.kind];
    const d = pathD(a.points);
    return `<g opacity="${opacity}"><path d="${d}" fill="none" ${style} stroke-linejoin="round" marker-end="url(#ah-${a.kind})"/>${
      S.tool === 'erase' && isEditor() ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="3"/>` : ''
    }</g>`;
  }

  function tokenSvg(k, p, pm, st) {
    const [x, y] = p;
    if (k === 'ball') {
      return `<g class="token"><circle cx="${x}" cy="${y}" r="0.95" fill="#fff" stroke="#111" stroke-width="0.25"/><circle cx="${x}" cy="${y}" r="0.35" fill="#111"/></g>`;
    }
    const i = +k.slice(1);
    const home = k[0] === 'h';
    const posLabel = home ? st.lineup[i].pos : F.positions(st.awayFormation, 'away')[i].pos;
    const gk = posLabel === 'GK';
    const fill = home ? (gk ? 'var(--home-gk)' : 'var(--home)') : gk ? 'var(--away-gk)' : 'var(--away)';
    const player = home && st.lineup[i].playerId ? pm.get(st.lineup[i].playerId) : null;
    const inner = player && player.number != null ? String(player.number) : posLabel;
    const fs = inner.length > 2 ? 1.25 : 1.9;
    const below = home ? (player ? player.name : posLabel) : '';
    const sel = S.drag && S.drag.key === k ? ' selected' : '';
    return `<g class="token${sel}">
      <circle class="body" cx="${x}" cy="${y}" r="2.1" style="fill:${fill}" stroke="#fff" stroke-width="0.3"/>
      <text x="${x}" y="${y + fs * 0.36}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff">${esc(inner)}</text>
      ${below ? `<text class="label" x="${x}" y="${y + 3.9}" text-anchor="middle" font-size="1.6" fill="#fff">${esc(below.slice(0, 6))}</text>` : ''}
    </g>`;
  }

  // frame: { pos(k), arrows, arrowOpacity }
  function drawDyn(frame) {
    const g = $('#dyn');
    const st = current();
    if (!g || !st) return;
    const sc = st.scenes[S.scene];
    const f = frame || { pos: (k) => getPos(sc, k), arrows: sc.arrows, arrowOpacity: 1 };
    const pm = playersById();
    let html = f.arrows.map((a) => arrowSvg(a, f.arrowOpacity)).join('');
    if (S.draw && S.draw.points.length > 1) html += arrowSvg({ kind: S.draw.kind, points: S.draw.points }, 0.8);
    html += KEYS.filter((k) => k[0] === 'a').map((k) => tokenSvg(k, f.pos(k), pm, st)).join('');
    html += KEYS.filter((k) => k[0] === 'h').map((k) => tokenSvg(k, f.pos(k), pm, st)).join('');
    html += tokenSvg('ball', f.pos('ball'), pm, st);
    g.innerHTML = html;
  }

  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.min(W + 2, Math.max(-2, p.x)), Math.min(L + 2, Math.max(-2, p.y))];
  }

  function nearest(sc, p, max, filter) {
    let best = null;
    let bd = max;
    for (const k of KEYS) {
      if (filter && !filter(k)) continue;
      const d = dist(getPos(sc, k), p);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  function segDist(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
  }

  // 손으로 그린 선의 점을 줄인다 (Ramer–Douglas–Peucker)
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    let idx = 0;
    let max = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max <= eps) return [pts[0], pts[pts.length - 1]];
    return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
  }

  function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
    return s;
  }

  function bindPitch() {
    const svg = $('#pitch');
    if (!isEditor()) return;
    const isPlayer = (k) => k !== 'ball';

    svg.addEventListener('pointerdown', (e) => {
      if (S.play || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const sc = S.work.scenes[S.scene];
      const p = svgPoint(svg, e);
      if (S.tool === 'move') {
        const k = nearest(sc, p, 1.6, (k) => k === 'ball') || nearest(sc, p, 4);
        if (!k) return;
        S.undo.push(JSON.stringify(S.work));
        S.drag = { key: k, moved: false, off: [getPos(sc, k)[0] - p[0], getPos(sc, k)[1] - p[1]] };
      } else if (S.tool === 'erase') {
        let hit = -1;
        let best = 2.5;
        sc.arrows.forEach((a, i) => {
          for (let j = 1; j < a.points.length; j++) {
            const d = segDist(p, a.points[j - 1], a.points[j]);
            if (d < best) {
              best = d;
              hit = i;
            }
          }
        });
        if (hit >= 0) {
          pushUndo();
          sc.arrows.splice(hit, 1);
          changed();
          drawDyn();
        }
        return;
      } else {
        let owner = null;
        let start = p;
        let withBall = false;
        if (S.tool === 'pass') {
          owner = 'ball';
          if (dist(sc.ball, p) < 5) start = sc.ball;
          else {
            const k = nearest(sc, p, 4, isPlayer);
            if (k) start = getPos(sc, k);
          }
        } else {
          owner = nearest(sc, p, 4, isPlayer);
          if (owner) start = getPos(sc, owner);
          withBall = S.tool === 'dribble' && dist(sc.ball, start) < 4;
        }
        S.draw = { kind: S.tool, owner, withBall, points: [start.slice()] };
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    svg.addEventListener('pointermove', (e) => {
      if (!S.drag && !S.draw) return;
      const p = svgPoint(svg, e);
      if (S.drag) {
        const sc = S.work.scenes[S.scene];
        setPos(sc, S.drag.key, [p[0] + S.drag.off[0], p[1] + S.drag.off[1]]);
        S.drag.moved = true;
        drawDyn();
      } else {
        const pts = S.draw.points;
        if (dist(pts[pts.length - 1], p) >= 0.7) {
          pts.push(p);
          drawDyn();
        }
      }
    });

    const end = () => {
      if (S.drag) {
        if (S.drag.moved) {
          changed();
          const b = $('#undoBtn');
          if (b) b.disabled = false;
        } else S.undo.pop();
        S.drag = null;
        drawDyn();
      } else if (S.draw) {
        const d = S.draw;
        S.draw = null;
        const pts = simplify(d.points, 0.45);
        if (pathLength(pts) >= 2.5) {
          pushUndo();
          const sc = S.work.scenes[S.scene];
          if (sc.arrows.length >= 60) toast('한 장면에 선은 60개까지 그릴 수 있습니다.');
          else {
            sc.arrows.push({ id: Math.random().toString(36).slice(2, 12), kind: d.kind, owner: d.owner, withBall: d.withBall, points: pts.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]) });
            changed();
          }
        }
        drawDyn();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  // ---------- 재생 ----------
  function startPlay() {
    const st = current();
    if (!st) return;
    const hasMove = st.scenes.length > 1 || st.scenes[0].arrows.length;
    if (!hasMove) return toast('동선(선)을 그리거나 장면을 2개 이상 만들면 재생할 수 있습니다.');
    // 마지막 장면이면 처음부터, 아니면 지금 장면부터
    const from = S.scene >= st.scenes.length - 1 && st.scenes.length > 1 ? 0 : S.scene;
    S.play = { st: clone(st), i: from, phase: 'hold', t0: performance.now(), raf: 0, paths: null };
    S.scene = from;
    updatePlayUi();
    S.play.raf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    if (!S.play) return;
    cancelAnimationFrame(S.play.raf);
    S.play = null;
    if (S.route.view === 'strategy' && $('#pitch')) {
      updatePlayUi();
      drawDyn();
    }
  }

  function updatePlayUi() {
    const b = $('#playBtn');
    if (b) b.textContent = S.play ? '■ 정지' : '▶ 재생';
    for (const x of document.querySelectorAll('#sceneBar [data-scene]')) x.classList.toggle('on', +x.dataset.scene === S.scene);
    const st = S.play ? S.play.st : current();
    const memo = $('#sceneMemo');
    if (memo && st) memo.innerHTML = sceneMemoText(st.scenes[S.scene]);
  }

  function buildPaths(st, i) {
    const sc = st.scenes[i];
    const target = i < st.scenes.length - 1 ? st.scenes[i + 1] : null;
    const tp = target ? null : nextPositions(sc);
    const paths = {};
    for (const k of KEYS) {
      const pts = [getPos(sc, k)];
      for (const a of sc.arrows) {
        if (a.owner === k || (k === 'ball' && a.kind === 'dribble' && a.withBall)) pts.push(...a.points.slice(1));
      }
      pts.push(target ? getPos(target, k) : tp[k]);
      const clean = pts.filter((q, j) => j === 0 || dist(q, pts[j - 1]) > 0.05);
      const cum = [0];
      for (let j = 1; j < clean.length; j++) cum.push(cum[j - 1] + dist(clean[j - 1], clean[j]));
      paths[k] = { pts: clean, cum, len: cum[cum.length - 1] };
    }
    return paths;
  }

  function along(path, t) {
    if (path.len === 0) return path.pts[0];
    const d = t * path.len;
    let j = 1;
    while (j < path.cum.length - 1 && path.cum[j] < d) j++;
    const seg = path.cum[j] - path.cum[j - 1] || 1;
    const u = (d - path.cum[j - 1]) / seg;
    const a = path.pts[j - 1];
    const b = path.pts[j];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function tick(now) {
    const P = S.play;
    if (!P || !$('#pitch')) return;
    const HOLD = 1000 / S.speed;
    const MOVE = 2000 / S.speed;
    const st = P.st;
    const sc = st.scenes[P.i];
    const last = P.i >= st.scenes.length - 1;
    const el = now - P.t0;
    if (P.phase === 'hold') {
      drawDyn({ pos: (k) => getPos(sc, k), arrows: sc.arrows, arrowOpacity: 1 });
      if (el >= HOLD) {
        if (last && !sc.arrows.length) return finishPlay(P.i);
        P.phase = 'move';
        P.t0 = now;
        P.paths = buildPaths(st, P.i);
      }
    } else if (P.phase === 'move') {
      const t = Math.min(1, el / MOVE);
      const e = ease(t);
      drawDyn({ pos: (k) => along(P.paths[k], e), arrows: sc.arrows, arrowOpacity: 0.35 * (1 - t) + 0.15 });
      if (t >= 1) {
        if (last) {
          // 마지막 장면의 동선 끝 위치에서 잠시 멈춘 뒤 끝낸다
          P.phase = 'end';
          P.t0 = now;
        } else {
          P.i += 1;
          P.phase = 'hold';
          P.t0 = now;
          S.scene = P.i;
          updatePlayUi();
        }
      }
    } else if (el >= HOLD) return finishPlay(P.i);
    P.raf = requestAnimationFrame(tick);
  }

  function finishPlay(i) {
    const P = S.play;
    S.play = null;
    S.scene = i;
    sceneHash(i);
    updatePlayUi();
    if (P && P.phase === 'end') return; // 동선 끝 위치를 그대로 보여 준다 (장면을 누르면 원래대로)
    drawDyn();
  }

  // ---------- 선수단 ----------
  function renderRoster() {
    const ed = isEditor();
    if (!ed) {
      const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
      view.innerHTML = `<h2>선수단 ${players.length}명</h2>${
        players.length
          ? `<div class="players">${players
              .map((p) => `<div class="player view"><span class="num">${p.number ?? ''}</span><b>${esc(p.name)}</b><span class="ppos">${esc(p.pos)}</span></div>`)
              .join('')}</div>`
          : '<div class="empty">아직 등록된 선수가 없습니다.</div>'
      }`;
      return;
    }
    if (!S.roster) S.roster = clone(S.doc.team);
    const r = S.roster;
    const posOpts = (sel) => `<option value="">포지션</option>${POSITIONS.map((p) => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('')}`;
    view.innerHTML = `
      <h2>팀 이름</h2>
      <input id="teamNameInput" maxlength="40" value="${esc(r.name)}" />
      <div class="row"><h2 class="grow">선수단 ${r.players.length}명</h2><button id="addPlayer">+ 선수 추가</button></div>
      <p class="hint">등번호 · 이름 · 주 포지션. 전술 화면의 라인업에서 자리마다 선수를 배정합니다.</p>
      <div class="players">${r.players
        .map(
          (p, i) => `<div class="player">
            <input data-i="${i}" data-f="number" type="number" inputmode="numeric" min="0" max="99" placeholder="번호" value="${p.number ?? ''}" />
            <input data-i="${i}" data-f="name" maxlength="20" placeholder="이름" value="${esc(p.name)}" />
            <select data-i="${i}" data-f="pos">${posOpts(p.pos)}</select>
            <button data-del="${i}" class="danger" aria-label="삭제">✕</button>
          </div>`
        )
        .join('')}</div>
      <div class="row end" style="margin-top:14px">
        <span id="rosterStatus" class="status">${S.rosterDirty ? '저장 안 됨' : ''}</span>
        <button id="saveRoster" class="primary">선수단 저장</button>
      </div>`;
    const mark = () => {
      S.rosterDirty = true;
      $('#rosterStatus').textContent = '저장 안 됨';
    };
    $('#teamNameInput').oninput = (e) => ((r.name = e.target.value), mark());
    $('#addPlayer').onclick = () => {
      if (r.players.length >= 40) return toast('선수는 40명까지 등록할 수 있습니다.');
      r.players.push({ id: Math.random().toString(36).slice(2, 12), name: '', number: null, pos: '' });
      S.rosterDirty = true;
      renderRoster();
      const inputs = document.querySelectorAll('[data-f="name"]');
      inputs[inputs.length - 1]?.focus();
    };
    const players = $('.players');
    const onField = (e) => {
      const t = e.target;
      if (t.dataset.i == null) return;
      const p = r.players[+t.dataset.i];
      if (t.dataset.f === 'number') p.number = t.value === '' ? null : Math.max(0, Math.min(99, parseInt(t.value, 10) || 0));
      else p[t.dataset.f] = t.value;
      mark();
    };
    players.oninput = onField;
    players.onchange = onField;
    players.onclick = (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      const p = r.players[+b.dataset.del];
      if (p.name && !confirm(`${p.name} 선수를 삭제할까요? 전술 라인업에서도 빠집니다.`)) return;
      r.players.splice(+b.dataset.del, 1);
      S.rosterDirty = true;
      renderRoster();
    };
    $('#saveRoster').onclick = async () => {
      const unnamed = r.players.filter((p) => !p.name.trim()).length;
      if (unnamed && !confirm(`이름이 없는 선수 ${unnamed}명은 저장되지 않습니다. 계속할까요?`)) return;
      try {
        const res = await api('PUT', 'api/team', r);
        S.doc.team = res.team;
        S.doc.version = res.version;
        await loadDoc(); // 라인업에서 빠진 선수 반영
        S.roster = clone(S.doc.team);
        S.rosterDirty = false;
        S.work = null;
        render();
        toast('선수단을 저장했습니다.');
      } catch (err) {
        if (err.status === 401) logout(err.message);
        else toast(err.message);
      }
    };
  }

  // ---------- 로그인 ----------
  const dlg = $('#loginDlg');
  $('#lockBtn').onclick = async () => {
    if (isEditor()) {
      if (!confirm('편집을 마치고 보기 모드로 바꿀까요? (이 기기에 기억된 비밀번호도 지웁니다)')) return;
      await saveNow();
      logout('보기 모드로 바꿨습니다.');
      return;
    }
    $('#loginName').value = S.name;
    $('#loginPass').value = '';
    $('#loginErr').hidden = true;
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => (S.name ? $('#loginPass') : $('#loginName')).focus(), 50);
  };
  $('#loginCancel').onclick = () => dlg.close();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const pass = $('#loginPass').value;
    const remember = $('#loginRemember').checked;
    try {
      await api('POST', 'api/login', {}, pass);
      S.key = pass;
      S.name = $('#loginName').value.trim();
      local.set('soccer.key', pass, remember);
      local.set('soccer.name', S.name);
      dlg.close();
      S.work = null;
      toast('편집할 수 있습니다.');
      render();
    } catch (err) {
      const box = $('#loginErr');
      box.textContent = err.message;
      box.hidden = false;
    }
  };

  $('#backBtn').onclick = () => (location.hash = '#/');

  // ---------- 다른 사람이 바꾼 내용 반영 ----------
  function busy() {
    const a = document.activeElement;
    const typing = a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    return S.drag || S.draw || S.play || S.dirty || S.saving || S.rosterDirty || typing || dlg.open;
  }

  async function poll() {
    if (document.hidden || !S.doc) return;
    try {
      const { version } = await api('GET', 'api/version');
      if (version === S.doc.version || busy()) return;
      await loadDoc();
      if (busy()) return;
      if (S.work) {
        const fresh = strategyById(S.work.id);
        if (fresh && fresh.rev !== S.work.rev) {
          S.work = clone(fresh);
          S.undo = [];
        }
      }
      render();
    } catch {}
  }
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);

  // ---------- 시작 ----------
  window.addEventListener('hashchange', onRoute);
  (async () => {
    try {
      await loadDoc();
    } catch (err) {
      view.innerHTML = `<div class="empty">서버에 연결하지 못했습니다.<br>${esc(err.message)}<br><br>무료 서버는 처음 접속할 때 깨어나느라 1분 정도 걸릴 수 있습니다. 잠시 뒤 새로고침하세요.</div>`;
      return;
    }
    S.route = parseRoute();
    S.scene = S.route.scene || 0;
    render();
  })();
})();
