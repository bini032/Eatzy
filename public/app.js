(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 3000;

  let voterId = null;
  try {
    voterId = localStorage.getItem('eatzy-voter');
  } catch {}
  if (!voterId) {
    voterId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
    try {
      localStorage.setItem('eatzy-voter', voterId);
    } catch {}
  }

  let data = null;
  let busy = false;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = {};
    try {
      json = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error(json.error || `요청 실패 (${res.status})`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json;
  }

  function showMessage(text, isError = false) {
    const el = $('message');
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.className = 'message' + (isError ? ' error-msg' : '');
    el.hidden = false;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function safeUrl(u) {
    return /^https?:\/\//.test(u || '') ? u : '';
  }

  // 네이버 지도: 가게에 링크가 있으면 그대로, 없으면 "가게 이름 + 주소(층/괄호 제외)" 검색 링크
  function naverMapUrl(p) {
    if (safeUrl(p.naverUrl)) return p.naverUrl;
    const addr = String(p.address || '')
      .replace(/\(.*?\)/g, '')
      .replace(/\s+(지하\s*)?\d*층.*$/, '')
      .trim();
    return `https://map.naver.com/p/search/${encodeURIComponent(`${p.name} ${addr}`.trim())}`;
  }

  function formatDistance(m) {
    if (m == null) return '';
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- 관리자 키 입력 ----------
  function askKey(title, desc, onSubmit) {
    const dialog = $('keyDialog');
    $('keyTitle').textContent = title;
    $('keyDesc').textContent = desc;
    $('keyInput').value = '';
    $('keyError').hidden = true;
    dialog.showModal();
    $('keyInput').focus();

    const form = $('keyForm');
    const handler = async (e) => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === 'cancel') {
        cleanup();
        return;
      }
      $('keyOk').disabled = true;
      const error = await onSubmit($('keyInput').value);
      $('keyOk').disabled = false;
      if (error) {
        $('keyError').textContent = error;
        $('keyError').hidden = false;
        $('keyInput').select();
      } else {
        cleanup();
      }
    };
    function cleanup() {
      form.removeEventListener('submit', handler);
      dialog.close();
    }
    form.addEventListener('submit', handler);
  }

  // ---------- 렌더링 ----------
  function renderLocation() {
    const { settings, radiusOptions, defaultPlace } = data;
    const origin = settings.origin;
    const listMode = data.source === 'list';
    if (origin) {
      $('locName').textContent = origin.name;
      $('locAddr').textContent = (origin.address || '') + (origin.attribution ? ` · ${origin.attribution}` : '');
    } else if (data.kakaoEnabled) {
      $('locName').textContent = `${defaultPlace} (기본, 첫 검색 때 위치 확인)`;
      $('locAddr').textContent = '';
    } else {
      $('locName').textContent = '지정 안 됨';
      $('locAddr').textContent = '등록된 가게 전체에서 뽑습니다. 현재 위치를 지정하면 좌표가 있는 가게는 반경으로 거릅니다.';
    }
    $('locDefaultBtn').textContent = data.defaultLocatable ? `🏢 ${defaultPlace}(기본)` : '위치 지정 해제';
    $('locSearchToggle').hidden = !data.kakaoEnabled;
    if (!data.kakaoEnabled) $('locSearchForm').hidden = $('locResults').hidden = true;
    $('sourceInfo').textContent =
      listMode
        ? `후보: ${data.placesOrigin === 'db' ? '저장된' : '등록된'} 가게 ${data.placesCount}곳에서 뽑기${data.placesErrors ? ` (형식 오류 ${data.placesErrors}건 제외됨)` : ''}`
        : data.source === 'kakao'
          ? '후보: 카카오맵 실시간 검색'
          : '후보로 쓸 가게가 아직 없습니다. 관리자가 아래 "가게 관리"에서 가게를 등록해야 합니다.';

    const sel = $('radiusSelect');
    if (sel.options.length !== radiusOptions.length) {
      sel.innerHTML = radiusOptions.map((r) => `<option value="${r}">${formatDistance(r)}</option>`).join('');
    }
    if (document.activeElement !== sel) sel.value = String(settings.radius);
  }

  function renderDecision() {
    const round = data.round;
    const el = $('decision');
    if (!round || round.status !== 'done' || !round.winner) {
      el.hidden = true;
      return;
    }
    const w = round.winner;
    const url = safeUrl(w.url);
    el.innerHTML = `
      <p class="eyebrow">🎉 오늘의 점심이 결정됐어요</p>
      <h2>${esc(w.name)}</h2>
      <p>${esc(w.categoryLabel)}${w.category && w.category !== w.categoryLabel ? ` · ${esc(w.category)}` : ''}</p>
      ${w.memo ? `<p>${esc(w.memo)}</p>` : ''}
      ${w.address || w.distance != null ? `<p class="muted">${esc(w.address)}${w.address && w.distance != null ? ' · ' : ''}${w.distance != null ? `약 ${formatDistance(w.distance)}` : ''}</p>` : ''}
      ${w.phone ? `<p>☎ ${esc(w.phone)}</p>` : ''}
      <p>득표 ${w.votes}표 / 총 ${round.totalVotes}표${w.byDraw ? ' · 동점 랜덤 뽑기로 결정' : ''}</p>
      ${menuSummary(w.menuCounts)}
      <p class="decision-actions">
        <a class="btn primary" href="${esc(naverMapUrl(w))}" target="_blank" rel="noopener">🧭 찾아가기 (네이버 지도)</a>
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">가게 정보</a>` : ''}
      </p>
      <p class="muted small-text">결정 시각 ${formatTime(round.finishedAt)}</p>`;
    el.hidden = false;
  }

  // 메뉴별 선택 인원: "김치찌개 3명 · 제육볶음 2명 · 메뉴 미정 1명"
  function menuSummary(menuCounts) {
    const entries = Object.entries(menuCounts || {}).filter(([, n]) => n > 0);
    if (!entries.length || (entries.length === 1 && entries[0][0] === '')) return '';
    entries.sort((a, b) => (a[0] === '') - (b[0] === '') || b[1] - a[1]);
    const text = entries.map(([m, n]) => `${m ? esc(m) : '메뉴 미정'} ${n}명`).join(' · ');
    return `<p class="menu-summary">🍽️ ${text}</p>`;
  }

  function menuBlock(c, round, done) {
    const menus = c.menus || [];
    const counts = (round.menuCounts && round.menuCounts[c.id]) || {};
    const myMenu = round.myVote && round.myVote.candidateId === c.id ? round.myVote.menu : undefined;
    let html = '';
    if (menus.length) {
      const chips = menus
        .map((m, i) => {
          const n = counts[m] || 0;
          const label = `${esc(m)}${n ? ` · ${n}` : ''}`;
          return done
            ? `<button class="chip" data-closed type="button">${label}</button>`
            : `<button class="chip${myMenu === m ? ' on' : ''}" data-menu="${i}" data-cid="${esc(c.id)}" type="button">${label}</button>`;
        })
        .join('');
      html += `<div class="menus"><span class="label">${done ? '메뉴 선택 현황' : `메뉴 ${menus.length}개 · 누르면 이 가게에 그 메뉴로 투표`}</span><div class="chips">${chips}</div></div>`;
      if (done && counts['']) html += `<div class="meta">메뉴 미정 ${counts['']}명</div>`;
    } else if (!done) {
      html += '<div class="meta">등록된 메뉴가 없어요. 먹을 메뉴를 아래에 직접 추가해 주세요.</div>';
    }
    if (!done) {
      html += `
        <form class="menu-add" data-add-cid="${esc(c.id)}">
          <input type="text" maxlength="40" placeholder="${menus.length ? '원하는 메뉴가 없으면 직접 추가' : '메뉴 직접 추가 (예: 김치찌개)'}" aria-label="${esc(c.name)} 메뉴 추가" />
          <button class="small" type="submit">추가</button>
        </form>
        <button class="link" data-menu-edit="${esc(c.id)}" type="button">메뉴 편집 (관리자)</button>`;
    }
    return html;
  }

  function renderRound() {
    const round = data.round;
    const section = $('roundSection');
    if (!round) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const done = round.status === 'done';
    $('roundSection').querySelector('h2').textContent = done ? '투표 결과' : '투표하기';
    const myCandidate = round.myVote && round.candidates.find((c) => c.id === round.myVote.candidateId);
    $('voteSummary').textContent = `총 ${round.totalVotes}표`;
    $('myChoice').textContent = myCandidate ? `내 선택: ${myCandidate.name}${round.myVote.menu ? ` / ${round.myVote.menu}` : ' (메뉴 미정)'}` : '';
    $('myChoice').hidden = !myCandidate;
    $('roundMeta').textContent =
      (round.origin ? `기준: ${round.origin.name} · 반경 ${formatDistance(round.radius)} · ` : '') +
      `${formatTime(round.createdAt)} 시작` +
      (round.missing && round.missing.length ? ` · 주변에 없는 카테고리: ${round.missing.join(', ')}` : '');

    // 3초마다 다시 그려도 입력 중인 메뉴 추가 칸의 내용과 포커스가 사라지지 않게 보존
    const drafts = {};
    let focused = null;
    for (const form of $('candidates').querySelectorAll('[data-add-cid]')) {
      const input = form.querySelector('input');
      if (input.value) drafts[form.dataset.addCid] = input.value;
      if (document.activeElement === input) focused = { cid: form.dataset.addCid, pos: input.selectionStart };
    }

    const max = Math.max(1, ...Object.values(round.counts));
    $('candidates').innerHTML = round.candidates
      .map((c) => {
        const count = round.counts[c.id] || 0;
        const mine = Boolean(round.myVote && round.myVote.candidateId === c.id);
        const leader = round.leaderId === c.id;
        const url = safeUrl(c.url);
        return `
        <article class="card${mine ? ' mine' : ''}${leader ? ' leader' : ''}">
          <div class="card-top">
            <span class="badge cat">${esc(c.categoryLabel)}</span>
            ${c.pinned ? '<span class="badge pin">지난 투표 1위</span>' : ''}
            ${leader ? `<span class="badge lead">${done ? '최종 선택' : '현재 1위'}</span>` : ''}
          </div>
          <h3>${esc(c.name)}</h3>
          ${c.category && c.category !== c.categoryLabel ? `<div class="meta">${esc(c.category)}</div>` : ''}
          ${c.memo ? `<div class="meta">${esc(c.memo)}</div>` : ''}
          ${c.address || c.distance != null ? `<div class="meta">${esc(c.address)}${c.address && c.distance != null ? ' · ' : ''}${c.distance != null ? formatDistance(c.distance) : ''}</div>` : ''}
          ${c.phone ? `<div class="meta">☎ ${esc(c.phone)}</div>` : ''}
          <div class="links">
            <a href="${esc(naverMapUrl(c))}" target="_blank" rel="noopener">네이버 지도</a>
            ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">가게 정보</a>` : ''}
          </div>
          ${menuBlock(c, round, done)}
          <div class="bar"><span style="width:${(count / max) * 100}%"></span></div>
          <div class="vote-row">
            <strong>${count}표</strong>
            ${done ? '<button class="small" data-closed type="button">투표 마감</button>' : `<button class="${mine ? 'primary' : ''} small" data-vote="${esc(c.id)}" type="button">${mine ? '✔ 내 선택 (취소)' : c.menus && c.menus.length ? '메뉴 미정으로 투표' : '여기 투표'}</button>`}
          </div>
        </article>`;
      })
      .join('');

    for (const form of $('candidates').querySelectorAll('[data-add-cid]')) {
      const input = form.querySelector('input');
      const cid = form.dataset.addCid;
      if (drafts[cid]) input.value = drafts[cid];
      if (focused && focused.cid === cid) {
        input.focus();
        input.setSelectionRange(focused.pos, focused.pos);
      }
    }

    const tieBox = $('tieBox');
    if (!done && round.tiedIds.length > 1) {
      const names = round.tiedIds.map((id) => round.candidates.find((c) => c.id === id)?.name).filter(Boolean);
      if (round.needsDraw) {
        $('tieText').textContent = `${names.join(', ')} 이(가) 동점이에요. 랜덤으로 뽑아 주세요!`;
        $('drawBtn').hidden = false;
      } else {
        const winner = round.candidates.find((c) => c.id === round.leaderId);
        $('tieText').textContent = `동점(${names.join(', ')}) → 🎲 랜덤 뽑기 결과: ${winner ? winner.name : ''}`;
        $('drawBtn').hidden = true;
      }
      tieBox.hidden = false;
    } else {
      tieBox.hidden = true;
    }
    $('completeBtn').hidden = done;
  }

  function renderHistory() {
    const items = data.history || [];
    $('historySection').hidden = items.length === 0;
    $('history').innerHTML = items
      .map((h) => `<li><span>${esc(h.winner.categoryLabel)} · <strong>${esc(h.winner.name)}</strong></span><span class="muted">${formatTime(h.decidedAt)}</span></li>`)
      .join('');
  }

  function render() {
    if (!data) return;
    renderLocation();
    renderDecision();
    renderRound();
    renderHistory();
    const round = data.round;
    $('findBtn').textContent = round && round.status === 'voting' ? '🔄 후보 다시 찾기' : '🍽️ 맛집 찾기 (새 투표 시작)';
  }

  async function refresh() {
    try {
      data = await api(`/api/state?voter=${encodeURIComponent(voterId)}`);
      render();
    } catch (err) {
      showMessage(err.message, true);
    }
  }

  function applyRound(round) {
    data.round = round;
    render();
  }

  // 완료된 투표에 투표/메뉴 추가 등을 시도했을 때 안내 창
  function showClosed() {
    $('noticeDialog').showModal();
    refresh();
  }
  $('noticeOk').addEventListener('click', () => $('noticeDialog').close());
  $('candidates').addEventListener('click', (e) => {
    if (e.target.closest('[data-closed]')) showClosed();
  });

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      if (err.code === 'closed') showClosed();
      else showMessage(err.message, true);
    } finally {
      busy = false;
    }
  }

  // ---------- 위치 ----------
  async function setLocation(body) {
    const res = await api('/api/location', { method: 'POST', body });
    data.settings = res.settings;
    render();
  }

  $('radiusSelect').addEventListener('change', (e) =>
    withBusy(async () => {
      await setLocation({ radius: Number(e.target.value) });
      showMessage(`반경을 ${formatDistance(Number(e.target.value))}로 바꿨어요. 다음 맛집 찾기부터 적용됩니다.`);
    })
  );

  $('locCurrentBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showMessage('이 브라우저는 위치 정보를 지원하지 않습니다.', true);
      return;
    }
    showMessage('현재 위치를 확인하는 중…');
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        withBusy(async () => {
          await setLocation({ mode: 'current', x: pos.coords.longitude, y: pos.coords.latitude });
          showMessage(`기준 위치를 내 현재 위치로 갱신했어요 (정확도 약 ${Math.round(pos.coords.accuracy)}m).`);
        }),
      (err) => {
        const reason = err.code === 1 ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.' : '현재 위치를 가져오지 못했습니다.';
        showMessage(reason, true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  $('locDefaultBtn').addEventListener('click', () =>
    withBusy(async () => {
      await setLocation({ mode: 'default' });
      showMessage(data.defaultLocatable ? '기준 위치를 기본 위치로 되돌렸어요.' : '위치 지정을 해제했어요. 등록된 가게 전체에서 뽑습니다.');
    })
  );

  $('locSearchToggle').addEventListener('click', () => {
    const form = $('locSearchForm');
    form.hidden = !form.hidden;
    $('locResults').hidden = true;
    if (!form.hidden) $('locSearchInput').focus();
  });

  let searchResults = [];
  $('locSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('locSearchInput').value.trim();
    if (!q) return;
    withBusy(async () => {
      const res = await api(`/api/places?q=${encodeURIComponent(q)}`);
      searchResults = res.places;
      const list = $('locResults');
      list.innerHTML = searchResults.length
        ? searchResults
            .map((p, i) => `<li><button type="button" data-place="${i}">${esc(p.name)}<small>${esc(p.address)}</small></button></li>`)
            .join('')
        : '<li><button type="button" disabled>검색 결과가 없습니다.</button></li>';
      list.hidden = false;
    });
  });

  $('locResults').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-place]');
    if (!btn) return;
    const p = searchResults[Number(btn.dataset.place)];
    withBusy(async () => {
      await setLocation({ mode: 'place', name: p.name, address: p.address, x: p.x, y: p.y });
      $('locResults').hidden = true;
      $('locSearchForm').hidden = true;
      showMessage(`기준 위치를 "${p.name}"(으)로 지정했어요.`);
    });
  });

  // ---------- 투표 ----------
  async function startRound(key) {
    const res = await api('/api/rounds', { method: 'POST', body: { key } });
    applyRound(res.round);
    showMessage(res.round.missing.length ? `주변에서 ${res.round.missing.join(', ')} 가게는 찾지 못했어요.` : '새 후보를 뽑았어요. 투표해 주세요!');
    await refresh();
  }

  $('findBtn').addEventListener('click', () =>
    withBusy(async () => {
      showMessage('근처 맛집을 찾는 중…');
      try {
        await startRound();
      } catch (err) {
        if (err.status !== 403) throw err;
        showMessage('');
        const desc =
          err.code === 'closed'
            ? '투표가 완료되었습니다! 담당자에게 직접 문의해주세요. 관리자라면 키를 입력해 새 투표를 시작할 수 있습니다.'
            : '이미 투표가 진행 중이라 다시 뽑으면 현재 투표가 사라집니다. 관리자 키를 입력하세요.';
        askKey(err.code === 'closed' ? '새 투표 시작 (관리자)' : '후보 다시 뽑기', desc, async (key) => {
          try {
            await startRound(key);
            return null;
          } catch (e) {
            return e.message;
          }
        });
      }
    })
  );

  $('candidates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vote]');
    if (!btn) return;
    const candidateId = btn.dataset.vote;
    const round = data.round;
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/vote`, {
        method: 'POST',
        body: { voterId, candidateId: round.myVote && round.myVote.candidateId === candidateId ? null : candidateId },
      });
      applyRound(res.round);
      showMessage('');
    });
  });

  // 메뉴 칩: 누르면 그 가게 + 메뉴로 투표. 이미 고른 메뉴를 다시 누르면 메뉴만 해제(가게 투표는 유지).
  $('candidates').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-menu]');
    if (!chip) return;
    const round = data.round;
    const c = round.candidates.find((x) => x.id === chip.dataset.cid);
    const menu = c && c.menus[Number(chip.dataset.menu)];
    if (!menu) return;
    const same = round.myVote && round.myVote.candidateId === c.id && round.myVote.menu === menu;
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/vote`, {
        method: 'POST',
        body: { voterId, candidateId: c.id, menu: same ? null : menu },
      });
      applyRound(res.round);
      showMessage('');
    });
  });

  // 메뉴 직접 추가: 누구나 추가할 수 있고, 추가하면 그 메뉴로 바로 투표된다.
  $('candidates').addEventListener('submit', (e) => {
    const form = e.target.closest('[data-add-cid]');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input');
    const menu = input.value.trim();
    if (!menu) return;
    const round = data.round;
    const cid = form.dataset.addCid;
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/candidates/${encodeURIComponent(cid)}/menu-items`, {
        method: 'POST',
        body: { voterId, menu },
      });
      input.value = '';
      input.blur();
      applyRound(res.round);
      showMessage(`"${menu}" 메뉴를 추가하고 투표했어요.`);
    });
  });

  // 관리자 메뉴 입력
  $('candidates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu-edit]');
    if (!btn) return;
    const round = data.round;
    const c = round.candidates.find((x) => x.id === btn.dataset.menuEdit);
    if (!c) return;
    const dialog = $('menuDialog');
    $('menuTitle').textContent = `${c.name} 메뉴 편집`;
    $('menuInput').value = (c.menus || []).join('\n');
    $('menuKey').value = '';
    $('menuError').hidden = true;
    dialog.showModal();
    $('menuInput').focus();

    const form = $('menuForm');
    const close = () => {
      form.removeEventListener('submit', submit);
      $('menuCancel').removeEventListener('click', close);
      dialog.close();
    };
    const submit = async (ev) => {
      ev.preventDefault();
      const menus = $('menuInput').value.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
      $('menuOk').disabled = true;
      try {
        const res = await api(`/api/rounds/${round.id}/candidates/${encodeURIComponent(c.id)}/menus`, {
          method: 'POST',
          body: { key: $('menuKey').value, menus, voterId },
        });
        applyRound(res.round);
        close();
        showMessage(menus.length ? `${c.name} 메뉴 ${menus.length}개를 저장했어요.` : `${c.name} 메뉴를 비웠어요.`);
      } catch (err) {
        $('menuError').textContent = err.message;
        $('menuError').hidden = false;
      } finally {
        $('menuOk').disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    $('menuCancel').addEventListener('click', close);
  });

  $('drawBtn').addEventListener('click', () =>
    withBusy(async () => {
      const res = await api(`/api/rounds/${data.round.id}/draw`, { method: 'POST', body: { voterId } });
      applyRound(res.round);
    })
  );

  $('completeBtn').addEventListener('click', () => {
    const round = data.round;
    if (!round) return;
    if (round.totalVotes === 0) {
      showMessage('아직 투표가 없어요.', true);
      return;
    }
    if (round.needsDraw) {
      showMessage('동점이에요. 먼저 랜덤 뽑기를 눌러 주세요.', true);
      return;
    }
    askKey('투표 완료', '결정을 확정하면 모든 사람에게 결과가 표시됩니다. 관리자 키를 입력하세요.', async (key) => {
      try {
        const res = await api(`/api/rounds/${round.id}/complete`, { method: 'POST', body: { key, voterId } });
        applyRound(res.round);
        showMessage('');
        await refresh();
        return null;
      } catch (e) {
        return e.message;
      }
    });
  });

  $('shareBtn').addEventListener('click', async () => {
    const url = location.origin + location.pathname;
    try {
      await navigator.clipboard.writeText(url);
      showMessage('링크를 복사했어요. 팀원들에게 공유하세요!');
    } catch {
      showMessage(`이 링크를 공유하세요: ${url}`);
    }
  });

  // ---------- 가게 관리 (관리자) ----------
  let adminKey = null;

  async function adminApi(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey || '' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
    return json;
  }

  function adminShowError(text) {
    $('adminError').textContent = text || '';
    $('adminError').hidden = !text;
  }

  function renderAdmin(places) {
    $('adminCount').textContent = String(places.length);
    const labels = ['한식', '중식', '양식', '분식'];
    $('adminList').innerHTML = places.length
      ? labels
          .map((label) => {
            const rows = places.filter((p) => p.category === label);
            if (!rows.length) return `<div class="admin-group"><h4>${label} · 0곳 (이 카테고리는 후보에 나오지 않아요)</h4></div>`;
            return `<div class="admin-group"><h4>${label} · ${rows.length}곳</h4>${rows
              .map(
                (p) => `
              <div class="admin-row">
                <div class="info">
                  <strong>${esc(p.name)}</strong>
                  <small>${[p.address, p.menus.length ? `메뉴 ${p.menus.length}개: ${p.menus.slice(0, 5).join(', ')}${p.menus.length > 5 ? '…' : ''}` : '메뉴 없음'].filter(Boolean).map(esc).join(' · ')}</small>
                </div>
                <button class="small danger" data-del="${esc(p.id)}" data-name="${esc(p.name)}" type="button">삭제</button>
              </div>`
              )
              .join('')}</div>`;
          })
          .join('')
      : '<p class="muted small-text">아직 저장된 가게가 없어요.</p>';
  }

  async function adminAfterChange(places, msg) {
    renderAdmin(places);
    adminShowError('');
    if (msg) showMessage(msg);
    await refresh();
  }

  $('adminLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    adminKey = $('adminKeyInput').value;
    try {
      const { places } = await adminApi('/api/admin/places');
      $('adminLogin').hidden = true;
      $('adminBody').hidden = false;
      adminShowError('');
      renderAdmin(places);
    } catch (err) {
      adminKey = null;
      adminShowError(err.message);
    }
  });

  $('adminAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const place = {
      name: f.name.value.trim(),
      category: f.category.value,
      address: f.address.value.trim(),
      url: f.url.value.trim(),
      naverUrl: f.naverUrl.value.trim(),
      menus: f.menus.value.split(',').map((m) => m.trim()).filter(Boolean),
    };
    try {
      const res = await adminApi('/api/admin/places', { method: 'POST', body: { mode: 'merge', places: [place] } });
      f.reset();
      await adminAfterChange(res.places, `"${place.name}"을(를) 저장했어요.`);
    } catch (err) {
      adminShowError(err.message);
    }
  });

  $('adminImportBtn').addEventListener('click', async () => {
    let list;
    try {
      list = JSON.parse($('adminImport').value);
    } catch {
      adminShowError('JSON 형식이 올바르지 않습니다. [ { "name": ..., "category": ... } ] 형태로 붙여넣어 주세요.');
      return;
    }
    const replace = $('adminReplace').checked;
    if (replace && !confirm('기존에 저장된 가게 목록을 모두 지우고 교체할까요?')) return;
    try {
      const res = await adminApi('/api/admin/places', { method: 'POST', body: { mode: replace ? 'replace' : 'merge', places: list } });
      $('adminImport').value = '';
      $('adminReplace').checked = false;
      await adminAfterChange(
        res.places,
        `${res.saved}곳을 저장했어요.${res.errors.length ? ` 형식 오류로 ${res.errors.length}곳은 제외했어요.` : ''}`
      );
    } catch (err) {
      adminShowError(err.message);
    }
  });

  $('adminList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn || !confirm(`"${btn.dataset.name}"을(를) 목록에서 삭제할까요?`)) return;
    try {
      const res = await adminApi(`/api/admin/places/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
      await adminAfterChange(res.places, `"${btn.dataset.name}"을(를) 삭제했어요.`);
    } catch (err) {
      adminShowError(err.message);
    }
  });

  refresh();
  setInterval(() => {
    if (!busy && !document.hidden && !$('keyDialog').open && !$('menuDialog').open) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
