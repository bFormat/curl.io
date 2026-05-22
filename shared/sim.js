/*
 * shared/sim.js — 서버/클라가 함께 쓰는 결정론적 이동 시뮬레이션.
 * 클라 예측과 서버 권위가 정확히 같은 코드를 돌려야 reconciliation이 맞는다.
 * UMD 패턴: node는 require, 브라우저는 window.Sim.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C = {
    MOVE_SPEED: 7,        // m/s 목표 수평 속도
    GROUND_ACCEL: 16,     // 지면 가감속 (1/s)
    AIR_ACCEL: 4,         // 공중 제어
    GRAVITY: 22,          // m/s^2
    JUMP_SPEED: 8,        // m/s
    PLAYER_RADIUS: 0.4,   // 수평 충돌 반경
    PLAYER_HEIGHT: 1.7,
    EYE_HEIGHT: 1.5,
    TICK_HZ: 30,
    MAX_DT: 0.05
  };

  function dirFromYawPitch(yaw, pitch) {
    var cp = Math.cos(pitch);
    return {
      x: -Math.sin(yaw) * cp,
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * cp
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 플레이어(수평 원) vs 맵 장애물(풀하이트 AABB) 충돌 해소 + 지면 클램프.
  function collide(p, map) {
    var r = C.PLAYER_RADIUS;
    var boxes = map.obstacles;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var cx = clamp(p.pos.x, b.min.x, b.max.x);
      var cz = clamp(p.pos.z, b.min.z, b.max.z);
      var dx = p.pos.x - cx, dz = p.pos.z - cz;
      var d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        var d = Math.sqrt(d2);
        var nx = dx / d, nz = dz / d;
        var push = r - d;
        p.pos.x += nx * push;
        p.pos.z += nz * push;
        var vn = p.vel.x * nx + p.vel.z * nz;
        if (vn < 0) { p.vel.x -= vn * nx; p.vel.z -= vn * nz; }
      } else {
        // 중심이 박스 내부 — 최근접 면으로 밀어냄
        var dl = p.pos.x - b.min.x, dr = b.max.x - p.pos.x;
        var dn = p.pos.z - b.min.z, df = b.max.z - p.pos.z;
        var m = Math.min(dl, dr, dn, df);
        if (m === dl) { p.pos.x = b.min.x - r; p.vel.x = Math.min(0, p.vel.x); }
        else if (m === dr) { p.pos.x = b.max.x + r; p.vel.x = Math.max(0, p.vel.x); }
        else if (m === dn) { p.pos.z = b.min.z - r; p.vel.z = Math.min(0, p.vel.z); }
        else { p.pos.z = b.max.z + r; p.vel.z = Math.max(0, p.vel.z); }
      }
    }
    if (p.pos.y < 0) { p.pos.y = 0; if (p.vel.y < 0) p.vel.y = 0; }
  }

  // 한 입력을 한 스텝 적용. player는 {pos,vel,yaw,pitch}를 가진 가변 객체.
  // input: {move:{f,b,l,r}, jump, yaw, pitch}
  function step(player, input, dt, map) {
    if (dt > C.MAX_DT) dt = C.MAX_DT;
    if (dt < 0.0001) dt = 0.0001;

    if (typeof input.yaw === 'number') player.yaw = input.yaw;
    if (typeof input.pitch === 'number') player.pitch = input.pitch;

    var grounded = player.pos.y <= 0.001;

    // 점프
    if (input.jump && grounded) {
      player.vel.y = C.JUMP_SPEED;
      grounded = false;
    }
    // 중력
    player.vel.y -= C.GRAVITY * dt;

    // 입력 → 목표 수평 속도 (yaw 기준)
    var mv = input.move || {};
    var f = (mv.f ? 1 : 0) - (mv.b ? 1 : 0);
    var s = (mv.r ? 1 : 0) - (mv.l ? 1 : 0);
    var fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw); // forward
    var rx = -fz, rz = fx;                                       // right
    var dx = fx * f + rx * s;
    var dz = fz * f + rz * s;
    var len = Math.sqrt(dx * dx + dz * dz);
    var desX = 0, desZ = 0;
    if (len > 1e-6) {
      desX = (dx / len) * C.MOVE_SPEED;
      desZ = (dz / len) * C.MOVE_SPEED;
    }
    // 목표 속도로 블렌딩 — 넉백/대시 임펄스는 이 블렌딩으로 자연 감쇠
    var accel = grounded ? C.GROUND_ACCEL : C.AIR_ACCEL;
    var k = accel * dt;
    if (k > 1) k = 1;
    player.vel.x += (desX - player.vel.x) * k;
    player.vel.z += (desZ - player.vel.z) * k;

    // 적분
    player.pos.x += player.vel.x * dt;
    player.pos.y += player.vel.y * dt;
    player.pos.z += player.vel.z * dt;

    collide(player, map);
    return player;
  }

  return { C: C, step: step, dirFromYawPitch: dirFromYawPitch, clamp: clamp };
});
