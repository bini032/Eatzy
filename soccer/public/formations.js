// 포메이션 프리셋. 서버(require)와 화면(<script>) 양쪽에서 쓴다.
// 경기장 좌표는 미터 단위: x = 0(왼쪽 터치라인) ~ 68, y = 0(위쪽 골라인) ~ 105.
// 우리 팀은 아래쪽 골대를 지키며 위쪽으로 공격하고, 상대 팀은 그 반대다.
// 프리셋 값: [포지션, 가로 비율(우리 팀 기준 왼쪽 0 ~ 오른쪽 1), 깊이(자기 골라인 0 ~ 하프라인 1)]
(function () {
  const W = 68;
  const L = 105;
  const HALF = L / 2;

  const back4 = [
    ['LB', 0.14, 0.3],
    ['CB', 0.38, 0.24],
    ['CB', 0.62, 0.24],
    ['RB', 0.86, 0.3],
  ];
  const back3 = [
    ['CB', 0.24, 0.26],
    ['CB', 0.5, 0.22],
    ['CB', 0.76, 0.26],
  ];
  const GK = ['GK', 0.5, 0.05];

  const PRESETS = {
    '4-4-2': [GK, ...back4, ['LM', 0.14, 0.6], ['CM', 0.38, 0.55], ['CM', 0.62, 0.55], ['RM', 0.86, 0.6], ['ST', 0.38, 0.88], ['ST', 0.62, 0.88]],
    '4-3-3': [GK, ...back4, ['CM', 0.3, 0.58], ['DM', 0.5, 0.48], ['CM', 0.7, 0.58], ['LW', 0.16, 0.84], ['ST', 0.5, 0.9], ['RW', 0.84, 0.84]],
    '4-2-3-1': [GK, ...back4, ['DM', 0.38, 0.48], ['DM', 0.62, 0.48], ['LM', 0.17, 0.72], ['AM', 0.5, 0.72], ['RM', 0.83, 0.72], ['ST', 0.5, 0.92]],
    '4-1-4-1': [GK, ...back4, ['DM', 0.5, 0.45], ['LM', 0.14, 0.66], ['CM', 0.38, 0.64], ['CM', 0.62, 0.64], ['RM', 0.86, 0.66], ['ST', 0.5, 0.92]],
    '3-5-2': [GK, ...back3, ['LWB', 0.1, 0.56], ['CM', 0.33, 0.58], ['DM', 0.5, 0.46], ['CM', 0.67, 0.58], ['RWB', 0.9, 0.56], ['ST', 0.38, 0.88], ['ST', 0.62, 0.88]],
    '3-4-3': [GK, ...back3, ['LM', 0.12, 0.56], ['CM', 0.38, 0.52], ['CM', 0.62, 0.52], ['RM', 0.88, 0.56], ['LW', 0.2, 0.84], ['ST', 0.5, 0.9], ['RW', 0.8, 0.84]],
    '5-3-2': [GK, ['LWB', 0.1, 0.36], ['CB', 0.3, 0.24], ['CB', 0.5, 0.22], ['CB', 0.7, 0.24], ['RWB', 0.9, 0.36], ['CM', 0.3, 0.58], ['CM', 0.5, 0.54], ['CM', 0.7, 0.58], ['ST', 0.38, 0.88], ['ST', 0.62, 0.88]],
  };
  const NAMES = Object.keys(PRESETS);
  const DEFAULT = '4-4-2';

  const round = (v) => Math.round(v * 10) / 10;

  // side: 'home'(아래쪽, 위로 공격) 또는 'away'(위쪽, 아래로 공격)
  function positions(name, side) {
    const preset = PRESETS[name] || PRESETS[DEFAULT];
    return preset.map(([pos, fx, fd]) => {
      const depth = fd * HALF * 0.96;
      return side === 'away'
        ? { pos, x: round((1 - fx) * W), y: round(depth) }
        : { pos, x: round(fx * W), y: round(L - depth) };
    });
  }

  const api = { W, L, NAMES, DEFAULT, positions };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.Formations = api;
})();
