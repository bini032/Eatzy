const fs = require('fs');
const path = require('path');

// 저장 문서 { version, team: { name, players }, strategies: [ { id, rev, createdAt, updatedAt, ...전술 } ] }
function normalize(raw, teamName) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  return {
    version: Number.isInteger(doc.version) ? doc.version : 0,
    team: doc.team && typeof doc.team === 'object' ? doc.team : { name: teamName || '우리 팀', players: [] },
    strategies: Array.isArray(doc.strategies) ? doc.strategies : [],
  };
}

// 단일 서버 기준의 단순한 저장소: 문서 전체를 메모리에 두고 바뀔 때마다 통째로 저장한다 (Eatzy와 같은 방식).
// - 기본: DATA_DIR/state.json
// - redis 옵션: Upstash Redis REST API (파일이 보존되지 않는 무료 호스팅용)
class Store {
  constructor(file, { redis, teamName } = {}) {
    this.file = file;
    this.redis = redis || null; // { url, token, key }
    this.teamName = teamName;
    this.state = this.redis ? normalize(null, teamName) : this.load();
    this.pushing = null;
    this.dirty = false;
  }

  // 불러오기에 실패한 채로 시작하면 빈 문서가 기존 데이터를 덮어쓰므로 오류를 그대로 던진다
  async init() {
    if (!this.redis) return;
    const raw = await this.redisCommand(['GET', this.redis.key]);
    if (raw) this.state = normalize(JSON.parse(raw), this.teamName);
  }

  load() {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.teamName);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('저장 파일을 읽지 못해 새로 시작합니다:', err.message);
      return normalize(null, this.teamName);
    }
  }

  // 바뀔 때마다 version을 올려 화면이 새 내용을 알아챌 수 있게 한다
  save() {
    this.state.version += 1;
    if (this.redis) return this.pushToRedis();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  // 저장 요청이 몰리면 마지막 상태만 한 번 더 보낸다
  pushToRedis() {
    if (this.pushing) {
      this.dirty = true;
      return this.pushing;
    }
    this.pushing = (async () => {
      do {
        this.dirty = false;
        try {
          await this.redisCommand(['SET', this.redis.key, JSON.stringify(this.state)]);
        } catch (err) {
          console.error('Redis 저장 실패:', err.message);
        }
      } while (this.dirty);
      this.pushing = null;
    })();
    return this.pushing;
  }

  flush() {
    return this.pushing || Promise.resolve();
  }

  async redisCommand(command) {
    const res = await fetch(this.redis.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.redis.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
    return body.result;
  }
}

module.exports = { Store, normalize };
