const crypto = require('crypto');

const MAX_NAME_LENGTH = 20;

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

// 같은 이름(대소문자·공백 무관)이면 같은 계정 id
function userIdFor(name) {
  return 'u' + crypto.createHash('sha256').update(`user:${cleanName(name).toLowerCase()}`).digest('hex').slice(0, 15);
}

module.exports = { cleanName, userIdFor, MAX_NAME_LENGTH };
