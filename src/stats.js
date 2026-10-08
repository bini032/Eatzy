// 결정 기록(history)으로 월간 통계를 만든다. 월은 한국 시간 기준 YYYY-MM.
function kstMonth(value) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function topN(map, n) {
  return [...map.values()].sort((a, b) => b.count - a.count || (b.votes || 0) - (a.votes || 0)).slice(0, n);
}

// 공동 1위가 있으면 "가게A 외 2곳"
function topLabel(ranking) {
  const ties = ranking.filter((r) => r.count === ranking[0].count).length - 1;
  return ties > 0 ? `${ranking[0].name} 외 ${ties}곳` : ranking[0].name;
}

// month: 'YYYY-MM' 또는 'all'
function buildStats(history, month, categories) {
  const months = [...new Set([kstMonth(Date.now()), ...history.map((h) => kstMonth(h.decidedAt))])].sort().reverse();
  const entries = month === 'all' ? history : history.filter((h) => kstMonth(h.decidedAt) === month);

  const restaurants = new Map();
  const cats = new Map(categories.map((c) => [c.label, { label: c.label, count: 0 }]));
  const menus = new Map();
  const people = new Map(); // 이름별 투표 횟수와 내가 고른 가게가 결정된 횟수
  let totalVotes = 0;

  for (const h of entries) {
    const w = h.winner || {};
    totalVotes += h.totalVotes || 0;

    const r = restaurants.get(w.id) || { id: w.id, name: w.name, category: w.categoryLabel, count: 0, votes: 0, nominated: 0 };
    r.count++;
    restaurants.set(w.id, r);
    if (cats.has(w.categoryLabel)) cats.get(w.categoryLabel).count++;

    // 후보별 득표 (예전 기록에는 없어서 우승 가게 득표만 반영)
    const candidates = h.candidates || [{ id: w.id, name: w.name, categoryLabel: w.categoryLabel, votes: w.votes || 0 }];
    for (const c of candidates) {
      const cr = restaurants.get(c.id) || { id: c.id, name: c.name, category: c.categoryLabel, count: 0, votes: 0, nominated: 0 };
      cr.votes += c.votes || 0;
      cr.nominated++;
      restaurants.set(c.id, cr);
    }

    for (const v of h.voters || []) {
      const key = v.name.toLowerCase();
      const p = people.get(key) || { name: v.name, rounds: 0, wins: 0 };
      p.rounds++;
      if (v.candidateId === w.id) p.wins++;
      people.set(key, p);
    }

    for (const [menu, n] of Object.entries(w.menuCounts || {})) {
      if (!menu) continue;
      const key = `${w.id}|${menu}`;
      const m = menus.get(key) || { name: menu, restaurant: w.name, count: 0 };
      m.count += n;
      menus.set(key, m);
    }
  }

  const ranking = topN(new Map([...restaurants].filter(([, r]) => r.count > 0)), 10);
  return {
    month,
    months,
    summary: {
      decisions: entries.length,
      totalVotes,
      avgVoters: entries.length ? Math.round((totalVotes / entries.length) * 10) / 10 : 0,
      topRestaurant: ranking[0] ? topLabel(ranking) : null,
    },
    restaurants: ranking,
    popularCandidates: topN(new Map([...restaurants].map(([k, r]) => [k, { ...r, count: r.votes }])), 10).filter((r) => r.count > 0),
    categories: [...cats.values()],
    menus: topN(menus, 10),
    // 선택 적중률 순 (같으면 적중 횟수, 참여 횟수 순)
    people: [...people.values()]
      .map((p) => ({ ...p, rate: Math.round((p.wins / p.rounds) * 100) }))
      .sort((a, b) => b.rate - a.rate || b.wins - a.wins || b.rounds - a.rounds)
      .slice(0, 10),
  };
}

module.exports = { buildStats, kstMonth };
