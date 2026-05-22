/* server/physics.js — 투사체 충돌 수학.
 * 빠른 투사체는 CCD: 이전→현재 위치 선분 vs 구/AABB. */
'use strict';

// 선분 p0→p1 (반경 R 구) vs 점 center(반경 0). 충돌 시 0..1 t, 아니면 -1.
// 실제로는 "이동하는 반경 R 구 vs 정지한 반경 cr 구" → R := R + cr 로 호출.
function segmentSphere(p0, p1, center, R) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const mx = p0.x - center.x, my = p0.y - center.y, mz = p0.z - center.z;
  const a = dx * dx + dy * dy + dz * dz;
  const c = mx * mx + my * my + mz * mz - R * R;
  if (c <= 0) return 0; // 시작부터 겹침
  if (a < 1e-9) return -1; // 이동 없음, 시작 시 분리
  const b = mx * dx + my * dy + mz * dz;
  if (b > 0) return -1; // 멀어지는 중
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > 1) return -1;
  return t;
}

// 선분 p0→p1 vs AABB (반경 R). 충돌 시 {t, normal}, 아니면 null.
// 슬랩 테스트(박스를 R만큼 확장)는 모서리에서 과대판정하므로,
// 진입점에서 원본 박스까지 실제 거리를 검사해 모서리 오탐을 제거한다.
function segmentAABB(p0, p1, box, R) {
  let tmin = 0, tmax = 1, axis = -1, axisSign = 0;
  const axes = ['x', 'y', 'z'];
  for (let k = 0; k < 3; k++) {
    const ax = axes[k];
    const lo = box.min[ax] - R, hi = box.max[ax] + R;
    const o = p0[ax], d = p1[ax] - p0[ax];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      const entrySign = d > 0 ? -1 : 1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; axis = k; axisSign = entrySign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  // 진입점에서 원본 박스까지 실제 거리 검사 (모서리 둥글림)
  const cx = p0.x + (p1.x - p0.x) * tmin;
  const cy = p0.y + (p1.y - p0.y) * tmin;
  const cz = p0.z + (p1.z - p0.z) * tmin;
  const qx = Math.max(box.min.x, Math.min(cx, box.max.x));
  const qy = Math.max(box.min.y, Math.min(cy, box.max.y));
  const qz = Math.max(box.min.z, Math.min(cz, box.max.z));
  const dx = cx - qx, dy = cy - qy, dz = cz - qz;
  if (dx * dx + dy * dy + dz * dz > (R * 1.06) * (R * 1.06)) return null;

  const normal = { x: 0, y: 0, z: 0 };
  if (axis >= 0) normal[axes[axis]] = axisSign;
  return { t: tmin, normal };
}

// 점이 AABB 내부(반경 R 확장)인지
function pointInAABB(p, box, R) {
  return p.x >= box.min.x - R && p.x <= box.max.x + R &&
         p.y >= box.min.y - R && p.y <= box.max.y + R &&
         p.z >= box.min.z - R && p.z <= box.max.z + R;
}

module.exports = { segmentSphere, segmentAABB, pointInAABB };
