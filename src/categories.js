// 점심 후보 카테고리. 데이터에는 한국어 라벨(한식/세계음식/분식)을 쓰고 화면에서만 번역한다.
// - count: 한 번 뽑을 때 이 카테고리에서 몇 곳을 뽑을지 (세계음식은 종류가 넓어 2곳, 가능하면 서로 다른 세부 종류로)
// - queries: 카카오 실시간 검색어. 카카오 분류(category_name)에 이 단어가 들어간 가게만 쓴다
// - cuisine: 세계음식의 세부 종류(일식, 베트남, 이탈리안 …). 가게 데이터의 선택 항목이며 번역하지 않는다
const CATEGORIES = [
  { key: 'korean', label: '한식', count: 1, queries: ['한식'] },
  { key: 'global', label: '세계음식', count: 2, queries: ['양식', '일식', '중식', '아시아음식'] },
  { key: 'snack', label: '분식', count: 1, queries: ['분식'] },
];
const LABELS = CATEGORIES.map((c) => c.label);

// 예전 카테고리(한식/중식/양식/분식 4개 시절)와 흔히 쓰는 세부 이름 -> 세계음식 + 세부 종류
const LEGACY = { 중식: '중식', 양식: '양식', 일식: '일식', 아시아음식: '아시아' };
const LEGACY_KEYS = { chinese: '중식', western: '양식' };

// 카테고리 라벨 정리: { label, cuisine }. 모르는 값이면 label은 null
function normalizeCategory(label, cuisine = '') {
  const c = String(cuisine || '').trim();
  if (LABELS.includes(label)) return { label, cuisine: label === '세계음식' ? c : '' };
  if (label in LEGACY) return { label: '세계음식', cuisine: c || LEGACY[label] };
  return { label: null, cuisine: c };
}

const byLabel = (label) => CATEGORIES.find((c) => c.label === label);

// 저장된 문서의 예전 카테고리를 새 카테고리로 바꾼다 (여러 번 실행해도 결과가 같다)
function migrateGroupCategories(g) {
  if (!g) return;
  const fixPlace = (p) => {
    if (!p || typeof p !== 'object') return;
    if (p.category && !LABELS.includes(p.category) && p.category in LEGACY) {
      const n = normalizeCategory(p.category, p.cuisine);
      p.category = n.label;
      if ('label' in p) p.label = n.label;
      p.cuisine = n.cuisine;
    }
  };
  // 후보·결정 가게: categoryKey/categoryLabel
  const fixCandidate = (c) => {
    if (!c || typeof c !== 'object') return;
    const legacy = LEGACY_KEYS[c.categoryKey] || (c.categoryLabel in LEGACY ? LEGACY[c.categoryLabel] : '');
    if (legacy) {
      c.categoryKey = 'global';
      c.categoryLabel = '세계음식';
      c.cuisine = c.cuisine || legacy;
    }
    fixPlace(c);
  };
  for (const p of g.places || []) fixPlace(p);
  fixCandidate(g.lastWinner);
  if (g.round) {
    for (const c of g.round.candidates || []) fixCandidate(c);
    fixCandidate(g.round.winner);
  }
  for (const h of g.history || []) {
    fixCandidate(h.winner);
    for (const c of h.candidates || []) fixCandidate(c);
  }
  for (const r of Object.values(g.reviews || {})) {
    if (r && r.category in LEGACY) r.category = '세계음식';
  }
  // 중복 없이 뽑기 기록: 예전 중식·양식 기록은 세계음식으로 합친다
  if (g.recent && (g.recent.chinese || g.recent.western)) {
    g.recent.global = [...new Set([...(g.recent.global || []), ...(g.recent.chinese || []), ...(g.recent.western || [])])];
    delete g.recent.chinese;
    delete g.recent.western;
  }
}

module.exports = { CATEGORIES, LABELS, LEGACY, normalizeCategory, byLabel, migrateGroupCategories };
