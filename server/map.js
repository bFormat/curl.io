/* server/map.js — 맵 지오메트리. 클라에 그대로 전송되어 동일 좌표로 렌더된다.
 * 각 맵: 단일 평면 + 외벽 4개(obstacles 0~3) + 내부 박스 장애물.
 * 장애물은 풀하이트로 취급(점프 높이 ~1.45m < 박스 높이 3m → 못 올라감). */
'use strict';

function box(minx, minz, maxx, maxz, h) {
  return { min: { x: minx, y: 0, z: minz }, max: { x: maxx, y: h, z: maxz } };
}

// 외벽 4개 (두께 2). obstacles 배열의 앞 4개는 항상 외벽 — 클라가 색을 구분한다.
function walls(half, h) {
  return [
    box(-half - 2, -half - 2, half + 2, -half, h),
    box(-half - 2, half, half + 2, half + 2, h),
    box(-half - 2, -half - 2, -half, half + 2, h),
    box(half, -half - 2, half + 2, half + 2, h)
  ];
}

// ── 맵 1: 박스 아레나 ──
const ARENA1 = {
  name: 'box-arena',
  half: 24,
  ground: { y: 0 },
  obstacles: [
    ...walls(24, 5),
    box(-9.5, -7.5, -6.5, -4.5, 3),
    box(6.5, 4.5, 9.5, 7.5, 3),
    box(8, -12, 12, -8, 3),
    box(-14, 8, -10, 12, 3),
    box(-1, -6, 1, 6, 3.5),
    box(-16, -2, -12, 2, 3),
    box(12, -2, 16, 2, 3)
  ],
  spawns: [
    { x: -18, y: 0, z: -18 }, { x: 18, y: 0, z: 18 },
    { x: 18, y: 0, z: -18 }, { x: -18, y: 0, z: 18 },
    { x: 0, y: 0, z: -20 }, { x: 0, y: 0, z: 20 },
    { x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 },
    { x: 7, y: 0, z: -2 }, { x: -7, y: 0, z: 2 }
  ]
};

// ── 맵 2: 필러 야드 (중앙 블록 + 다이아몬드 배치) ──
const ARENA2 = {
  name: 'pillar-yard',
  half: 22,
  ground: { y: 0 },
  obstacles: [
    ...walls(22, 5),
    box(-3.5, -3.5, 3.5, 3.5, 4),       // 중앙 블록
    box(-14, -14, -10, -10, 3),
    box(10, 10, 14, 14, 3),
    box(10, -14, 14, -10, 3),
    box(-14, 10, -10, 14, 3),
    box(-2, -15, 2, -11, 3),
    box(-2, 11, 2, 15, 3),
    box(-15, -2, -11, 2, 3),
    box(11, -2, 15, 2, 3)
  ],
  spawns: [
    { x: -17, y: 0, z: -17 }, { x: 17, y: 0, z: 17 },
    { x: 17, y: 0, z: -17 }, { x: -17, y: 0, z: 17 },
    { x: 0, y: 0, z: -18 }, { x: 0, y: 0, z: 18 },
    { x: -18, y: 0, z: 0 }, { x: 18, y: 0, z: 0 },
    { x: -8, y: 0, z: 8 }, { x: 8, y: 0, z: -8 }
  ]
};

const MAPS = [ARENA1, ARENA2];

function pickMap() {
  return MAPS[Math.floor(Math.random() * MAPS.length)];
}

module.exports = { MAPS, pickMap };
