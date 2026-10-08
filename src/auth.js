const crypto = require('crypto');

// 비밀번호는 원문을 저장하지 않고 salt + scrypt 해시로만 저장한다
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(password), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 로그인 실패가 이름별로 10분에 5번을 넘으면 잠시 막는다 (메모리, 서버 재시작 시 초기화)
const failures = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

function tooManyFailures(key) {
  const f = failures.get(key);
  return Boolean(f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILURES);
}

function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first >= WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function clearFailures(key) {
  failures.delete(key);
}

module.exports = { hashPassword, verifyPassword, tooManyFailures, recordFailure, clearFailures, failures };
