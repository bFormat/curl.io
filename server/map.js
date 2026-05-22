/* server/map.js — 맵 지오메트리 (v0.2 확장: 2배 크기 + 2층 건물).
 * 클라에 그대로 전송되어 동일 좌표로 렌더된다.
 * obstacle.kind: 'wall'|'pillar'|'floor'|'stair'|'crate' — 색 구분용 (충돌과 무관).
 * 충돌은 shared/sim.js — 단차 STEP_UP(0.55) 이하는 자동으로 올라설 수 있다. */
'use strict';

function B(kind, x0, z0, x1, z1, y0, y1) {
  return { kind, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

// 외벽 4개 (두께 2). 항상 obstacles 앞 4개.
function walls(half, h) {
  return [
    B('wall', -half - 2, -half - 2, half + 2, -half, 0, h),
    B('wall', -half - 2, half, half + 2, half + 2, 0, h),
    B('wall', -half - 2, -half - 2, -half, half + 2, 0, h),
    B('wall', half, -half - 2, half + 2, half + 2, 0, h)
  ];
}

// +z 방향으로 오르는 계단 (n칸, 총 높이 totalH). 칸끼리 겹쳐 빈틈 없음.
function stairsZ(x0, x1, z0, n, totalH, depth) {
  const a = [];
  const sh = totalH / n;
  for (let i = 0; i < n; i++) {
    a.push(B('stair', x0, z0 + i * depth, x1, z0 + i * depth + depth * 2.2, 0, sh * (i + 1)));
  }
  return a;
}

// ── 맵 1: 박스 아레나 — 2층 건물 포함 ──
const ARENA1 = {
  name: 'box-arena',
  half: 44,
  ground: { y: 0 },
  obstacles: [
    ...walls(44, 6),
    // 건물 외벽 (x[10,32] z[6,28], 높이 4.5)
    B('wall', 10, 27, 32, 28, 0, 4.5),     // 뒷벽
    B('wall', 10, 6, 11, 28, 0, 4.5),      // 왼벽
    B('wall', 31, 6, 32, 28, 0, 4.5),      // 오른벽
    B('wall', 10, 6, 19, 7, 0, 4.5),       // 앞벽 좌 (문 x[19,23])
    B('wall', 23, 6, 32, 7, 0, 4.5),       // 앞벽 우
    // 2층 바닥 슬랩
    B('floor', 11, 14, 31, 27, 3.0, 3.4),
    // 실내 계단 (왼쪽, +z로 올라 2층 슬랩에 연결)
    ...stairsZ(11.5, 16, 7, 8, 3.4, 0.8),
    // 야외 엄폐 기둥
    B('pillar', -20, -20, -17, -17, 0, 3),
    B('pillar', -8, 8, -5, 11, 0, 3),
    B('pillar', -30, 6, -27, 9, 0, 3),
    B('pillar', -14, -34, -11, -31, 0, 3),
    B('pillar', 24, -26, 27, -23, 0, 3),
    B('pillar', -2, -12, 1, -9, 0, 3),
    // 낮은 상자 (뛰어오를 수 있는 엄폐물)
    B('crate', -22, 4, -20.5, 5.5, 0, 0.6),
    B('crate', 6, -8, 7.5, -6.5, 0, 0.6),
    B('crate', -34, -6, -32.5, -4.5, 0, 0.6),
    B('crate', 16, 34, 17.5, 35.5, 0, 0.6)
  ],
  spawns: [
    { x: -34, y: 0, z: -34 }, { x: 36, y: 0, z: -36 },
    { x: -36, y: 0, z: 36 }, { x: 0, y: 0, z: 38 },
    { x: 0, y: 0, z: -38 }, { x: -38, y: 0, z: 0 },
    { x: 38, y: 0, z: 12 }, { x: -12, y: 0, z: -20 },
    { x: 20, y: 0, z: -32 }, { x: -26, y: 0, z: 20 }
  ]
};

// ── 맵 2: 필러 야드 — 중앙 상승 플랫폼 ──
const ARENA2 = {
  name: 'pillar-yard',
  half: 40,
  ground: { y: 0 },
  obstacles: [
    ...walls(40, 6),
    // 중앙 플랫폼 (윗면 y3.4) + 계단 1기
    B('floor', -9, -9, 9, 9, 3.0, 3.4),
    ...stairsZ(-4, 4, -16, 8, 3.4, 0.8),
    // 기둥
    B('pillar', -24, -24, -21, -21, 0, 3),
    B('pillar', 21, 21, 24, 24, 0, 3),
    B('pillar', 21, -24, 24, -21, 0, 3),
    B('pillar', -24, 21, -21, 24, 0, 3),
    B('pillar', -3, -28, 0, -25, 0, 3),
    B('pillar', 0, 25, 3, 28, 0, 3),
    B('pillar', -28, -2, -25, 1, 0, 3),
    B('pillar', 25, -1, 28, 2, 0, 3),
    // 낮은 상자
    B('crate', -15, 12, -13.5, 13.5, 0, 0.6),
    B('crate', 13, -14, 14.5, -12.5, 0, 0.6),
    B('crate', -16, -15, -14.5, -13.5, 0, 0.6)
  ],
  spawns: [
    { x: -32, y: 0, z: -32 }, { x: 32, y: 0, z: 32 },
    { x: 32, y: 0, z: -32 }, { x: -32, y: 0, z: 32 },
    { x: 0, y: 0, z: -34 }, { x: 0, y: 0, z: 34 },
    { x: -34, y: 0, z: 0 }, { x: 34, y: 0, z: 0 },
    { x: -16, y: 0, z: 16 }, { x: 16, y: 0, z: -16 }
  ]
};

const MAPS = [ARENA1, ARENA2];

function pickMap() {
  return MAPS[Math.floor(Math.random() * MAPS.length)];
}

module.exports = { MAPS, pickMap };
