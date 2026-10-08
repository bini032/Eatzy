// 메뉴 이름에서 가격 추출: "짜장면 7,000원" -> 7000. 범위("4,000~8,000원")나 가격이 없으면 null
function menuPrice(label) {
  const s = String(label || '');
  if (/\d\s*~\s*\d/.test(s)) return null;
  const m = s.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// { 메뉴: 개수 } -> { total, unknown } (가격을 모르는 메뉴는 개수만 따로 센다)
function estimateTotal(menuCounts) {
  let total = 0;
  let unknown = 0;
  for (const [menu, n] of Object.entries(menuCounts || {})) {
    if (!menu) continue;
    const p = menuPrice(menu);
    if (p === null) unknown += n;
    else total += p * n;
  }
  return { total, unknown };
}

module.exports = { menuPrice, estimateTotal };
