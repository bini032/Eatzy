/* 축구 전술 보드 화면. 서버 API는 상대 주소(api/...)로 불러서 /나 /soccer/ 어디에 올려도 동작한다. */
(function () {
  'use strict';
  const F = window.Formations;
  const W = F.W;
  const L = F.L;
  const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LM', 'RM', 'LW', 'RW', 'ST'];
  const KIND_LABEL = { run: '달리기', pass: '패스', dribble: '드리블', shot: '슛' };
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
    key: local.get('soccer.session'), // 로그인 토큰 (전략 제시자)
    me: null, // { id, name, admin } 서버가 토큰으로 알려 준 내 계정
    route: { view: 'list' },
    work: null, // 편집 중인 전술 사본
    scene: 0,
    tool: 'flow', // flow: 끌어서 동선, move: 위치만 옮기기, erase: 선 지우기
    undo: [],
    dirty: false,
    saving: null,
    saveTimer: null,
    drag: null,
    draw: null,
    play: null,
    speed: 1,
    pick: null, // 명단에서 눌러 고른 선수 id (동그라미를 누르면 배정)
    dropKey: null, // 명단 이름표를 끄는 동안 받게 될 동그라미
    autoReact: local.get('soccer.autoReact') !== 'off', // "+ 장면" 때 상대 자동 반응
    view: null, // 경기장 확대 상태 { x, y, w, h } (viewBox), null이면 전체
    sug: null, // 다음 장면 추천 { mode: 'current'|'next', base, situation, ideas, i }
    roster: null, // 선수단 편집 사본
    rosterDirty: false,
  };

  // 로그인한 전략 제시자 (선수단 편집, 새 전술 만들기)
  const isEditor = () => !!(S.key && S.me);
  // 이 전술을 고칠 수 있는지: 만든 사람과 관리자. 계정 전에 만든 전술은 작성자 이름이 같은 사람
  function canEditSt(st) {
    if (!isEditor() || !st) return false;
    if (S.me.admin) return true;
    if (st.ownerId) return st.ownerId === S.me.id;
    return (st.author || '').trim().replace(/\s+/g, ' ').toLowerCase() === S.me.id;
  }
  // 지금 열린 전술을 편집 중인지
  const editing = () => !!(S.work && S.route.view === 'strategy' && S.work.id === S.route.id);
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
    if (key) headers['x-session'] = key;
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
    S.me = S.doc.me || null;
    // 토큰이 더는 통하지 않으면(로그아웃·서버 초기화) 조용히 보기 모드로
    if (S.key && !S.me) {
      S.key = null;
      local.del('soccer.session');
    }
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
    if (S.key) api('POST', 'api/logout').catch(() => {});
    S.key = null;
    S.me = null;
    S.work = null;
    S.roster = null;
    local.del('soccer.session');
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
    S.sug = null;
    if (prev.view !== 'strategy' || prev.id !== S.route.id) S.view = null;
    if (S.route.view === 'strategy') {
      if (prev.view !== 'strategy' || prev.id !== S.route.id) {
        S.work = null;
        S.undo = [];
        S.tool = 'flow';
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
    lock.textContent = isEditor() ? `👤 ${S.me.name}` : '🔒 보기';
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
                  <b>${esc(s.title)}</b>${s.origin === 'ai' ? ' <span class="badge ai">🤖 AI테스트</span>' : ''}${canEditSt(s) && !S.me.admin ? ' <span class="badge">내 전술</span>' : ''}
                  <div class="meta"><span class="author">✍ ${esc(s.author || '작성자 없음')}</span> · ${[`장면 ${s.scenes.length}개`, `${esc(s.formation)} vs ${esc(s.awayFormation)}`, fmtDate(s.updatedAt)].filter(Boolean).join(' · ')}</div>
                  ${s.memo ? `<div class="memo">${esc(s.memo)}</div>` : ''}
                </a>`
              )
              .join('')}</div>`
          : `<div class="empty">아직 전술이 없습니다.<br>${
              isEditor() ? '“+ 새 전술”로 첫 전술을 만들어 보세요.' : '전략 제시자는 오른쪽 위 “🔒 보기”를 눌러 로그인하면 전술을 추가할 수 있습니다.'
            }</div>`
      }`;
    const nb = $('#newBtn');
    if (nb) nb.onclick = openTemplateDlg;
  }

  // 새 전술의 라인업: 같은 포메이션의 최근 전술 배정을 이어받고, 없으면 주 포지션이 같은 자리에만 배정
  function lineupFor(formation, roles = {}) {
    const recent = [...S.doc.strategies].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const same = recent.find((x) => x.formation === formation);
    const base = F.positions(formation, 'home');
    if (same) {
      return base.map((d, i) => {
        const l = same.lineup[i] || {};
        return { pos: l.pos || d.pos, playerId: l.playerId || null, name: l.name || '', number: l.number ?? null, role: roles[i] || '' };
      });
    }
    const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
    const used = new Set();
    return base.map((d, i) => {
      const p = players.find((x) => !used.has(x.id) && x.pos === d.pos);
      if (p) used.add(p.id);
      return { pos: d.pos, playerId: p ? p.id : null, role: roles[i] || '' };
    });
  }

  async function createStrategy(body, msg) {
    try {
      const r = await api('POST', 'api/strategies', body);
      replaceInDoc(r.strategy);
      S.doc.version = r.version;
      location.hash = `#/s/${r.strategy.id}`;
      if (msg) toast(msg, 3500);
    } catch (err) {
      if (err.status === 401) logout(err.message);
      else toast(err.message);
    }
  }

  // 새 전술: 빈 전술 또는 추천 전술 고르기
  const tplDlg = $('#tplDlg');
  function openTemplateDlg() {
    const items = [{ key: '', title: '빈 전술', summary: '포메이션만 놓인 빈 경기장에서 직접 그리기', formation: '', scenes: 1 }, ...window.Templates.list];
    $('#tplList').innerHTML = items
      .map(
        (t) => `<button type="button" class="tpl" data-key="${t.key}">
          <b>${t.key ? '⭐ ' : '＋ '}${esc(t.title)}</b>
          <span>${esc(t.summary)}</span>
          ${t.key ? `<small>${esc(t.formation)} · 장면 ${t.scenes}개</small>` : ''}
        </button>`
      )
      .join('');
    tplDlg.showModal();
  }
  $('#tplCancel').onclick = () => tplDlg.close();
  $('#tplList').onclick = (e) => {
    const b = e.target.closest('.tpl');
    if (!b) return;
    tplDlg.close();
    const key = b.dataset.key;
    if (!key) {
      const recent = [...S.doc.strategies].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
      const formation = recent ? recent.formation : F.DEFAULT;
      return createStrategy({ title: '새 전술', formation, awayFormation: recent ? recent.awayFormation : F.DEFAULT, lineup: lineupFor(formation) });
    }
    const t = window.Templates.build(key);
    createStrategy(
      { title: t.title, memo: t.memo, formation: t.formation, awayFormation: t.awayFormation, lineup: lineupFor(t.formation, t.roles), scenes: t.scenes, origin: 'ai' },
      '추천 전술을 만들었습니다. ▶ 재생으로 보고, 원하는 대로 고치세요.'
    );
  };

  // 다른 사람 전술을 내 전술로 복사
  function copyStrategy(st) {
    const body = clone(st);
    body.title = `${st.title} (복사)`.slice(0, 60);
    createStrategy(body, '복사했습니다. 이제 이 전술은 내가 고칠 수 있습니다.');
  }

  // ---------- 전술 화면 ----------
  function current() {
    const base = strategyById(S.route.id);
    let st = base;
    if (base && canEditSt(base)) {
      if (!S.work || S.work.id !== base.id) S.work = clone(base);
      st = S.work;
    } else if (!S.dirty && !S.saving) S.work = null;
    return st && fillAway(st);
  }

  // 상대 팀 이름표가 생기기 전에 만든 전술은 포메이션 기본값으로 채운다
  function fillAway(st) {
    if (!Array.isArray(st.awayLineup) || st.awayLineup.length !== 11) {
      st.awayLineup = F.positions(st.awayFormation, 'away').map((d) => ({ pos: d.pos, name: '', number: null }));
    }
    return st;
  }

  // 동그라미 하나의 표시 정보. 우리 팀은 명단 선수 > 직접 적은 이름 순서
  function tokenInfo(st, k, pm) {
    const i = +k.slice(1);
    if (k[0] === 'a') {
      const a = st.awayLineup[i];
      return { pos: a.pos, number: a.number ?? null, name: a.name || '', role: '' };
    }
    const l = st.lineup[i];
    const p = l.playerId ? pm.get(l.playerId) : null;
    return p
      ? { pos: l.pos, number: p.number ?? null, name: p.name, role: l.role, player: p }
      : { pos: l.pos, number: l.number ?? null, name: l.name || '', role: l.role };
  }

  const nameText = (t) => (t.name ? `${t.number != null ? '#' + t.number + ' ' : ''}${t.name}` : t.number != null ? `#${t.number}` : '');

  function renderStrategy() {
    const st = current();
    if (!st) {
      view.innerHTML = `<div class="empty">전술을 찾을 수 없습니다. 지워졌을 수 있습니다.<br><br><a href="#/" style="color:var(--accent)">목록으로</a></div>`;
      return;
    }
    S.scene = Math.min(S.scene, st.scenes.length - 1);
    const ed = editing();
    const sc = st.scenes[S.scene];
    const pm = playersById();
    view.innerHTML = `
      <div class="title-row">
        ${ed ? `<input id="stTitle" maxlength="60" value="${esc(st.title)}" aria-label="전술 이름" />` : `<h2>${esc(st.title)}</h2>`}
        ${ed ? `<span id="saveStatus" class="status">${S.dirty ? '저장 대기' : '저장됨'}</span>` : ''}
      </div>
      <div class="hint"><span class="author">✍ ${esc(st.author || '작성자 없음')}</span>${st.origin === 'ai' ? ' <span class="badge ai">🤖 AI테스트</span>' : ''} · ${[`${esc(st.formation)} vs ${esc(st.awayFormation)}`, fmtDate(st.updatedAt)].filter(Boolean).join(' · ')}</div>
      ${st.origin === 'ai' ? '<p class="hint ai-note">AI가 시범으로 만든 추천 전술을 바탕으로 한 전술입니다. 팀에 맞게 고쳐 쓰세요.</p>' : ''}
      ${
        isEditor() && !ed
          ? `<div class="notice"><span class="grow">작성자(${esc(st.author || '알 수 없음')})만 수정할 수 있습니다.</span><button id="copyBtn" class="primary">복사해서 내 전술로</button></div>`
          : ''
      }

      <div class="scenes" id="sceneBar">
        <button id="playBtn" class="play">${S.play ? '■ 정지' : '▶ 재생'}</button>
        ${st.scenes.map((s, i) => `<button data-scene="${i}" class="${i === S.scene ? 'on' : ''}" title="${esc(s.title)}">${i + 1}${s.title ? ' ' + esc(s.title.slice(0, 8)) : ''}</button>`).join('')}
        ${ed ? '<button id="addScene" title="지금 장면에서 동선대로 움직인 다음 장면을 만듭니다">+ 장면</button>' : ''}
        ${ed ? `<button id="suggestBtn" class="${S.sug ? 'on' : ''}" title="지금 상황에 맞는 다음 동선 추천">✨ 추천</button>` : ''}
      </div>
      ${ed ? toolBar() : ''}
      ${ed ? (S.sug ? suggestHtml() : benchHtml(st)) : ''}

      <div class="pitch-wrap${ed ? ' edit' : ''}"><svg id="pitch" class="pitch ${ed ? 'editable' : ''}" viewBox="${viewBoxText()}" xmlns="http://www.w3.org/2000/svg">${fieldSvg()}<g id="dyn"></g></svg>
        <div class="zoom"><button data-zoom="in" aria-label="확대">＋</button><button data-zoom="out" aria-label="축소">－</button><button data-zoom="reset" aria-label="전체 보기">⤢</button></div>
      </div>
      <div class="legend">
        <span><i class="dot" style="background:var(--home)"></i>우리 팀 (위로 공격)</span>
        <span><i class="dot" style="background:var(--away)"></i>상대 팀</span>
        <span><i style="border-color:var(--run)"></i>달리기</span>
        <span><i style="border-color:var(--pass);border-top-style:dashed"></i>패스</span>
        <span><i style="border-color:var(--dribble);border-top-style:dotted"></i>드리블</span>
        <span><i style="border-color:var(--shot);border-top-width:4px"></i>슛</span>
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

      ${ed ? '<div class="row end" style="margin-top:24px"><button id="copyMine">복사본 만들기</button><button id="delStrategy" class="danger">전술 삭제</button></div>' : ''}
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
        ${toolBtn('flow', '👆<small>동선</small>', '끌어서 달리기·드리블·패스·슛')}
        ${toolBtn('move', '✋<small>배치</small>', '동선 없이 위치만 옮기기')}
        ${toolBtn('erase', '🧽<small>지우기</small>', '선 지우기')}
        <button id="undoBtn" title="되돌리기" ${S.undo.length ? '' : 'disabled'}>↶<small>취소</small></button>
      </div>
      <p class="hint tool-hint" id="toolHint">${toolHint()}</p>`;
  }

  // ---------- 상황별 다음 장면 추천 (규칙 기반, suggest.js) ----------
  function suggestHtml() {
    const g = S.sug;
    const idea = g.ideas[g.i];
    return `<div class="sug" id="sugBar">
      <div class="sug-head">
        <span class="grow">📍 ${esc(g.situation)}</span>
        ${idea ? `<button id="sugApply" class="primary">✓ ${g.mode === 'current' ? '이 장면에 적용' : '다음 장면으로'}</button>` : ''}
        <button id="sugClose" aria-label="추천 닫기">✕</button>
      </div>
      ${
        idea
          ? `<div class="sug-cards">${g.ideas.map((x, i) => `<button data-sug="${i}" class="${i === g.i ? 'on' : ''}">${esc(x.title)}</button>`).join('')}</div>
             <div class="sug-desc">${esc(idea.desc)}</div>`
          : `<div class="sug-desc">${esc(g.note || '이 상황에 맞는 추천이 없습니다. 공을 선수 가까이 옮겨 누가 공을 가졌는지 정해 보세요.')}</div>`
      }
    </div>`;
  }

  function openSuggest() {
    stopPlay();
    const st = S.work;
    const sc = st.scenes[S.scene];
    // 동선이 있으면 그 끝 위치에서 이어지는 다음 장면, 없으면 이 장면에 넣을 동선을 추천
    const mode = sc.arrows.length ? 'next' : 'current';
    const base = mode === 'next' ? nextScenePositions(st, sc) : Object.fromEntries(KEYS.map((k) => [k, getPos(sc, k)]));
    const r = window.Suggest.suggest(base, labelsOf(st));
    S.sug = { mode, base, situation: r.situation, ideas: r.ideas, note: r.note, i: 0 };
    renderStrategy();
  }

  function applySuggest() {
    const g = S.sug;
    const idea = g && g.ideas[g.i];
    if (!idea) return;
    const st = S.work;
    if (g.mode === 'next' && st.scenes.length >= 30) return toast('장면은 30개까지 만들 수 있습니다.');
    pushUndo();
    const arrows = idea.arrows.map((a) => ({ ...clone(a), id: Math.random().toString(36).slice(2, 12) }));
    const sc = st.scenes[S.scene];
    if (g.mode === 'current') {
      sc.arrows.push(...arrows);
      if (!sc.title) sc.title = idea.title;
      if (!sc.memo) sc.memo = `[AI테스트 추천] ${idea.desc}`;
    } else {
      const next = clone(sc);
      for (const k of KEYS) setPos(next, k, g.base[k]);
      Object.assign(next, { id: Math.random().toString(36).slice(2, 12), title: idea.title, memo: `[AI테스트 추천] ${idea.desc}`, arrows });
      st.scenes.splice(S.scene + 1, 0, next);
      S.scene += 1;
      sceneHash(S.scene);
    }
    S.sug = null;
    changed();
    renderStrategy();
    toast(`“${idea.title}” 동선을 넣었습니다. 끌어서 고치거나 ▶ 재생으로 확인하세요.`, 3500);
  }

  function bindSuggest() {
    const btn = $('#suggestBtn');
    if (btn) btn.onclick = () => (S.sug ? ((S.sug = null), renderStrategy()) : openSuggest());
    const bar = $('#sugBar');
    if (!bar) return;
    bar.onclick = (e) => {
      if (e.target.closest('#sugClose')) {
        S.sug = null;
        return renderStrategy();
      }
      if (e.target.closest('#sugApply')) return applySuggest();
      const c = e.target.closest('[data-sug]');
      if (!c) return;
      S.sug.i = +c.dataset.sug;
      for (const x of bar.querySelectorAll('[data-sug]')) x.classList.toggle('on', x === c);
      bar.querySelector('.sug-desc').textContent = S.sug.ideas[S.sug.i].desc;
      drawDyn();
    };
  }

  // 선수 명단 이름표: 끌어서 우리 팀 동그라미에 놓거나, 누른 뒤 동그라미를 누르면 배정
  function benchHtml(st) {
    const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
    if (!players.length) return '<p class="hint bench-empty">선수단 탭에서 명단을 먼저 등록하면 이름표를 끌어다 동그라미에 놓을 수 있습니다.</p>';
    const slotOf = new Map(st.lineup.map((l, i) => [l.playerId, i]));
    // 아직 자리가 없는 선수를 앞에 둔다
    players.sort((a, b) => (slotOf.has(a.id) ? 1 : 0) - (slotOf.has(b.id) ? 1 : 0));
    return `<div class="bench" id="bench">${players
      .map((p) => {
        const i = slotOf.get(p.id);
        const cls = ['chip', i != null ? 'used' : '', S.pick === p.id ? 'picked' : ''].join(' ');
        return `<span class="${cls}" data-pid="${p.id}">${p.number != null ? `<b>${p.number}</b>` : ''}${esc(p.name)}${i != null ? `<small>${esc(st.lineup[i].pos)}</small>` : ''}</span>`;
      })
      .join('')}</div>`;
  }

  function editorPanel(st, sc) {
    const opts = (sel) => F.NAMES.map((n) => `<option ${n === sel ? 'selected' : ''}>${n}</option>`).join('');
    return `
      <h3>장면 ${S.scene + 1}</h3>
      <div class="row"><input id="scTitle" class="grow" maxlength="40" placeholder="장면 이름 (예: 빌드업)" value="${esc(sc.title)}" /></div>
      <textarea id="scMemo" rows="3" maxlength="1000" placeholder="이 장면 설명 (재생할 때 함께 보입니다)" style="margin-top:6px">${esc(sc.memo)}</textarea>
      <label class="check" style="margin-top:8px"><input id="autoReact" type="checkbox" ${S.autoReact ? 'checked' : ''} /> “+ 장면” 때 상대 자동 반응 (공 압박, 침투 선수 따라붙기, 대형 이동)</label>
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
      flow: '선수를 끌면 달리기(공 가진 선수는 드리블), 공을 끌어 동료 근처에 놓으면 패스, 골문 앞에 놓으면 슛. 다시 끌면 바뀝니다.',
      move: '동선 없이 선수와 공의 위치만 옮깁니다. 시작 배치를 잡을 때 쓰세요.',
      erase: '지울 선을 누르세요.',
    }[S.tool] || '';
  }

  function slotHtml(l, i, ed, pm, st) {
    const t = tokenInfo(st, 'h' + i, pm);
    const who = nameText(t);
    if (!ed) {
      return `<div class="slot"><div class="pos">${esc(l.pos)}</div><div>${who ? `<b>${esc(who)}</b>` : '<span class="hint">미배정</span>'}</div>${l.role ? `<div class="role">${esc(l.role)}</div>` : ''}</div>`;
    }
    return `<div class="slot">
      <div class="pos"><input data-pos="${i}" maxlength="6" value="${esc(l.pos)}" aria-label="포지션" /></div>
      <button type="button" class="who" data-slot="${i}">${who ? `<b>${esc(who)}</b>${t.player ? '' : ' <small>(직접 입력)</small>'}` : '<span class="hint">눌러서 선수 지정</span>'}</button>
      <textarea data-role="${i}" rows="1" maxlength="300" placeholder="역할 메모 (예: 오버래핑 자제, 세트피스 키커)">${esc(l.role)}</textarea>
    </div>`;
  }

  function bindStrategy(st) {
    $('#sceneBar').onclick = (e) => {
      if (e.target.closest('#playBtn')) return;
      const b = e.target.closest('[data-scene]');
      if (!b) return;
      stopPlay();
      S.sug = null;
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
    bindZoom();
    const cb = $('#copyBtn');
    if (cb) cb.onclick = () => copyStrategy(st);
    bindPitch();
    if (!editing()) return;
    $('#copyMine').onclick = async () => {
      await saveNow();
      copyStrategy(S.work);
    };

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
    bindSuggest();
    $('#autoReact').onchange = (e) => {
      S.autoReact = e.target.checked;
      local.set('soccer.autoReact', S.autoReact ? 'on' : 'off');
    };
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
    lineup.onclick = (e) => {
      const b = e.target.closest('[data-slot]');
      if (b) openTokenDlg('h' + b.dataset.slot);
    };
    bindBench();
  }

  // 선수를 우리 팀 i번 자리에 배정. 이미 다른 자리에 있던 선수면 두 자리를 맞바꾼다
  function assignPlayer(i, pid) {
    const lineup = S.work.lineup;
    if (lineup[i].playerId === pid) return;
    pushUndo();
    const j = lineup.findIndex((l) => l.playerId === pid);
    if (j >= 0) lineup[j].playerId = lineup[i].playerId;
    lineup[i].playerId = pid;
    lineup[i].name = '';
    lineup[i].number = null;
    changed();
    const p = playersById().get(pid);
    toast(`${p ? p.name : '선수'} → ${lineup[i].pos} 자리${j >= 0 ? ' (자리 맞바꿈)' : ''}`);
  }

  function bindBench() {
    const bench = $('#bench');
    if (!bench) return;
    let d = null; // { pid, x, y, el, ghost }

    // 놓는 위치는 손가락이 아니라 화면에 보이는 이름표의 가운데 (이름표는 손가락 위쪽에 떠 있다)
    function dropTarget(ghost) {
      const g = ghost.getBoundingClientRect();
      const pt = { clientX: g.left + g.width / 2, clientY: g.top + g.height / 2 };
      const svg = $('#pitch');
      const r = svg.getBoundingClientRect();
      const inside = pt.clientX >= r.left && pt.clientX <= r.right && pt.clientY >= r.top && pt.clientY <= r.bottom;
      const k = inside ? nearest(S.work.scenes[S.scene], svgPoint(svg, pt), 7, (k) => k[0] === 'h') : null;
      return { inside, k };
    }
    function setDropKey(k) {
      if (S.dropKey === k) return;
      S.dropKey = k;
      drawDyn(); // 받게 될 동그라미에 노란 테두리
    }

    bench.addEventListener('pointerdown', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || S.play) return;
      d = { pid: chip.dataset.pid, x: e.clientX, y: e.clientY, el: chip, ghost: null };
      chip.setPointerCapture(e.pointerId);
    });
    bench.addEventListener('pointermove', (e) => {
      if (!d) return;
      if (!d.ghost) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
        d.ghost = d.el.cloneNode(true);
        d.ghost.classList.add('ghost');
        document.body.appendChild(d.ghost);
      }
      d.ghost.style.left = e.clientX + 'px';
      d.ghost.style.top = e.clientY + 'px';
      setDropKey(dropTarget(d.ghost).k);
      e.preventDefault();
    });
    const finish = (e, cancelled) => {
      if (!d) return;
      const cur = d;
      d = null;
      if (cur.ghost) {
        const t = dropTarget(cur.ghost);
        cur.ghost.remove();
        setDropKey(null);
        if (cancelled || !t.inside) return;
        if (!t.k) return toast('이름표를 우리 팀(파란) 동그라미 가까이에 놓으세요.');
        S.pick = null;
        assignPlayer(+t.k.slice(1), cur.pid);
        renderStrategy();
      } else if (!cancelled) {
        // 누르기만 했으면 선택 → 동그라미를 누르면 배정
        S.pick = S.pick === cur.pid ? null : cur.pid;
        for (const c of document.querySelectorAll('#bench .chip')) c.classList.toggle('picked', c.dataset.pid === S.pick);
        if (S.pick) toast('이제 우리 팀 동그라미를 누르세요.');
      }
    };
    bench.addEventListener('pointerup', (e) => finish(e, false));
    bench.addEventListener('pointercancel', (e) => finish(e, true));
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
    S.sug = null;
    const rev = S.work.rev;
    S.work = JSON.parse(prev);
    S.work.rev = rev; // 서버 기준 버전은 그대로 유지
    S.scene = Math.min(S.scene, S.work.scenes.length - 1);
    changed();
    renderStrategy();
  }

  function labelsOf(st) {
    const labels = {};
    st.lineup.forEach((l, i) => (labels['h' + i] = l.pos));
    st.awayLineup.forEach((l, i) => (labels['a' + i] = l.pos));
    return labels;
  }

  // 이 장면 동선을 따라간 다음 위치. 상대 자동 반응이 켜져 있으면 상대도 움직인다
  function nextScenePositions(st, sc) {
    const pos = nextPositions(sc);
    return S.autoReact ? window.Suggest.reactAway(pos, sc.arrows, labelsOf(st)) : pos;
  }

  function addScene() {
    stopPlay();
    S.sug = null;
    pushUndo();
    const sc = S.work.scenes[S.scene];
    if (S.work.scenes.length >= 30) return toast('장면은 30개까지 만들 수 있습니다.');
    const next = clone(sc);
    const pos = nextScenePositions(S.work, sc);
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
    toast(
      (sc.arrows.length ? '동선 끝 위치로 옮긴 다음 장면을 만들었습니다.' : '다음 장면을 만들었습니다.') +
        (S.autoReact ? ' 상대도 자동으로 움직였습니다 (마음에 안 들면 ↶ 취소).' : ''),
      3500
    );
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
    } else {
      st.awayFormation = name;
      st.awayLineup.forEach((l, i) => (l.pos = ps[i].pos));
    }
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
    const arrowDefs = ['run', 'pass', 'dribble', 'shot']
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
      shot: 'style="stroke:var(--shot)" stroke-width="0.75"',
    }[a.kind];
    const d = pathD(a.points);
    return `<g opacity="${opacity}"><path d="${d}" fill="none" ${style} stroke-linejoin="round" marker-end="url(#ah-${a.kind})"/>${
      S.tool === 'erase' && editing() ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="3"/>` : ''
    }</g>`;
  }

  function tokenSvg(k, p, pm, st) {
    const [x, y] = p;
    if (k === 'ball') {
      return `<g class="token"><circle cx="${x}" cy="${y}" r="0.95" fill="#fff" stroke="#111" stroke-width="0.25"/><circle cx="${x}" cy="${y}" r="0.35" fill="#111"/></g>`;
    }
    const home = k[0] === 'h';
    const t = tokenInfo(st, k, pm);
    const gk = t.pos === 'GK';
    const fill = home ? (gk ? 'var(--home-gk)' : 'var(--home)') : gk ? 'var(--away-gk)' : 'var(--away)';
    const posText = t.pos || '?';
    const fs = posText.length > 2 ? 1.15 : 1.5;
    const sel = (S.drag && S.drag.key === k) || S.dropKey === k ? ' selected' : '';
    return `<g class="token${sel}">
      <circle class="body" cx="${x}" cy="${y}" r="2.1" style="fill:${fill}" stroke="#fff" stroke-width="0.3"/>
      <text x="${x}" y="${y + fs * 0.36}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff">${esc(posText)}</text>
    </g>`;
  }

  // 이름(또는 번호)을 정하면 동그라미 아래에 "번호 이름" 이름표. 동그라미에 가려지지 않게 맨 위 층에 따로 그린다
  function tagSvg(k, p, pm, st) {
    const t = tokenInfo(st, k, pm);
    const name = (t.name || '').slice(0, 6);
    if (!name && t.number == null) return '';
    const [x, y] = p;
    const home = k[0] === 'h';
    const num = t.number != null ? String(t.number) : '';
    const TF = 1.5;
    const w = (textWidth(num) + (num && name ? 0.4 : 0) + textWidth(name)) * TF + 1.4;
    const ty = y + 3.75;
    return `<g class="tag" pointer-events="none"><rect x="${(x - w / 2).toFixed(2)}" y="${(ty - 1.35).toFixed(2)}" width="${w.toFixed(2)}" height="1.95" rx="0.95" fill="rgba(8,22,14,0.85)" stroke="${home ? 'rgba(120,170,255,0.8)' : 'rgba(255,140,140,0.8)'}" stroke-width="0.12"/>
      <text x="${x}" y="${ty}" text-anchor="middle" font-size="${TF}" fill="#fff">${num ? `<tspan fill="#ffd54a" font-weight="700">${num}</tspan>${name ? ' ' : ''}` : ''}${esc(name)}</text></g>`;
  }

  // 이름표 폭 계산용 대략적인 글자 폭 (글자 크기 1 기준)
  function textWidth(str) {
    let w = 0;
    for (const ch of str) w += /[\u0000-\u00ff]/.test(ch) ? 0.6 : 1;
    return w;
  }

  // frame: { pos(k), arrows, arrowOpacity }
  function drawDyn(frame) {
    const g = $('#dyn');
    const st = current();
    if (!g || !st) return;
    const sc = st.scenes[S.scene];
    const idea = S.sug && editing() && S.sug.ideas[S.sug.i];
    const f =
      frame ||
      (S.sug && editing()
        ? { pos: (k) => S.sug.base[k], arrows: idea ? idea.arrows : [], arrowOpacity: 0.95 }
        : { pos: (k) => getPos(sc, k), arrows: sc.arrows, arrowOpacity: 1 });
    const pm = playersById();
    let html = f.arrows.map((a) => arrowSvg(a, f.arrowOpacity)).join('');
    if (S.draw && S.draw.points.length > 1) html += arrowSvg({ kind: S.draw.kind, points: S.draw.points }, 0.8);
    html += KEYS.filter((k) => k[0] === 'a').map((k) => tokenSvg(k, f.pos(k), pm, st)).join('');
    html += KEYS.filter((k) => k[0] === 'h').map((k) => tokenSvg(k, f.pos(k), pm, st)).join('');
    html += tokenSvg('ball', ballShown(f.pos), pm, st);
    // 이름표는 모든 동그라미 위에 (우리 팀 이름표가 맨 위)
    html += KEYS.filter((k) => k[0] === 'a').map((k) => tagSvg(k, f.pos(k), pm, st)).join('');
    html += KEYS.filter((k) => k[0] === 'h').map((k) => tagSvg(k, f.pos(k), pm, st)).join('');
    g.innerHTML = html;
  }

  // 공이 선수와 겹치면 글자를 가리지 않게 그 선수 발밑(오른쪽 아래)에 그린다 (저장 위치는 그대로)
  function ballShown(posOf) {
    const ball = posOf('ball');
    for (const k of KEYS) {
      if (k === 'ball') continue;
      const q = posOf(k);
      if (dist(q, ball) < 2.5) return [q[0] + 1.75, q[1] + 1.35];
    }
    return ball;
  }

  // ---------- 경기장 확대 (viewBox) ----------
  const FULL = { x: -3, y: -3, w: 74, h: 111 };
  const viewBoxText = () => {
    const v = S.view || FULL;
    return `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${v.h.toFixed(2)}`;
  };
  // 확대 배율 1~3배, 경기장 밖으로 나가지 않게
  function setView(cx, cy, w) {
    w = Math.max(FULL.w / 3, Math.min(FULL.w, w));
    const h = (w * FULL.h) / FULL.w;
    const x = Math.max(FULL.x, Math.min(FULL.x + FULL.w - w, cx - w / 2));
    const y = Math.max(FULL.y, Math.min(FULL.y + FULL.h - h, cy - h / 2));
    S.view = w >= FULL.w - 0.01 ? null : { x, y, w, h };
    const svg = $('#pitch');
    if (svg) svg.setAttribute('viewBox', viewBoxText());
  }
  function zoomBy(factor, cx, cy) {
    const v = S.view || FULL;
    if (cx == null) {
      cx = v.x + v.w / 2;
      cy = v.y + v.h / 2;
    }
    setView(cx, cy, v.w / factor);
  }
  function bindZoom() {
    const z = $('.zoom');
    if (!z) return;
    z.onclick = (e) => {
      const b = e.target.closest('[data-zoom]');
      if (!b) return;
      if (b.dataset.zoom === 'reset') setView(34, 52.5, FULL.w);
      else zoomBy(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5);
    };
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

  // 누른 곳의 선수. 근처에 우리 팀(파랑)이 있으면 파랑 우선, 상대(빨강)는 동그라미 한가운데를 눌렀을 때만
  function pickPlayer(sc, p, max = 4) {
    const h = nearest(sc, p, max, (k) => k[0] === 'h');
    const a = nearest(sc, p, max, (k) => k[0] === 'a');
    if (!h) return a;
    if (!a) return h;
    const dh = dist(getPos(sc, h), p);
    const da = dist(getPos(sc, a), p);
    return da < 1.1 && da + 0.6 < dh ? a : h;
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

  // ---------- 동선 모드: 끌면 알아서 달리기 / 드리블 / 패스 / 슛 ----------
  const GOAL_ZONE = (q) => q[1] < 5 && q[0] > 22 && q[0] < 46; // 골문 앞에 놓으면 슛

  // 공을 가진 선수 (공 2.5m 안의 가장 가까운 선수)
  function ballHolder(sc) {
    return nearest(sc, sc.ball, 2.5, (k) => k !== 'ball');
  }

  // 선수가 이 장면에서 도착하는 곳 (동선이 있으면 그 끝, 없으면 지금 위치)
  function arrivalOf(sc, k) {
    const a = sc.arrows.filter((x) => x.owner === k).pop();
    return a ? a.points[a.points.length - 1] : getPos(sc, k);
  }

  // 공을 패스로 보낼 받는 사람: 놓은 곳 근처(5m)에 도착하는 같은 팀 선수
  function passReceiver(sc, q) {
    const holder = ballHolder(sc);
    let best = null;
    let bd = 5;
    for (const k of KEYS) {
      if (k === 'ball' || k === holder) continue;
      if (holder && k[0] !== holder[0]) continue;
      const dd = dist(arrivalOf(sc, k), q);
      if (dd < bd) {
        bd = dd;
        best = k;
      }
    }
    return best;
  }

  function flowKind(sc, key, q) {
    if (key === 'ball') return !passReceiver(sc, q) && GOAL_ZONE(q) ? 'shot' : 'pass';
    return hasBallNow(sc, key) ? 'dribble' : 'run';
  }

  // 이 장면에서 공을 가진 채로 움직일 수 있는지 (이미 패스·슛 선이 있으면 공은 떠난 것)
  function hasBallNow(sc, key) {
    return ballHolder(sc) === key && !sc.arrows.some((a) => a.owner === 'ball');
  }

  function finishFlow(dg) {
    const sc = S.work.scenes[S.scene];
    const key = dg.key;
    let pts = simplify(dg.path, 0.6);
    if (pathLength(pts) < 2.5) {
      S.undo.pop();
      drawDyn();
      return;
    }
    if (sc.arrows.length >= 60) {
      S.undo.pop();
      drawDyn();
      return toast('한 장면에 선은 60개까지 그릴 수 있습니다.');
    }
    const id = Math.random().toString(36).slice(2, 12);
    const round = (q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10];
    let msg = '';
    if (key === 'ball') {
      let end = pts[pts.length - 1];
      const rcv = passReceiver(sc, end);
      let kind = 'pass';
      if (rcv) {
        end = arrivalOf(sc, rcv);
        const t = tokenInfo(S.work, rcv, playersById());
        msg = `${nameText(t) || t.pos}에게 패스`;
      } else if (GOAL_ZONE(end)) {
        kind = 'shot';
        end = [Math.min(37, Math.max(31, end[0])), -1];
        msg = '슛';
      } else msg = '빈 공간으로 패스';
      pts[0] = sc.ball.slice();
      pts[pts.length - 1] = end;
      // 공의 패스·슛 선은 한 장면에 하나: 새로 그리면 바뀐다
      sc.arrows = sc.arrows.filter((a) => a.owner !== 'ball');
      sc.arrows.push({ id, kind, owner: 'ball', withBall: false, points: pts.map(round) });
    } else {
      const withBall = hasBallNow(sc, key);
      const oldArrival = arrivalOf(sc, key);
      pts[0] = getPos(sc, key).slice();
      const end = pts[pts.length - 1];
      // 같은 선수의 동선은 하나: 다시 끌면 바뀐다
      sc.arrows = sc.arrows.filter((a) => a.owner !== key);
      sc.arrows.push({ id, kind: withBall ? 'dribble' : 'run', owner: key, withBall, points: pts.map(round) });
      // 이 선수에게 가던 패스는 새 도착 지점으로 따라간다
      for (const a of sc.arrows) {
        if (a.owner === 'ball' && a.kind === 'pass' && dist(a.points[a.points.length - 1], oldArrival) < 1) a.points[a.points.length - 1] = round(end);
      }
      msg = withBall ? '드리블' : '달리기';
    }
    changed();
    const b = $('#undoBtn');
    if (b) b.disabled = false;
    drawDyn();
    toast(msg, 1500);
  }

  function bindPitch() {
    const svg = $('#pitch');
    if (!editing()) {
      // 보기 모드: 동그라미를 누르면 이름과 역할을 보여 준다
      svg.addEventListener('click', (e) => {
        const st = current();
        if (!st || S.play) return;
        const k = pickPlayer(st.scenes[S.scene], svgPoint(svg, e), 3.5);
        if (!k) return;
        const t = tokenInfo(st, k, playersById());
        toast(`${k[0] === 'h' ? '우리' : '상대'} ${t.pos}${nameText(t) ? ' · ' + nameText(t) : ''}${t.role ? ' — ' + t.role : ''}`, 4000);
      });
      return;
    }

    // 두 손가락이면 진행 중인 끌기를 취소하고 확대·이동
    const touches = new Map();
    let pinch = null;
    const screenToSvg = (x, y, v) => {
      const r = svg.getBoundingClientRect();
      return [v.x + ((x - r.left) / r.width) * v.w, v.y + ((y - r.top) / r.height) * v.h];
    };
    const startPinch = () => {
      if (S.drag) {
        // 손가락 하나로 하던 끌기는 없던 일로
        const prev = S.undo.pop();
        if (prev && S.drag.moved && !S.drag.flow) {
          const rev = S.work.rev;
          S.work = JSON.parse(prev);
          S.work.rev = rev;
        }
        S.drag = null;
      }
      S.draw = null;
      const [a, b] = [...touches.values()];
      const v = S.view || FULL;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, v0: { ...v }, c: screenToSvg(cx, cy, v), cx0: cx, cy0: cy };
      drawDyn();
    };
    svg.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          startPinch();
          return;
        }
        if (touches.size > 2 || pinch) return;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size < 2) return;
      const [a, b] = [...touches.values()];
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0;
      const w = Math.max(FULL.w / 3, Math.min(FULL.w, pinch.v0.w / scale));
      const h = (w * FULL.h) / FULL.w;
      // 두 손가락 가운데 아래의 경기장 지점이 손가락을 따라오게
      const r = svg.getBoundingClientRect();
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const x = pinch.c[0] - ((cx - r.left) / r.width) * w;
      const y = pinch.c[1] - ((cy - r.top) / r.height) * h;
      setView(x + w / 2, y + h / 2, w);
    });
    const lift = (e) => {
      touches.delete(e.pointerId);
      if (pinch && touches.size === 0) pinch = null;
    };
    svg.addEventListener('pointerup', lift);
    svg.addEventListener('pointercancel', lift);

    svg.addEventListener('pointerdown', (e) => {
      if (pinch || touches.size > 1) return;
      if (S.play || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (S.sug) return toast('추천을 적용(✓)하거나 닫은(✕) 뒤에 편집하세요.');
      const sc = S.work.scenes[S.scene];
      const p = svgPoint(svg, e);
      if (S.tool === 'move' || S.tool === 'flow') {
        // 공은 화면에 그려진 자리로 판정한다
        const bp = ballShown((k) => getPos(sc, k));
        // 명단 이름표를 골라 둔 상태면 빨강은 무시하고 가장 가까운 파랑 선수에게
        // 공은 화면에 그려진 자리 기준, 선수 중심보다 공에 더 가까우면 공
        const pk = pickPlayer(sc, p);
        const db = dist(bp, p);
        const k = S.pick
          ? nearest(sc, p, 6, (k) => k[0] === 'h')
          : db < 1.4 || (db < 2.6 && (!pk || db < dist(getPos(sc, pk), p)))
            ? 'ball'
            : pk || (db < 4 ? 'ball' : null);
        if (!k) return;
        S.undo.push(JSON.stringify(S.work));
        const from = k === 'ball' ? bp : getPos(sc, k);
        S.drag = { key: k, moved: false, start: p, off: [from[0] - p[0], from[1] - p[1]], flow: S.tool === 'flow' };
        // 동선 모드: 선수·공은 그대로 두고 손가락이 지나간 길을 동선으로 기록
        if (S.drag.flow) S.drag.path = [(k === 'ball' ? sc.ball : from).slice()];
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
        if (S.tool === 'pass' || S.tool === 'shot') {
          owner = 'ball';
          if (dist(sc.ball, p) < 5) start = sc.ball;
          else {
            const k = pickPlayer(sc, p);
            if (k) start = getPos(sc, k);
          }
        } else {
          owner = pickPlayer(sc, p);
          if (owner) start = getPos(sc, owner);
          withBall = S.tool === 'dribble' && dist(sc.ball, start) < 4;
        }
        S.draw = { kind: S.tool, owner, withBall, points: [start.slice()] };
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    svg.addEventListener('pointermove', (e) => {
      if (pinch || (!S.drag && !S.draw)) return;
      const p = svgPoint(svg, e);
      if (S.drag) {
        // 손가락이 살짝 흔들린 것은 누르기로 본다
        if (!S.drag.moved && dist(p, S.drag.start) < 1) return;
        const sc = S.work.scenes[S.scene];
        const q = [p[0] + S.drag.off[0], p[1] + S.drag.off[1]];
        S.drag.moved = true;
        if (S.drag.flow) {
          const path = S.drag.path;
          if (dist(path[path.length - 1], q) >= 0.7) path.push(q);
          S.draw = { kind: flowKind(sc, S.drag.key, q), points: path };
        } else setPos(sc, S.drag.key, q);
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
        if (S.drag.moved && S.drag.flow) {
          const dg = S.drag;
          S.drag = null;
          S.draw = null;
          finishFlow(dg);
          return;
        }
        if (S.drag.moved) {
          changed();
          const b = $('#undoBtn');
          if (b) b.disabled = false;
        } else {
          S.undo.pop();
          const k = S.drag.key;
          S.drag = null;
          drawDyn();
          // 누르기: 이름표를 골라 둔 상태면 배정, 아니면 이름 창
          if (k === 'ball') return;
          if (S.pick && k[0] === 'h') {
            const pid = S.pick;
            S.pick = null;
            assignPlayer(+k.slice(1), pid);
            renderStrategy();
          } else openTokenDlg(k);
          return;
        }
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

  // ---------- 동그라미 이름 창 ----------
  const tokDlg = $('#tokenDlg');
  let tokKey = null;

  function openTokenDlg(k) {
    const st = S.work;
    if (!st) return;
    tokKey = k;
    const home = k[0] === 'h';
    const i = +k.slice(1);
    const l = home ? st.lineup[i] : st.awayLineup[i];
    $('#tokTitle').textContent = `${home ? '우리 팀' : '상대 팀'} · ${l.pos} 자리`;
    $('#tokPlayerWrap').hidden = !home;
    $('#tokRoleWrap').hidden = !home;
    if (home) {
      const players = [...S.doc.team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
      const slotOf = new Map(st.lineup.map((x, j) => [x.playerId, j]));
      $('#tokPlayer').innerHTML =
        `<option value="">직접 입력 (명단에 없는 선수)</option>` +
        players
          .map((p) => {
            const j = slotOf.get(p.id);
            const mark = j != null && j !== i ? ` — 지금 ${st.lineup[j].pos} 자리` : '';
            return `<option value="${p.id}" ${p.id === l.playerId ? 'selected' : ''}>${p.number != null ? '#' + p.number + ' ' : ''}${esc(p.name)}${esc(mark)}</option>`;
          })
          .join('');
      $('#tokRole').value = l.role || '';
    }
    $('#tokName').value = l.name || '';
    $('#tokNum').value = l.number ?? '';
    $('#tokPos').value = l.pos;
    syncTokFields();
    tokDlg.showModal();
  }

  // 명단 선수를 고르면 이름·번호는 명단 것을 쓴다
  function syncTokFields() {
    const p = tokKey && tokKey[0] === 'h' && $('#tokPlayer').value ? playersById().get($('#tokPlayer').value) : null;
    $('#tokName').disabled = !!p;
    $('#tokNum').disabled = !!p;
    if (p) {
      $('#tokName').value = p.name;
      $('#tokNum').value = p.number ?? '';
    }
  }
  $('#tokPlayer').onchange = () => {
    if (!$('#tokPlayer').value) {
      $('#tokName').value = '';
      $('#tokNum').value = '';
    }
    syncTokFields();
  };
  $('#tokCancel').onclick = () => tokDlg.close();
  $('#tokenForm').onsubmit = (e) => {
    e.preventDefault();
    const st = S.work;
    if (!st || !tokKey) return tokDlg.close();
    const home = tokKey[0] === 'h';
    const i = +tokKey.slice(1);
    const numVal = $('#tokNum').value === '' ? null : Math.max(0, Math.min(99, parseInt($('#tokNum').value, 10) || 0));
    const pos = $('#tokPos').value.trim().slice(0, 6);
    if (home) {
      const pid = $('#tokPlayer').value || null;
      if (pid) assignPlayer(i, pid);
      else pushUndo();
      const l = st.lineup[i];
      if (!pid) {
        l.playerId = null;
        l.name = $('#tokName').value.trim().slice(0, 12);
        l.number = numVal;
      }
      if (pos) l.pos = pos;
      l.role = $('#tokRole').value.slice(0, 300);
    } else {
      pushUndo();
      const a = st.awayLineup[i];
      a.name = $('#tokName').value.trim().slice(0, 12);
      a.number = numVal;
      if (pos) a.pos = pos;
    }
    changed();
    tokDlg.close();
    renderStrategy();
  };

  // ---------- 재생 ----------
  function startPlay() {
    if (S.sug) {
      S.sug = null;
      renderStrategy();
    }
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
      <p class="hint">명단을 먼저 쭉 등록해 두면 전술 화면에서 이름표를 끌어다 동그라미에 놓아 배정합니다.</p>
      <details class="bulk" ${r.players.length ? '' : 'open'}>
        <summary>📋 한꺼번에 입력</summary>
        <p class="hint">한 줄에 한 명씩 “등번호 이름 포지션” (번호·포지션은 빼도 됨). 쉼표로 나눠도 됩니다. 같은 이름이 이미 있으면 번호·포지션만 바꿉니다.</p>
        <textarea id="bulkText" rows="6" placeholder="1 김골키 GK&#10;4 박수비 CB&#10;10 한공격 ST&#10;이미드"></textarea>
        <div class="row end" style="margin-top:6px"><button id="bulkAdd" class="primary">명단에 추가하고 저장</button></div>
      </details>
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
    $('#bulkAdd').onclick = () => {
      const { added, updated, skipped } = addBulk(r, $('#bulkText').value);
      if (!added && !updated) return toast('추가할 이름이 없습니다.');
      saveRoster(`${added}명 추가${updated ? `, ${updated}명 수정` : ''}${skipped ? ` (40명이 넘어 ${skipped}명 제외)` : ''}`);
    };
    $('#saveRoster').onclick = () => saveRoster('선수단을 저장했습니다.');
  }

  // "10 홍길동 ST" 같은 줄들을 명단에 넣는다
  function addBulk(r, textValue) {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const line of textValue.split(/[\n,]/)) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      let number = null;
      let pos = '';
      const rest = [];
      for (const w of words) {
        const n = w.match(/^#?(\d{1,2})(번)?$/);
        const up = w.toUpperCase();
        if (n && number == null) number = +n[1];
        else if (!pos && POSITIONS.includes(up)) pos = up;
        else rest.push(w);
      }
      const name = rest.join(' ').slice(0, 20);
      if (!name) continue;
      const same = r.players.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
      if (same) {
        if (number != null) same.number = number;
        if (pos) same.pos = pos;
        updated++;
      } else if (r.players.length >= 40) skipped++;
      else {
        r.players.push({ id: Math.random().toString(36).slice(2, 12), name, number, pos });
        added++;
      }
    }
    return { added, updated, skipped };
  }

  async function saveRoster(doneMsg) {
    const r = S.roster;
    {
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
        toast(doneMsg);
      } catch (err) {
        if (err.status === 401) logout(err.message);
        else toast(err.message);
      }
    }
  }

  // ---------- 로그인 ----------
  const dlg = $('#loginDlg');
  $('#lockBtn').onclick = async () => {
    if (isEditor()) {
      if (!confirm(`${S.me.name}님, 로그아웃할까요? (보기는 계속 할 수 있습니다)`)) return;
      await saveNow();
      logout('로그아웃했습니다.');
      return;
    }
    $('#loginName').value = local.get('soccer.lastName') || '';
    $('#loginPass').value = '';
    $('#loginTeam').value = '';
    $('#teamWrap').hidden = true;
    $('#loginErr').hidden = true;
    dlg.showModal();
    setTimeout(() => ($('#loginName').value ? $('#loginPass') : $('#loginName')).focus(), 50);
  };
  $('#loginCancel').onclick = () => dlg.close();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#loginName').value.trim();
    const password = $('#loginPass').value;
    const teamPassword = $('#teamWrap').hidden ? undefined : $('#loginTeam').value;
    const remember = $('#loginRemember').checked;
    const box = $('#loginErr');
    try {
      const r = await api('POST', 'api/login', { name, password, teamPassword }, null);
      S.key = r.token;
      S.me = r.user;
      local.del('soccer.session');
      local.set('soccer.session', r.token, remember);
      local.set('soccer.lastName', r.user.name);
      dlg.close();
      S.work = null;
      toast(teamPassword ? `${r.user.name}님 등록했습니다. 다음부터는 이름과 개인 비밀번호만 넣으면 됩니다.` : `${r.user.name}님 로그인했습니다.`, 3500);
      render();
    } catch (err) {
      // 처음 쓰는 이름이면 팀 편집 비밀번호 칸을 보여 준다
      if (err.data && err.data.needTeamPassword) {
        $('#teamWrap').hidden = false;
        if (!teamPassword) setTimeout(() => $('#loginTeam').focus(), 30);
      }
      box.textContent = err.message;
      box.hidden = false;
    }
  };

  $('#backBtn').onclick = () => (location.hash = '#/');

  // ---------- 다른 사람이 바꾼 내용 반영 ----------
  function busy() {
    const a = document.activeElement;
    const typing = a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    return S.drag || S.draw || S.play || S.dirty || S.saving || S.rosterDirty || typing || dlg.open || tokDlg.open || tplDlg.open;
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
