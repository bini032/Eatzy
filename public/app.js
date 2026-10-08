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
    $('locName').textContent = origin ? origin.name : `${defaultPlace} (기본, 첫 검색 때 위치 확인)`;
    $('locAddr').textContent = origin ? origin.address || '' : '';
    $('locDefaultBtn').textContent = `🏢 ${defaultPlace}(기본)`;

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
      <p>${esc(w.categoryLabel)} · ${esc(w.category)}</p>
      <p class="muted">${esc(w.address)}${w.distance != null ? ` · 약 ${formatDistance(w.distance)}` : ''}</p>
      ${w.phone ? `<p>☎ ${esc(w.phone)}</p>` : ''}
      <p>득표 ${w.votes}표 / 총 ${round.totalVotes}표${w.byDraw ? ' · 동점 랜덤 뽑기로 결정' : ''}</p>
      ${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">카카오맵에서 보기 →</a></p>` : ''}
      <p class="muted small-text">결정 시각 ${formatTime(round.finishedAt)}</p>`;
    el.hidden = false;
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
    $('voteSummary').textContent = `총 ${round.totalVotes}표`;
    $('roundMeta').textContent =
      `기준: ${round.origin.name} · 반경 ${formatDistance(round.radius)} · ${formatTime(round.createdAt)} 시작` +
      (round.missing && round.missing.length ? ` · 주변에 없는 카테고리: ${round.missing.join(', ')}` : '');

    const max = Math.max(1, ...Object.values(round.counts));
    $('candidates').innerHTML = round.candidates
      .map((c) => {
        const count = round.counts[c.id] || 0;
        const mine = round.myVote === c.id;
        const leader = round.leaderId === c.id;
        const url = safeUrl(c.url);
        return `
        <article class="card${mine ? ' mine' : ''}${leader ? ' leader' : ''}">
          <div class="card-top">
            <span class="badge cat">${esc(c.categoryLabel)}</span>
            ${c.pinned ? '<span class="badge pin">지난 투표 1위</span>' : ''}
            ${leader ? `<span class="badge">${done ? '최종 선택' : '현재 1위'}</span>` : ''}
          </div>
          <h3>${esc(c.name)}</h3>
          <div class="meta">${esc(c.category)}</div>
          <div class="meta">${esc(c.address)}${c.distance != null ? ` · ${formatDistance(c.distance)}` : ''}</div>
          ${c.phone ? `<div class="meta">☎ ${esc(c.phone)}</div>` : ''}
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">카카오맵 정보 보기</a>` : ''}
          <div class="bar"><span style="width:${(count / max) * 100}%"></span></div>
          <div class="vote-row">
            <strong>${count}표</strong>
            ${done ? '' : `<button class="${mine ? 'primary' : ''} small" data-vote="${esc(c.id)}" type="button">${mine ? '✔ 내 선택 (취소)' : '여기 투표'}</button>`}
          </div>
        </article>`;
      })
      .join('');

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

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      showMessage(err.message, true);
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
      showMessage('기준 위치를 기본 위치로 되돌렸어요.');
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
        askKey('후보 다시 뽑기', '이미 투표가 진행 중이라 다시 뽑으면 현재 투표가 사라집니다. 관리자 키를 입력하세요.', async (key) => {
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
        body: { voterId, candidateId: round.myVote === candidateId ? null : candidateId },
      });
      applyRound(res.round);
      showMessage('');
    });
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

  refresh();
  setInterval(() => {
    if (!busy && !document.hidden && !$('keyDialog').open) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
