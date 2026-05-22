/* server/map.js — 맵 지오메트리. 클라에 그대로 전송되어 동일 좌표로 렌더된다.
 * 단일 평면(48x48, 원점 중심) + 외벽 4개 + 내부 박스 장애물 몇 개.
 * 장애물은 풀하이트로 취급(점프 높이 ~1.45m < 박스 높이 3m → 못 올라감). */
'use strict';

function box(minx, minz, maxx, maxz, h) {
  return { min: { x: minx, y: 0, z: minz }, max: { x: maxx, y: h, z: maxz } };
}

const HALF = 24;       // 평면 반폭
const WALL_H = 5;
const PILLAR_H = 3;

const MAP = {
  name: 'box-arena-1',
  half: HALF,
  ground: { y: 0 },
  obstacles: [
    // 외벽 (두께 2)
    box(-HALF - 2, -HALF - 2, HALF + 2, -HALF, WALL_H),  // north
    box(-HALF - 2, HALF, HALF + 2, HALF + 2, WALL_H),    // south
    box(-HALF - 2, -HALF - 2, -HALF, HALF + 2, WALL_H),  // west
    box(HALF, -HALF - 2, HALF + 2, HALF + 2, WALL_H),    // east
    // 내부 장애물
    box(-9.5, -7.5, -6.5, -4.5, PILLAR_H),
    box(6.5, 4.5, 9.5, 7.5, PILLAR_H),
    box(8, -12, 12, -8, PILLAR_H),
    box(-14, 8, -10, 12, PILLAR_H),
    box(-1, -6, 1, 6, PILLAR_H + 0.5),  // 중앙 분리벽
    box(-16, -2, -12, 2, PILLAR_H),
    box(12, -2, 16, 2, PILLAR_H)
  ],
  spawns: [
    { x: -18, y: 0, z: -18 },
    { x: 18, y: 0, z: 18 },
    { x: 18, y: 0, z: -18 },
    { x: -18, y: 0, z: 18 },
    { x: 0, y: 0, z: -20 },
    { x: 0, y: 0, z: 20 },
    { x: -20, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
    { x: 7, y: 0, z: -2 },
    { x: -7, y: 0, z: 2 }
  ]
};

module.exports = MAP;
