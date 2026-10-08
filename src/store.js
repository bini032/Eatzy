const fs = require('fs');
const path = require('path');

function defaultState() {
  return {
    settings: {
      origin: null, // { name, x, y, source }  x = 경도, y = 위도
      radius: 1000,
    },
    round: null,
    lastWinner: null,
    places: [], // CLI 업로드나 관리자 화면으로 저장한 가게 목록 (있으면 restaurants.json보다 우선)
    menus: {}, // 관리자가 앱에서 입력한 가게별 메뉴 { [가게id]: ["메뉴", ...] }
    history: [],
    recent: {},
  };
}

// 단일 프로세스 기준의 아주 단순한 저장소. 상태 전체를 메모리에 두고 바뀔 때마다 통째로 저장한다.
// 투표 인원이 수십 명 수준인 점심 투표에는 충분하다.
// - 기본: JSON 파일
// - redis 옵션: Upstash Redis REST API (파일이 보존되지 않는 무료 호스팅용)
class Store {
  constructor(file, { redis } = {}) {
    this.file = file;
    this.redis = redis || null; // { url, token, key }
    this.state = this.redis ? defaultState() : this.load();
    this.pushing = null;
    this.dirty = false;
  }

  // Redis 사용 시 서버 시작 전에 한 번 불러온다.
  // 불러오기에 실패한 채로 시작하면 빈 상태가 기존 데이터를 덮어쓰므로 오류를 그대로 던진다.
  async init() {
    if (!this.redis) return;
    const raw = await this.redisCommand(['GET', this.redis.key]);
    if (raw) this.state = { ...defaultState(), ...JSON.parse(raw) };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...defaultState(), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('저장 파일을 읽지 못해 새로 시작합니다:', err.message);
      return defaultState();
    }
  }

  save() {
    if (this.redis) {
      this.pushToRedis();
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // 저장 요청이 몰리면 마지막 상태만 한 번 더 보낸다 (항상 최신 상태가 남도록).
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

  // 테스트나 종료 직전에 저장이 끝날 때까지 기다릴 때 사용
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

module.exports = { Store, defaultState };
