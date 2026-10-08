// 외부 페이지를 우리 화면 안(iframe)에 띄울 수 있는지 응답 헤더로 확인한다.
// X-Frame-Options가 있거나 CSP frame-ancestors가 전체 허용(*)이 아니면 띄울 수 없다고 본다.
const cache = new Map();
const TTL_MS = 12 * 60 * 60 * 1000;

function embeddableFromHeaders(headers) {
  const xfo = (headers.get('x-frame-options') || '').trim();
  if (xfo) return false;
  const csp = headers.get('content-security-policy') || '';
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (directive) return /(^|\s)\*(\s|$)/.test(directive.slice('frame-ancestors'.length));
  return true;
}

async function checkEmbeddable(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Eatzy-frame-check/1.0)', Accept: 'text/html' },
    });
    ok = res.ok && embeddableFromHeaders(res.headers);
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
  } catch {
    ok = false;
  }
  cache.set(url, { ok, at: Date.now() });
  return ok;
}

module.exports = { checkEmbeddable, embeddableFromHeaders, cache };
