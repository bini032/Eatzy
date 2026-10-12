// 후기·별점. 그룹 상태의 reviews에 가게별로 저장한다.
// reviews: { [가게id]: { name, category, items: { [사용자id]: { name, rating(1~5), comment, at } } } }
const { kstMonth } = require('./stats');

const MIN_RATING_OPTIONS = [0, 2, 2.5, 3, 3.5]; // 0 = 별점으로 후보를 빼지 않음
const MIN_REVIEWS_OPTIONS = [1, 2, 3, 5];
const DEFAULT_RATING_FILTER = { minRating: 2.5, minReviews: 2 };
const MAX_COMMENT = 200;

const round1 = (n) => Math.round(n * 10) / 10;

function ratingFilter(settings) {
  return { ...DEFAULT_RATING_FILTER, ...((settings && settings.ratingFilter) || {}) };
}

// 가게별 평균 별점과 후기 수
function placeRating(entry) {
  const items = Object.values((entry && entry.items) || {});
  if (!items.length) return null;
  const sum = items.reduce((a, r) => a + r.rating, 0);
  return { avg: round1(sum / items.length), count: items.length };
}

// 기준 미달(평균이 minRating 미만이고 후기가 minReviews개 이상)인 가게
function isExcluded(rating, filter) {
  return Boolean(rating && filter.minRating > 0 && rating.count >= filter.minReviews && rating.avg < filter.minRating);
}

function excludedIds(reviews, filter) {
  const ids = new Set();
  for (const [id, entry] of Object.entries(reviews || {})) {
    if (isExcluded(placeRating(entry), filter)) ids.add(id);
  }
  return ids;
}

// 화면용 요약: { [가게id]: { avg, count, mine, excluded } }
function ratingSummary(reviews, filter, userId) {
  const out = {};
  for (const [id, entry] of Object.entries(reviews || {})) {
    const rating = placeRating(entry);
    if (!rating) continue;
    const mine = userId && entry.items[userId] ? entry.items[userId].rating : 0;
    out[id] = { ...rating, mine, excluded: isExcluded(rating, filter) };
  }
  return out;
}

// 별점 통계. 가게 순위는 전체 기간 평균, 후기 수와 최근 후기는 고른 기간(month: 'YYYY-MM' 또는 'all') 기준
function buildRatingStats(reviews, month, filter) {
  const places = [];
  const recent = [];
  let total = 0;
  let sum = 0;
  let periodCount = 0;
  const reviewers = new Set();
  for (const [id, entry] of Object.entries(reviews || {})) {
    const rating = placeRating(entry);
    if (!rating) continue;
    places.push({ id, name: entry.name, category: entry.category, ...rating, excluded: isExcluded(rating, filter) });
    for (const r of Object.values(entry.items)) {
      total++;
      sum += r.rating;
      if (month !== 'all' && kstMonth(r.at) !== month) continue;
      periodCount++;
      reviewers.add(r.name);
      recent.push({ place: entry.name, name: r.name, rating: r.rating, comment: r.comment || '', at: r.at });
    }
  }
  const byBest = (a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name);
  return {
    filter,
    summary: { reviews: total, places: places.length, avg: total ? round1(sum / total) : 0, periodReviews: periodCount, reviewers: reviewers.size },
    top: [...places].sort(byBest).slice(0, 10),
    low: places.filter((p) => p.excluded || p.avg < 3).sort((a, b) => a.avg - b.avg || b.count - a.count).slice(0, 10),
    recent: recent.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
  };
}

module.exports = {
  MIN_RATING_OPTIONS,
  MIN_REVIEWS_OPTIONS,
  MAX_COMMENT,
  ratingFilter,
  placeRating,
  excludedIds,
  ratingSummary,
  buildRatingStats,
};
