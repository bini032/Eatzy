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
    history: [],
    recent: {},
  };
}

// 단일 프로세스 기준의 아주 단순한 JSON 파일 저장소.
// 투표 인원이 수십 명 수준인 점심 투표에는 충분하다.
class Store {
  constructor(file) {
    this.file = file;
    this.state = this.load();
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaultState };
