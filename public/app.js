(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 3000;
  const I18N = window.EATZY_I18N;
  const LOCALES = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };

  // localStorage는 막혀 있을 수 있으므로 항상 감싸서 쓴다
  const local = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null || v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {}
    },
  };

  // ---------- 그룹 (주소 /g/그룹id, 없으면 기본 그룹) ----------
  const groupMatch = location.pathname.match(/^\/g\/([a-z0-9]+)/);
  const groupId = groupMatch ? groupMatch[1] : 'default';

  // ---------- 언어 ----------
  let lang = I18N[local.get('eatzy-lang')] ? local.get('eatzy-lang') : 'ko';

  function t(key, params = {}) {
    const s = (I18N[lang] && I18N[lang][key]) ?? I18N.ko[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }

  // 카테고리 데이터는 한국어 라벨(한식/중식/양식/분식)이고 표시할 때만 번역한다
  function catName(label) {
    const key = `cat.${label}`;
    return I18N.ko[key] ? t(key) : label || '';
  }

  function applyStatic() {
    document.documentElement.lang = lang;
    document.title = t('app.title');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    $('langSelect').value = lang;
    renderTheme();
    renderUser();
  }

  $('langSelect').addEventListener('change', (e) => {
    lang = e.target.value;
    local.set('eatzy-lang', lang);
    applyStatic();
    render();
    if (statsData) renderStats();
    if (overviewData) renderOverview();
    if (adminPlaces) renderAdmin(adminPlaces);
    if (!$('manualPanel').hidden) renderManual();
  });

  // ---------- 테마 (기본 라이트) ----------
  function renderTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('themeBtn').textContent = dark ? '☀️' : '🌙';
    const label = dark ? t('theme.toLight') : t('theme.toDark');
    $('themeBtn').setAttribute('aria-label', label);
    $('themeBtn').title = label;
  }

  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    local.set('eatzy-theme', dark ? 'dark' : 'light');
    renderTheme();
  });

  // ---------- 사용자 (이름 + 비밀번호 계정, 로그인 세션) ----------
  // 계정은 서버 DB에 저장되고(비밀번호는 암호화), 브라우저는 로그인 세션 토큰을 기억해 다음에 자동으로 들어간다
  // "로그인 상태 저장"을 켜면 localStorage(브라우저를 닫아도 유지), 끄면 sessionStorage(브라우저를 닫으면 로그아웃)
  const temp = {
    get(k) {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null) sessionStorage.removeItem(k);
        else sessionStorage.setItem(k, v);
      } catch {}
    },
  };
  let session = null; // { token, id, name }
  try {
    session = JSON.parse(local.get('eatzy-session') || temp.get('eatzy-session') || 'null');
  } catch {}
  // 예전 버전에서 저장한 값은 지운다 (계정이 새로 바뀌었으므로)
  for (const k of ['eatzy-user', 'eatzy-name', 'eatzy-admin-key', 'eatzy-group-tokens', 'eatzy-voter']) local.set(k, null);

  const isAdminName = (n) => String(n || '').trim().toLowerCase() === 'sb';
  // 관리자 여부는 서버가 알려 준다 (SB, 또는 이 그룹을 만든 계정)
  const isAdmin = () => Boolean(data && data.me && data.me.isAdmin);
  const isSuper = () => Boolean(data && data.me && data.me.isSuper);

  function saveSession(next, remember = true) {
    session = next;
    const value = next ? JSON.stringify(next) : null;
    local.set('eatzy-session', remember ? value : null);
    temp.set('eatzy-session', remember ? null : value);
  }

  function renderUser() {
    const btn = $('userBtn');
    btn.hidden = !session;
    btn.textContent = session ? `👤 ${session.name}${isAdmin() ? ` · ${t('user.admin')}` : ''}` : '';
    btn.title = t('user.change');
    $('completeBtn').hidden = !isAdmin() || !data || !data.round || data.round.status !== 'voting';
    $('adminSection').hidden = !isAdmin();
    $('overviewSection').hidden = !isSuper();
    const group = data && data.group;
    $('groupBadge').hidden = !(group && !group.isDefault);
    if (group && !group.isDefault) $('groupBadge').textContent = t('group.badge', { name: group.name });
    $('shareBtn').textContent = groupId === 'default' ? t('share') : t('share.group');
  }

  // 로그인 창: 일반 로그인/가입 / 관리자로 시작하기(새 그룹 만들기)
  let groupMode = false;
  function setGroupMode(on) {
    groupMode = on;
    $('userGroup').hidden = !on;
    $('userModeBtn').textContent = on ? t('user.back') : t('user.startAdmin');
    $('userOk').textContent = on ? t('user.create') : t('user.save');
    $('userError').hidden = true;
    if (on) $('userGroupName').focus();
  }
  $('userModeBtn').addEventListener('click', () => setGroupMode(!groupMode));

  function openUserDialog(required, errorText) {
    const dialog = $('userDialog');
    $('userName').value = session ? session.name : $('userName').value;
    $('userPassword').value = '';
    $('userAdmin').hidden = !isAdminName($('userName').value);
    $('userCancel').hidden = required;
    $('userLogout').hidden = !session;
    $('userError').textContent = errorText || '';
    $('userError').hidden = !errorText;
    dialog.dataset.required = required ? '1' : '';
    setGroupMode(false);
    if (!dialog.open) dialog.showModal();
    ($('userName').value ? $('userPassword') : $('userName')).focus();
  }

  // 처음 로그인할 때는 Esc로 닫지 못하게 한다
  $('userDialog').addEventListener('cancel', (e) => {
    if ($('userDialog').dataset.required) e.preventDefault();
  });
  $('userName').addEventListener('input', () => {
    $('userAdmin').hidden = !isAdminName($('userName').value);
  });
  $('userCancel').addEventListener('click', () => $('userDialog').close());
  $('userBtn').addEventListener('click', () => openUserDialog(false));

  $('userLogout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {}
    saveSession(null);
    data = data ? { ...data, me: null } : data;
    renderUser();
    openUserDialog(true);
    showMessage(t('user.loggedOut'));
  });

  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('userName').value.trim().replace(/\s+/g, ' ').slice(0, 20);
    const password = $('userPassword').value;
    const showError = (text) => {
      $('userError').textContent = text;
      $('userError').hidden = false;
    };
    if (!name) return showError(t('user.nameRequired'));
    if (!password) return showError(t('user.passwordRequired'));
    const groupName = $('userGroupName').value.trim();
    if (groupMode && !groupName) return showError(t('user.groupRequired'));

    $('userOk').disabled = true;
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: { name, password } });
      saveSession({ token: res.token, id: res.user.id, name: res.user.name }, $('userRemember').checked);
      // 관리자로 시작하기: 새 그룹을 만들고 그 그룹 링크로 이동 (만든 계정이 그 그룹 관리자)
      if (groupMode) {
        const g = await api('/api/groups', { method: 'POST', body: { name: groupName } });
        local.set('eatzy-group-created', g.name);
        location.href = `/g/${g.id}`;
        return;
      }
      $('userDialog').close();
      showMessage(t(res.isNew ? 'user.welcomeNew' : 'user.welcomeBack', { name: res.user.name }));
      await refresh();
      if (isAdmin()) loadAdmin();
    } catch (err) {
      showError(err.message);
    } finally {
      $('userOk').disabled = false;
    }
  });

  // 로그인이 만료되었거나 로그아웃된 세션이면 다시 로그인 창
  function sessionExpired() {
    saveSession(null);
    renderUser();
    openUserDialog(true, t('user.sessionExpired'));
  }

  // ---------- 공통 ----------
  let data = null;
  let busy = false;

  async function api(path, options = {}) {
    const headers = { 'x-lang': lang, 'x-group': groupId };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (session) headers['x-session'] = session.token;
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = {};
    try {
      json = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error(json.error || t('requestFailed', { status: res.status }));
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

  // 네이버 지도: 장소 번호가 있으면 그 장소, 링크만 있으면 그 링크, 없으면 가게 이름 검색
  function naverMapUrl(p) {
    if (p.naverPlaceId) return `https://map.naver.com/p/entry/place/${encodeURIComponent(p.naverPlaceId)}`;
    if (safeUrl(p.naverUrl)) return p.naverUrl;
    return `https://map.naver.com/p/search/${encodeURIComponent(p.name)}`;
  }

  // 가게 정보 링크: 네이버 메뉴 탭이 있으면 그쪽, 없으면 출처 링크
  function infoLink(p, cls) {
    const c = cls ? ` class="${cls}"` : '';
    if (p.naverPlaceId) {
      const menu = `https://m.place.naver.com/restaurant/${encodeURIComponent(p.naverPlaceId)}/menu/list`;
      return `<a${c} href="${esc(menu)}" target="_blank" rel="noopener">${esc(t('card.naverMenu'))}</a>`;
    }
    const url = safeUrl(p.url);
    return url ? `<a${c} href="${esc(url)}" target="_blank" rel="noopener">${esc(t('card.info'))}</a>` : '';
  }

  function formatDistance(m) {
    if (m == null) return '';
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 메뉴 이름에서 가격 추출: "짜장면 7,000원" -> 7000. 범위나 가격이 없으면 null (서버 src/price.js와 같은 규칙)
  function menuPrice(label) {
    const s = String(label || '');
    if (/\d\s*~\s*\d/.test(s)) return null;
    const m = s.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  function won(n) {
    return t('won', { n: Number(n).toLocaleString(LOCALES[lang]) });
  }

  // 고른 메뉴 합계 (가격 모르는 메뉴는 따로 표시)
  function totalText(menus) {
    let total = 0;
    let unknown = 0;
    for (const m of menus) {
      const p = menuPrice(m);
      if (p === null) unknown++;
      else total += p;
    }
    if (!total && !unknown) return '';
    return t('menu.total', { total: won(total) }) + (unknown ? t('menu.unknown', { n: unknown }) : '');
  }

  function originLabel(o) {
    if (!o) return '';
    if (o.source === 'current') return o.name ? t('loc.mine', { name: o.name }) : t('loc.currentName');
    return o.name;
  }

  // 3초마다 다시 그려도 입력 중인 칸의 내용과 포커스가 사라지지 않게 보존
  function keepInputs(container, selector, renderFn) {
    const drafts = {};
    let focused = null;
    for (const form of container.querySelectorAll(selector)) {
      const input = form.querySelector('input');
      const id = form.dataset.key;
      if (input.value) drafts[id] = input.value;
      if (document.activeElement === input) focused = { id, pos: input.selectionStart };
    }
    renderFn();
    for (const form of container.querySelectorAll(selector)) {
      const input = form.querySelector('input');
      const id = form.dataset.key;
      if (drafts[id]) input.value = drafts[id];
      if (focused && focused.id === id) {
        input.focus();
        input.setSelectionRange(focused.pos, focused.pos);
      }
    }
  }

  // ---------- 렌더링 ----------
  function renderLocation() {
    const { settings, radiusOptions, defaultPlace } = data;
    const origin = settings.origin;
    if (origin) {
      $('locName').textContent = originLabel(origin);
      $('locAddr').textContent = (origin.address || '') + (origin.attribution ? ` · ${origin.attribution}` : '');
    } else if (data.kakaoEnabled) {
      $('locName').textContent = t('loc.defaultPending', { place: defaultPlace });
      $('locAddr').textContent = '';
    } else {
      $('locName').textContent = t('loc.none');
      $('locAddr').textContent = t('loc.noneDesc');
    }
    $('locDefaultBtn').textContent = data.defaultLocatable ? t('loc.defaultBtn', { place: defaultPlace }) : t('loc.clearBtn');
    $('locSearchToggle').hidden = !data.kakaoEnabled;
    if (!data.kakaoEnabled) $('locSearchForm').hidden = $('locResults').hidden = true;
    $('sourceInfo').textContent =
      data.source === 'list'
        ? t(data.placesOrigin === 'db' ? 'source.saved' : 'source.file', { n: data.placesCount }) +
          (data.placesErrors ? t('source.errors', { n: data.placesErrors }) : '')
        : data.source === 'kakao'
          ? t('source.kakao')
          : t('source.none');

    const sel = $('radiusSelect');
    if (sel.options.length !== radiusOptions.length) {
      sel.innerHTML = radiusOptions.map((r) => `<option value="${r}">${formatDistance(r)}</option>`).join('');
    }
    if (document.activeElement !== sel) sel.value = String(settings.radius);
  }

  // 메뉴별 주문 수
  function menuSummary(menuCounts) {
    const entries = Object.entries(menuCounts || {}).filter(([m, n]) => m && n > 0);
    if (!entries.length) return '';
    entries.sort((a, b) => b[1] - a[1]);
    return `<p class="menu-summary">🍽️ ${entries.map(([m, n]) => esc(t('menu.count', { menu: m, n }))).join(' · ')}</p>`;
  }

  function chipList(menus, counts, picked, attr) {
    return menus
      .map((m, i) => {
        const n = counts[m] || 0;
        const on = picked.includes(m);
        return `<button class="chip${on ? ' on' : ''}" ${attr}="${i}" aria-pressed="${on}" type="button">${esc(m)}${n ? ` · ${n}` : ''}</button>`;
      })
      .join('');
  }

  // 결정 후: 결정된 가게 메뉴 고르기 (누구나, 여러 개, 변경 가능)
  function orderBlock(round, w) {
    const menus = w.menus || [];
    const myOrder = round.myOrder || [];
    const orders = round.orders || [];
    const orderedNames = new Set(orders.map((o) => o.name));
    const waiting = [...new Set(Object.values(round.voters || {}).flat().map((v) => v.name).filter((n) => n && !orderedNames.has(n)))];
    const myTotal = totalText(myOrder);
    return `
      <div class="order">
        <h3>${esc(t('order.title'))}</h3>
        <p class="muted small-text">${esc(t('order.desc'))}</p>
        ${menus.length ? `<div class="chips">${chipList(menus, w.menuCounts || {}, myOrder, 'data-order-menu')}</div>` : `<p class="meta">${esc(t('order.noMenus'))}</p>`}
        <p class="my-total">${myOrder.length ? esc(t('order.mine', { menus: myOrder.join(', ') }) + (myTotal ? ` · ${myTotal}` : '')) : esc(t('order.none'))}</p>
        <form class="menu-add" data-order-add data-key="order">
          <input type="text" maxlength="40" placeholder="${esc(menus.length ? t('menu.addPh') : t('menu.addPhEmpty'))}" aria-label="${esc(t('menu.addAria', { name: w.name }))}" />
          <button class="small" type="submit">${esc(t('menu.add'))}</button>
        </form>
        ${isAdmin() ? `<button class="link" data-menu-edit="${esc(w.id)}" type="button">${esc(t('menu.edit'))}</button>` : ''}
        <div class="order-list">
          <span class="label">${esc(t('order.list'))}</span>
          ${
            orders.length
              ? `<ul>${orders
                  .map((o) => {
                    const sub = totalText(o.menus);
                    return `<li class="${o.mine ? 'mine' : ''}"><strong>${esc(o.name || t('order.unnamed'))}</strong><span>${esc(o.menus.join(', '))}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</li>`;
                  })
                  .join('')}</ul>`
              : `<p class="meta">${esc(t('order.empty'))}</p>`
          }
          ${waiting.length ? `<p class="meta">${esc(t('order.waiting', { names: waiting.join(', ') }))}</p>` : ''}
        </div>
      </div>`;
  }

  function renderDecision() {
    const round = data.round;
    const el = $('decision');
    if (!round || round.status !== 'done' || !round.winner) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const w = round.winner;
    keepInputs(el, '[data-order-add]', () => {
      el.innerHTML = `
        <p class="eyebrow">${esc(t('decision.eyebrow'))}</p>
        <h2><button type="button" class="name-btn" data-pop="winner" title="${esc(t('pop.open'))}">${esc(w.name)} <span class="info-i" aria-hidden="true">ⓘ</span></button></h2>
        <p>${esc(catName(w.categoryLabel))}</p>
        ${w.memo ? `<p>${esc(w.memo)}</p>` : ''}
        ${w.address || w.distance != null ? `<p class="muted">${esc(w.address)}${w.address && w.distance != null ? ' · ' : ''}${w.distance != null ? esc(t('decision.about', { d: formatDistance(w.distance) })) : ''}</p>` : ''}
        ${w.phone ? `<p>☎ ${esc(w.phone)}</p>` : ''}
        <p>${esc(t('decision.votes', { v: w.votes, t: round.totalVotes }) + (w.byDraw ? t('decision.byDraw') : ''))}</p>
        ${menuSummary(w.menuCounts)}
        ${w.estimatedTotal ? `<p class="menu-summary">${esc(t('decision.estimate', { total: won(w.estimatedTotal) }) + (w.unknownPriceCount ? t('menu.unknown', { n: w.unknownPriceCount }) : ''))}</p>` : ''}
        <p class="decision-actions">
          <a class="btn primary" href="${esc(naverMapUrl(w))}" target="_blank" rel="noopener">${esc(t('decision.go'))}</a>
          ${infoLink(w, 'btn')}
        </p>
        ${orderBlock(round, w)}
        <p class="muted small-text">${esc(t('decision.time', { time: formatTime(round.finishedAt) }))}</p>`;
    });
    el.hidden = false;
  }

  function menuBlock(c, round, done) {
    const menus = c.menus || [];
    const counts = (round.menuCounts && round.menuCounts[c.id]) || {};
    const myMenus = round.myVote && round.myVote.candidateId === c.id ? round.myVote.menus : [];
    let html = '';
    if (menus.length) {
      const chips = done
        ? menus.map((m) => `<button class="chip" data-closed type="button">${esc(m)}${counts[m] ? ` · ${counts[m]}` : ''}</button>`).join('')
        : chipList(menus, counts, myMenus, `data-cid="${esc(c.id)}" data-menu`);
      html += `<div class="menus"><span class="label">${esc(done ? t('menu.status') : t('menu.pick', { n: menus.length }))}</span><div class="chips">${chips}</div></div>`;
      if (!done && myMenus.length) html += `<div class="my-total">${esc(t('menu.myTotal', { n: myMenus.length, total: totalText(myMenus) || t('menu.noPrice') }))}</div>`;
      if (done && counts['']) html += `<div class="meta">${esc(t('menu.undecidedCount', { n: counts[''] }))}</div>`;
    } else if (!done) {
      html += `<div class="meta">${esc(t('menu.none'))}</div>`;
    }
    if (!done) {
      html += `
        <form class="menu-add" data-add-cid="${esc(c.id)}" data-key="${esc(c.id)}">
          <input type="text" maxlength="40" placeholder="${esc(menus.length ? t('menu.addPh') : t('menu.addPhEmpty'))}" aria-label="${esc(t('menu.addAria', { name: c.name }))}" />
          <button class="small" type="submit">${esc(t('menu.add'))}</button>
        </form>
        ${isAdmin() ? `<button class="link" data-menu-edit="${esc(c.id)}" type="button">${esc(t('menu.edit'))}</button>` : ''}`;
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
    $('roundTitle').textContent = done ? t('round.result') : t('round.vote');
    $('voteSummary').textContent = t('round.total', { n: round.totalVotes });
    const myCandidate = round.myVote && round.candidates.find((c) => c.id === round.myVote.candidateId);
    const myMenus = round.myVote ? round.myVote.menus : [];
    const myTotal = totalText(myMenus);
    $('myChoice').textContent = myCandidate
      ? t('round.myChoice', { name: myCandidate.name, menus: myMenus.length ? myMenus.join(', ') : t('round.undecided') }) + (myTotal ? ` · ${myTotal}` : '')
      : '';
    $('myChoice').hidden = !myCandidate;
    $('roundMeta').textContent =
      (round.source === 'manual' ? t('round.meta.manual') : '') +
      (round.origin ? t('round.meta.origin', { name: originLabel(round.origin), r: formatDistance(round.radius) }) : '') +
      t('round.meta.started', { time: formatTime(round.createdAt) }) +
      (round.missing && round.missing.length ? t('round.meta.missing', { cats: round.missing.map(catName).join(', ') }) : '');

    const max = Math.max(1, ...Object.values(round.counts));
    keepInputs($('candidates'), '[data-add-cid]', () => {
      $('candidates').innerHTML = round.candidates
        .map((c) => {
          const count = round.counts[c.id] || 0;
          const mine = Boolean(round.myVote && round.myVote.candidateId === c.id);
          const leader = round.leaderId === c.id;
          const voters = ((round.voters && round.voters[c.id]) || []).map((v) => v.name).filter(Boolean);
          return `
          <article class="card${mine ? ' mine' : ''}${leader ? ' leader' : ''}">
            <div class="card-top">
              <span class="badge cat">${esc(catName(c.categoryLabel))}</span>
              ${c.pinned ? `<span class="badge pin">${esc(t('card.pinned'))}</span>` : ''}
              ${leader ? `<span class="badge lead">${esc(done ? t('card.final') : t('card.leading'))}</span>` : ''}
            </div>
            <h3><button type="button" class="name-btn" data-pop="${esc(c.id)}" title="${esc(t('pop.open'))}">${esc(c.name)} <span class="info-i" aria-hidden="true">ⓘ</span></button></h3>
            ${c.memo ? `<div class="meta">${esc(c.memo)}</div>` : ''}
            ${c.address || c.distance != null ? `<div class="meta">${esc(c.address)}${c.address && c.distance != null ? ' · ' : ''}${c.distance != null ? formatDistance(c.distance) : ''}</div>` : ''}
            ${c.phone ? `<div class="meta">☎ ${esc(c.phone)}</div>` : ''}
            <div class="links">
              <a href="${esc(naverMapUrl(c))}" target="_blank" rel="noopener">${esc(t('card.naver'))}</a>
              ${infoLink(c)}
            </div>
            ${menuBlock(c, round, done)}
            <div class="bar"><span style="width:${(count / max) * 100}%"></span></div>
            ${voters.length ? `<div class="meta voters">${esc(t('card.voters', { names: voters.join(', ') }))}</div>` : ''}
            <div class="vote-row">
              <strong>${esc(t('card.votes', { n: count }))}</strong>
              ${
                done
                  ? `<button class="small" data-closed type="button">${esc(t('card.closed'))}</button>`
                  : `<button class="${mine ? 'primary' : ''} small" data-vote="${esc(c.id)}" type="button">${esc(mine ? t('card.mine') : c.menus && c.menus.length ? t('card.voteNoMenu') : t('card.vote'))}</button>`
              }
            </div>
          </article>`;
        })
        .join('');
    });

    const tieBox = $('tieBox');
    if (!done && round.tiedIds.length > 1) {
      const names = round.tiedIds.map((id) => round.candidates.find((c) => c.id === id)?.name).filter(Boolean).join(', ');
      if (round.needsDraw) {
        $('tieText').textContent = t('tie.need', { names });
        $('drawBtn').hidden = false;
      } else {
        const winner = round.candidates.find((c) => c.id === round.leaderId);
        $('tieText').textContent = t('tie.result', { names, name: winner ? winner.name : '' });
        $('drawBtn').hidden = true;
      }
      tieBox.hidden = false;
    } else {
      tieBox.hidden = true;
    }
  }

  function renderHistory() {
    const items = data.history || [];
    $('historySection').hidden = items.length === 0;
    $('history').innerHTML = items
      .map((h) => `<li><span>${esc(catName(h.winner.categoryLabel))} · <strong>${esc(h.winner.name)}</strong></span><span class="muted">${formatTime(h.decidedAt)}</span></li>`)
      .join('');
  }

  function render() {
    if (!data) return;
    renderLocation();
    renderDecision();
    renderRound();
    renderHistory();
    renderUser();
    const round = data.round;
    $('findBtn').textContent = round && round.status === 'voting' ? t('find.again') : t('find.new');
  }

  async function refresh() {
    try {
      data = await api('/api/state');
      if (session && !data.me) return sessionExpired();
      render();
      if (isSuper() && Date.now() - overviewAt > 30000) loadOverview();
      const key = (data.history && data.history[0] && data.history[0].roundId) || '';
      if (key !== statsKey) {
        statsKey = key;
        loadStats();
      }
    } catch (err) {
      if (err.code === 'no_group') return showNoGroup();
      showMessage(err.message, true);
    }
  }

  // 없는 그룹 링크: 안내하고 갱신을 멈춘다
  let noGroup = false;
  function showNoGroup() {
    noGroup = true;
    for (const id of ['locationPanel', 'roundSection', 'statsSection', 'historySection', 'decision']) $(id).hidden = true;
    document.querySelector('.find-row').hidden = true;
    const el = $('message');
    el.className = 'message error-msg';
    el.innerHTML = `${esc(t('group.notFound'))} <a href="/">${esc(t('group.home'))}</a>`;
    el.hidden = false;
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
      else if (err.code === 'no_user') sessionExpired();
      else showMessage(err.message, true);
    } finally {
      busy = false;
    }
  }

  // ---------- 가게 정보 미리보기 (PC: 마우스 올리면 말풍선, 모바일/클릭: 아래에서 올라오는 창) ----------
  function placeFor(key) {
    const round = data && data.round;
    if (!round) return null;
    if (key === 'winner') return round.winner;
    return round.candidates.find((c) => c.id === key) || null;
  }

  function placeDetails(p) {
    const menus = p.menus || [];
    const rows = [
      p.memo ? `<p>${esc(p.memo)}</p>` : '',
      p.address ? `<p class="muted">📍 ${esc(p.address)}${p.distance != null ? ` · ${formatDistance(p.distance)}` : ''}</p>` : '',
      p.phone ? `<p>☎ <a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a></p>` : '',
    ].join('');
    const menuList = menus.length
      ? `<ul class="pop-menus">${menus
          .map((m) => {
            const price = menuPrice(m);
            const name = price === null ? m : m.replace(/\s*\d{1,3}(?:,\d{3})+\s*원\s*$|\s*\d+\s*원\s*$/, '');
            return `<li><span>${esc(name)}</span>${price !== null ? `<strong>${esc(won(price))}</strong>` : ''}</li>`;
          })
          .join('')}</ul>`
      : `<p class="muted small-text">${esc(t('pop.noMenus'))}</p>`;
    return `
      <div class="pop-head"><span class="badge cat">${esc(catName(p.categoryLabel || p.category))}</span><h3>${esc(p.name)}</h3></div>
      ${rows}
      <span class="label">${esc(t('pop.menus'))}</span>
      ${menuList}
      <div class="pop-links">
        <a href="${esc(naverMapUrl(p))}" target="_blank" rel="noopener">${esc(t('card.naver'))}</a>
        ${infoLink(p)}
      </div>`;
  }

  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const pop = $('placePop');
  let popTimer = null;
  let popKey = null;

  function showPop(target) {
    const p = placeFor(target.dataset.pop);
    if (!p) return;
    clearTimeout(popTimer);
    if (popKey !== target.dataset.pop || pop.hidden) {
      popKey = target.dataset.pop;
      pop.innerHTML = placeDetails(p);
      pop.hidden = false;
    }
    // 화면 밖으로 나가지 않게 위치 조정 (기본: 이름 아래)
    const r = target.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${top + window.scrollY}px`;
  }

  function hidePopSoon() {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => {
      pop.hidden = true;
      popKey = null;
    }, 180);
  }

  if (canHover) {
    // 카드가 3초마다 다시 그려지므로 문서 전체에서 위임 처리
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-pop]');
      if (target) return showPop(target);
      if (e.target.closest('#placePop')) return clearTimeout(popTimer);
      if (!pop.hidden) hidePopSoon();
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-pop]');
    if (!target) return;
    const p = placeFor(target.dataset.pop);
    if (!p) return;
    pop.hidden = true;
    $('placeDialogBody').innerHTML = placeDetails(p);
    $('placeDialog').showModal();
  });
  $('placeDialogClose').addEventListener('click', () => $('placeDialog').close());
  $('placeDialog').addEventListener('click', (e) => {
    if (e.target === $('placeDialog')) $('placeDialog').close(); // 바깥(배경) 누르면 닫기
  });

  // ---------- 위치 ----------
  async function setLocation(body) {
    const res = await api('/api/location', { method: 'POST', body });
    data.settings = res.settings;
    render();
  }

  $('radiusSelect').addEventListener('change', (e) =>
    withBusy(async () => {
      await setLocation({ radius: Number(e.target.value) });
      showMessage(t('loc.radiusChanged', { r: formatDistance(Number(e.target.value)) }));
    })
  );

  $('locCurrentBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showMessage(t('loc.noGeo'), true);
      return;
    }
    showMessage(t('loc.locating'));
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        withBusy(async () => {
          await setLocation({ mode: 'current', x: pos.coords.longitude, y: pos.coords.latitude });
          showMessage(t('loc.updated', { m: Math.round(pos.coords.accuracy) }));
        }),
      (err) => showMessage(err.code === 1 ? t('loc.denied') : t('loc.failed'), true),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  $('locDefaultBtn').addEventListener('click', () =>
    withBusy(async () => {
      await setLocation({ mode: 'default' });
      showMessage(data.defaultLocatable ? t('loc.resetDefault') : t('loc.cleared'));
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
        ? searchResults.map((p, i) => `<li><button type="button" data-place="${i}">${esc(p.name)}<small>${esc(p.address)}</small></button></li>`).join('')
        : `<li><button type="button" disabled>${esc(t('loc.noResults'))}</button></li>`;
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
      showMessage(t('loc.setPlace', { name: p.name }));
    });
  });

  // ---------- 새 투표 (자동 / 직접 고르기) ----------
  // 진행 중이거나 오늘 완료된 투표가 있으면 관리자만 새로 시작할 수 있다
  async function startRound(body, doneMessage) {
    const send = (extra) => api('/api/rounds', { method: 'POST', body: { ...body, ...extra } });
    let res;
    try {
      res = await send({});
    } catch (err) {
      if (err.status !== 403) throw err;
      if (err.code === 'closed') return showClosed();
      throw err;
    }
    applyRound(res.round);
    showMessage(doneMessage(res.round));
    await refresh();
    return res.round;
  }

  $('findBtn').addEventListener('click', () =>
    withBusy(async () => {
      showMessage(t('find.searching'));
      await startRound({}, (round) => (round.missing.length ? t('find.missing', { cats: round.missing.map(catName).join(', ') }) : t('find.done')));
    })
  );

  let manualPlaces = [];
  let manualSelected = [];

  function renderManual() {
    const q = $('manualSearch').value.trim().toLowerCase();
    const selectedIds = new Set(manualSelected.map((p) => p.id).filter(Boolean));
    const matches = manualPlaces.filter(
      (p) => !q || [p.name, p.address, p.category, catName(p.category)].some((v) => String(v || '').toLowerCase().includes(q))
    );
    const shown = matches.slice(0, 30);
    $('manualResults').innerHTML = shown.length
      ? shown
          .map(
            (p) => `<li><button type="button" class="${selectedIds.has(p.id) ? 'on' : ''}" data-manual-id="${esc(p.id)}" aria-pressed="${selectedIds.has(p.id)}">
              <span><strong>${esc(p.name)}</strong> <small>${esc(catName(p.category))}${p.address ? ` · ${esc(p.address)}` : ''}</small></span>
              <span class="check-mark">${selectedIds.has(p.id) ? '✓' : '+'}</span></button></li>`
          )
          .join('') + (matches.length > shown.length ? `<li class="muted small-text">${esc(t('manual.more', { n: matches.length - shown.length }))}</li>` : '')
      : `<li class="muted small-text">${esc(t('manual.noMatch'))}</li>`;
    $('manualSelectedTitle').textContent = t('manual.selected', { n: manualSelected.length });
    $('manualSelected').innerHTML = manualSelected.length
      ? manualSelected
          .map(
            (p, i) =>
              `<button type="button" class="chip on" data-manual-remove="${i}" title="${esc(t('manual.remove'))}">${p.custom ? `${esc(t('manual.new'))} · ` : ''}${esc(p.name)} (${esc(catName(p.category))}) ✕</button>`
          )
          .join('')
      : `<span class="muted small-text">${esc(t('manual.noneSelected'))}</span>`;
  }

  $('manualBtn').addEventListener('click', async () => {
    const panel = $('manualPanel');
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    try {
      manualPlaces = (await api('/api/place-list')).places;
    } catch (err) {
      showMessage(err.message, true);
    }
    renderManual();
    $('manualSearch').focus();
  });
  $('manualClose').addEventListener('click', () => ($('manualPanel').hidden = true));
  $('manualSearch').addEventListener('input', renderManual);

  $('manualResults').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-manual-id]');
    if (!btn) return;
    const id = btn.dataset.manualId;
    const idx = manualSelected.findIndex((p) => p.id === id);
    if (idx >= 0) manualSelected.splice(idx, 1);
    else {
      const p = manualPlaces.find((x) => x.id === id);
      if (p) manualSelected.push({ id: p.id, name: p.name, category: p.category });
    }
    renderManual();
  });

  $('manualSelected').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-manual-remove]');
    if (!btn) return;
    manualSelected.splice(Number(btn.dataset.manualRemove), 1);
    renderManual();
  });

  $('manualCustomForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    manualSelected.push({ name, category: f.category.value, custom: true });
    f.name.value = '';
    renderManual();
  });

  $('manualStart').addEventListener('click', () => {
    if (!manualSelected.length) {
      showMessage(t('manual.needOne'), true);
      return;
    }
    withBusy(async () => {
      const manual = manualSelected.map((p) => (p.custom ? { name: p.name, category: p.category } : { id: p.id }));
      const round = await startRound({ manual }, (r) => t('manual.started', { n: r.candidates.length }));
      if (round) {
        manualSelected = [];
        $('manualPanel').hidden = true;
      }
    });
  });

  // ---------- 투표 ----------
  $('candidates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vote]');
    if (!btn) return;
    const candidateId = btn.dataset.vote;
    const round = data.round;
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/vote`, {
        method: 'POST',
        body: { candidateId: round.myVote && round.myVote.candidateId === candidateId ? null : candidateId },
      });
      applyRound(res.round);
      showMessage('');
    });
  });

  // 메뉴 칩: 누르면 그 가게에 투표하고 메뉴를 고른다. 여러 개 선택 가능, 다시 누르면 그 메뉴만 취소(가게 투표는 유지).
  $('candidates').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-menu]');
    if (!chip) return;
    const round = data.round;
    const c = round.candidates.find((x) => x.id === chip.dataset.cid);
    const menu = c && c.menus[Number(chip.dataset.menu)];
    if (!menu) return;
    const current = round.myVote && round.myVote.candidateId === c.id ? round.myVote.menus : [];
    const menus = current.includes(menu) ? current.filter((m) => m !== menu) : [...current, menu];
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/vote`, { method: 'POST', body: { candidateId: c.id, menus } });
      applyRound(res.round);
      showMessage('');
    });
  });

  // 메뉴 직접 추가 (투표 중: 그 가게의 내 선택에, 결정 후: 내 주문에)
  async function addMenu(cid, input) {
    const menu = input.value.trim();
    if (!menu) return;
    const round = data.round;
    await withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/candidates/${encodeURIComponent(cid)}/menu-items`, { method: 'POST', body: { menu } });
      input.value = '';
      input.blur();
      applyRound(res.round);
      showMessage(t('menu.added', { menu }));
    });
  }

  $('candidates').addEventListener('submit', (e) => {
    const form = e.target.closest('[data-add-cid]');
    if (!form) return;
    e.preventDefault();
    addMenu(form.dataset.addCid, form.querySelector('input'));
  });

  // 결정 후 메뉴 고르기
  $('decision').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-order-menu]');
    if (!chip) return;
    const round = data.round;
    const menu = round.winner.menus[Number(chip.dataset.orderMenu)];
    const current = round.myOrder || [];
    const menus = current.includes(menu) ? current.filter((m) => m !== menu) : [...current, menu];
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/order`, { method: 'POST', body: { menus } });
      applyRound(res.round);
      showMessage('');
    });
  });

  $('decision').addEventListener('submit', (e) => {
    const form = e.target.closest('[data-order-add]');
    if (!form) return;
    e.preventDefault();
    addMenu(data.round.winner.id, form.querySelector('input'));
  });

  // 관리자 메뉴 편집
  function openMenuEditor(cid) {
    const round = data.round;
    const c = round.status === 'done' && round.winner.id === cid ? round.winner : round.candidates.find((x) => x.id === cid);
    if (!c) return;
    const dialog = $('menuDialog');
    $('menuTitle').textContent = t('menu.editTitle', { name: c.name });
    $('menuInput').value = (c.menus || []).join('\n');
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
      const menus = $('menuInput').value.split('\n').map((m) => m.trim()).filter(Boolean);
      $('menuOk').disabled = true;
      try {
        const res = await api(`/api/rounds/${round.id}/candidates/${encodeURIComponent(c.id)}/menus`, {
          method: 'POST',
          body: { menus },
        });
        applyRound(res.round);
        close();
        showMessage(menus.length ? t('menu.saved', { name: c.name, n: menus.length }) : t('menu.cleared', { name: c.name }));
      } catch (err) {
        $('menuError').textContent = err.message;
        $('menuError').hidden = false;
      } finally {
        $('menuOk').disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    $('menuCancel').addEventListener('click', close);
  }

  for (const id of ['candidates', 'decision']) {
    $(id).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-menu-edit]');
      if (btn && isAdmin()) openMenuEditor(btn.dataset.menuEdit);
    });
  }

  $('drawBtn').addEventListener('click', () =>
    withBusy(async () => {
      const res = await api(`/api/rounds/${data.round.id}/draw`, { method: 'POST', body: {} });
      applyRound(res.round);
    })
  );

  $('completeBtn').addEventListener('click', () => {
    const round = data.round;
    if (!round || !isAdmin()) return;
    if (round.totalVotes === 0) return showMessage(t('complete.noVotes'), true);
    if (round.needsDraw) return showMessage(t('complete.needDraw'), true);
    if (!confirm(t('complete.confirm'))) return;
    withBusy(async () => {
      const res = await api(`/api/rounds/${round.id}/complete`, { method: 'POST', body: {} });
      applyRound(res.round);
      showMessage('');
      await refresh();
    });
  });

  $('shareBtn').addEventListener('click', async () => {
    const url = location.origin + location.pathname;
    try {
      await navigator.clipboard.writeText(url);
      showMessage(t('share.copied'));
    } catch {
      showMessage(t('share.manual', { url }));
    }
  });

  // ---------- 통계 ----------
  let statsMonth = '';
  let statsKey = null; // 마지막 결정 기록이 바뀌면 통계를 다시 불러온다
  let statsData = null;

  function monthLabel(m) {
    if (m === 'all') return t('stats.all');
    const [y, mo] = m.split('-').map(Number);
    return new Intl.DateTimeFormat(LOCALES[lang], { year: 'numeric', month: 'long' }).format(new Date(y, mo - 1, 1));
  }

  // rows: { name, count, sub?, value? } — 막대 길이는 count 기준, 오른쪽 숫자는 value(없으면 단위 붙인 count)
  function rankList(el, rows, unitKey) {
    if (!rows.length) {
      el.innerHTML = `<li class="rank-empty">${esc(t('stats.empty'))}</li>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.count), 1);
    el.innerHTML = rows
      .map((r, i) => {
        const value = r.value ?? t(unitKey, { n: r.count });
        return `
        <li title="${esc(`${r.name} ${value}`)}">
          <span class="rank-no">${i + 1}</span>
          <div class="rank-body">
            <div class="rank-label"><span>${esc(r.name)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><strong>${esc(value)}</strong></div>
            <div class="rank-bar"><span style="width:${r.count ? Math.max((r.count / max) * 100, 2) : 0}%"></span></div>
          </div>
        </li>`;
      })
      .join('');
  }

  function renderStats() {
    const st = statsData;
    const sel = $('statsMonth');
    sel.innerHTML = [...st.months, 'all'].map((m) => `<option value="${m}">${esc(monthLabel(m))}</option>`).join('');
    sel.value = st.month;

    const s = st.summary;
    $('statsTiles').innerHTML = [
      [t('stats.decisions'), t('stats.times', { n: s.decisions })],
      [t('stats.totalVotes'), t('stats.votesUnit', { n: s.totalVotes })],
      [t('stats.avgVoters'), t('stats.people', { n: s.avgVoters })],
      [t('stats.top'), s.topRestaurant || '-', true],
    ]
      .map(([label, value, text]) => `<div class="tile"><span class="label">${esc(label)}</span><strong class="${text ? 'text' : ''}" title="${esc(value)}">${esc(value)}</strong></div>`)
      .join('');

    rankList(
      $('statsPeople'),
      (st.people || []).map((p) => ({ name: p.name, count: p.rate, value: t('stats.hit', { wins: p.wins, rounds: p.rounds, rate: p.rate }) })),
      'stats.times'
    );
    rankList($('statsRestaurants'), st.restaurants.map((r) => ({ name: r.name, count: r.count, sub: catName(r.category) })), 'stats.times');
    rankList($('statsMenus'), st.menus.map((m) => ({ name: m.name, count: m.count, sub: m.restaurant })), 'stats.orders');
    rankList($('statsCategories'), st.categories.map((c) => ({ name: catName(c.label), count: c.count })), 'stats.times');
    rankList($('statsVotes'), st.popularCandidates.map((r) => ({ name: r.name, count: r.count, sub: catName(r.category) })), 'stats.votesUnit');
  }

  async function loadStats() {
    try {
      statsData = await api(`/api/stats${statsMonth ? `?month=${encodeURIComponent(statsMonth)}` : ''}`);
      statsMonth = statsData.month;
      renderStats();
    } catch (err) {
      $('statsTiles').innerHTML = `<p class="error">${esc(t('stats.failed', { error: err.message }))}</p>`;
    }
  }

  $('statsMonth').addEventListener('change', (e) => {
    statsMonth = e.target.value;
    loadStats();
  });

  // ---------- 전체 현황 (SB) ----------
  let overviewData = null;
  let overviewAt = 0;

  async function loadOverview() {
    if (!isSuper()) return;
    try {
      overviewData = await api('/api/admin/overview');
      overviewAt = Date.now();
      renderOverview();
    } catch (err) {
      $('ovTiles').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  function renderOverview() {
    const ov = overviewData;
    if (!ov) return;
    $('ovTiles').innerHTML = [
      [t('ov.groups'), ov.totals.groups],
      [t('ov.users'), ov.totals.users],
      [t('ov.decisions'), ov.totals.decisions],
      [t('ov.votes'), ov.totals.votes],
    ]
      .map(([label, value]) => `<div class="tile"><span class="label">${esc(label)}</span><strong>${esc(value)}</strong></div>`)
      .join('');
    $('ovGroups').innerHTML = ov.groups
      .map((g) => {
        const status = !g.round
          ? t('ov.idle')
          : g.round.status === 'voting'
            ? t('ov.voting', { n: g.round.votes })
            : t('ov.done', { name: g.round.winner || '-' });
        const href = g.isDefault ? '/' : `/g/${g.id}`;
        const meta = [
          g.owner ? t('ov.owner', { name: g.owner }) : '',
          t('ov.members', { n: g.members }),
          t('ov.monthDecisions', { n: g.decisionsThisMonth }),
          t('ov.total', { n: g.decisionsTotal }),
          g.lastDecision ? t('ov.last', { name: g.lastDecision.name, time: formatTime(g.lastDecision.at) }) : '',
        ].filter(Boolean);
        return `<li class="${g.id === groupId ? 'current' : ''}">
          <div class="info">
            <strong>${esc(g.isDefault ? t('ov.default') : g.name)}</strong>
            <small>${esc(meta.join(' · '))}</small>
            <small>${esc(status)}</small>
          </div>
          <a class="btn" href="${esc(href)}">${esc(t('ov.open'))}</a>
        </li>`;
      })
      .join('');
    rankList($('ovTop'), ov.topRestaurants.map((r) => ({ name: r.name, count: r.count, sub: catName(r.category) })), 'stats.times');
  }

  // ---------- 가게 관리 (관리자) ----------
  let adminPlaces = null;

  const adminApi = api;

  function adminShowError(text) {
    $('adminError').textContent = text || '';
    $('adminError').hidden = !text;
  }

  function adminFail(err) {
    adminShowError(err.message);
  }

  async function loadAdmin() {
    try {
      renderAdmin((await adminApi('/api/admin/places')).places);
    } catch (err) {
      adminFail(err);
    }
  }

  function renderAdmin(places) {
    adminPlaces = places;
    $('adminDesc').innerHTML = esc(t('admin.desc', { n: '\u0000', cmd: '\u0001' }))
      .replace('\u0000', `<strong>${places.length}</strong>`)
      .replace('\u0001', '<code>npm run upload-places</code>');
    $('adminList').innerHTML = places.length
      ? ['한식', '중식', '양식', '분식']
          .map((label) => {
            const rows = places.filter((p) => p.category === label);
            if (!rows.length) return `<div class="admin-group"><h4>${esc(t('admin.groupEmpty', { cat: catName(label) }))}</h4></div>`;
            return `<div class="admin-group"><h4>${esc(t('admin.group', { cat: catName(label), n: rows.length }))}</h4>${rows
              .map(
                (p) => `
              <div class="admin-row">
                <div class="info">
                  <strong>${esc(p.name)}</strong>
                  <small>${esc(
                    [p.address, p.menus.length ? t('admin.menusInfo', { n: p.menus.length, list: p.menus.slice(0, 5).join(', ') + (p.menus.length > 5 ? '…' : '') }) : t('admin.noMenus')]
                      .filter(Boolean)
                      .join(' · ')
                  )}</small>
                </div>
                <button class="small" data-naver="${esc(p.id)}" type="button">${esc(p.naverPlaceId ? t('admin.naverSet') : t('admin.naverBtn'))}</button>
                <button class="small danger" data-del="${esc(p.id)}" type="button">${esc(t('admin.delete'))}</button>
              </div>`
              )
              .join('')}</div>`;
          })
          .join('')
      : `<p class="muted small-text">${esc(t('admin.empty'))}</p>`;
  }

  async function adminAfterChange(places, msg) {
    renderAdmin(places);
    adminShowError('');
    if (msg) showMessage(msg);
    await refresh();
  }

  $('adminDetails').addEventListener('toggle', () => {
    if ($('adminDetails').open && isAdmin()) loadAdmin();
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
      await adminAfterChange(res.places, t('admin.saved', { name: place.name }));
    } catch (err) {
      adminFail(err);
    }
  });

  $('adminImportBtn').addEventListener('click', async () => {
    let list;
    try {
      list = JSON.parse($('adminImport').value);
    } catch {
      adminShowError(t('admin.badJson'));
      return;
    }
    const replace = $('adminReplace').checked;
    if (replace && !confirm(t('admin.confirmReplace'))) return;
    try {
      const res = await adminApi('/api/admin/places', { method: 'POST', body: { mode: replace ? 'replace' : 'merge', places: list } });
      $('adminImport').value = '';
      $('adminReplace').checked = false;
      await adminAfterChange(res.places, t('admin.imported', { n: res.saved }) + (res.errors.length ? t('admin.importErrors', { n: res.errors.length }) : ''));
    } catch (err) {
      adminFail(err);
    }
  });

  $('adminList').addEventListener('click', async (e) => {
    const naverBtn = e.target.closest('[data-naver]');
    const delBtn = e.target.closest('[data-del]');
    const place = (adminPlaces || []).find((p) => p.id === (naverBtn || delBtn || {}).dataset?.[naverBtn ? 'naver' : 'del']);
    if (!place) return;
    try {
      if (naverBtn) {
        const input = prompt(t('admin.naverPrompt', { name: place.name }), place.naverUrl || '');
        if (input === null) return;
        const naverUrl = input.trim();
        if (naverUrl && !/(?:\/place\/|\/restaurant\/|[?&]id=)\d{5,}|^\d{5,}$/.test(naverUrl)) {
          adminShowError(t('admin.naverInvalid'));
          return;
        }
        const res = await adminApi('/api/admin/places', { method: 'POST', body: { mode: 'merge', places: [{ ...place, naverUrl, naverPlaceId: '' }] } });
        await adminAfterChange(res.places, t(naverUrl ? 'admin.naverSaved' : 'admin.naverCleared', { name: place.name }));
      } else {
        if (!confirm(t('admin.confirmDelete', { name: place.name }))) return;
        const res = await adminApi(`/api/admin/places/${encodeURIComponent(place.id)}`, { method: 'DELETE' });
        await adminAfterChange(res.places, t('admin.deleted', { name: place.name }));
      }
    } catch (err) {
      adminFail(err);
    }
  });

  // ---------- 시작 ----------
  applyStatic();
  if (!session) openUserDialog(true);
  // 방금 만든 그룹이면 안내
  const created = local.get('eatzy-group-created');
  if (created) {
    local.set('eatzy-group-created', null);
    showMessage(t('group.created', { name: created }));
  }
  refresh();
  setInterval(() => {
    const dialogOpen = ['userDialog', 'menuDialog', 'noticeDialog', 'placeDialog'].some((id) => $(id).open);
    if (!busy && !noGroup && !document.hidden && !dialogOpen) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
