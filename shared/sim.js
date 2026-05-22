/*
 * shared/sim.js — 서버/클라가 함께 쓰는 결정론적 이동 시뮬레이션.
 * 클라 예측과 서버 권위가 정확히 같은 코드를 돌려야 reconciliation이 맞는다.
 * UMD 패턴: node는 require, 브라우저는 window.Sim.
 * v0.2: 멀티레벨 충돌 — 계단 오르기(step-up) / 지지면(박스 위 서기) / 머리 부딪힘.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C = {
    MOVE_SPEED: 7,
    GROUND_ACCEL: 16,
    AIR_ACCEL: 4,
    GRAVITY: 22,
    JUMP_SPEED: 8,
    PLAYER_RADIUS: 0.4,
    PLAYER_HEIGHT: 1.7,
    EYE_HEIGHT: 1.5,
    STEP_UP: 0.55,        // 자동으로 올라설 수 있는 최대 단차 (계단/턱)
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

  // 플레이어(수평 원기둥) vs 맵 박스 충돌 — 벽 밀어내기 / 지지면 / 머리 부딪힘.
  function collide(p, map) {
    var r = C.PLAYER_RADIUS, h = C.PLAYER_HEIGHT, step = C.STEP_UP;
    var boxes = map.obstacles;
    var i, b, cx, cz, dx, dz;

    // 1. 수평 충돌 (벽) — 올라설 수 있는 단차/천장은 제외
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      var pFeet = p.pos.y, pHead = p.pos.y + h;
      if (pHead <= b.min.y || pFeet >= b.max.y) continue;   // 수직 비겹침
      if (b.max.y <= pFeet + step) continue;                // 올라설 단차 → 안 막음
      if (b.min.y > pFeet + 0.6) continue;                  // 천장 → 머리만
      cx = clamp(p.pos.x, b.min.x, b.max.x);
      cz = clamp(p.pos.z, b.min.z, b.max.z);
      dx = p.pos.x - cx; dz = p.pos.z - cz;
      var d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        var d = Math.sqrt(d2), nx = dx / d, nz = dz / d, push = r - d;
        p.pos.x += nx * push;
        p.pos.z += nz * push;
        var vn = p.vel.x * nx + p.vel.z * nz;
        if (vn < 0) { p.vel.x -= vn * nx; p.vel.z -= vn * nz; }
      } else {
        var dl = p.pos.x - b.min.x, dr = b.max.x - p.pos.x;
        var dn = p.pos.z - b.min.z, df = b.max.z - p.pos.z;
        var m = Math.min(dl, dr, dn, df);
        if (m === dl) { p.pos.x = b.min.x - r; if (p.vel.x > 0) p.vel.x = 0; }
        else if (m === dr) { p.pos.x = b.max.x + r; if (p.vel.x < 0) p.vel.x = 0; }
        else if (m === dn) { p.pos.z = b.min.z - r; if (p.vel.z > 0) p.vel.z = 0; }
        else { p.pos.z = b.max.z + r; if (p.vel.z < 0) p.vel.z = 0; }
      }
    }

    // 2. 지지면 — 발밑(발+STEP 이내) 박스 윗면 중 가장 높은 곳
    var support = 0;
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      if (b.max.y > p.pos.y + step) continue;     // 너무 높음 → 못 올라섬
      if (b.max.y <= support) continue;
      cx = clamp(p.pos.x, b.min.x, b.max.x);
      cz = clamp(p.pos.z, b.min.z, b.max.z);
      dx = p.pos.x - cx; dz = p.pos.z - cz;
      if (dx * dx + dz * dz < r * r) support = b.max.y;
    }
    p.grounded = false;
    if (p.pos.y <= support + 0.02 && p.vel.y <= 0.001) {
      p.pos.y = support;
      p.vel.y = 0;
      p.grounded = true;
    }

    // 3. 머리 부딪힘 (천장)
    if (p.vel.y > 0) {
      for (i = 0; i < boxes.length; i++) {
        b = boxes[i];
        if (b.min.y <= p.pos.y || b.min.y >= p.pos.y + h) continue;
        cx = clamp(p.pos.x, b.min.x, b.max.x);
        cz = clamp(p.pos.z, b.min.z, b.max.z);
        dx = p.pos.x - cx; dz = p.pos.z - cz;
        if (dx * dx + dz * dz >= r * r) continue;
        p.pos.y = b.min.y - h;
        p.vel.y = 0;
        break;
      }
    }

    if (p.pos.y < 0) {
      p.pos.y = 0;
      if (p.vel.y < 0) p.vel.y = 0;
      p.grounded = true;
    }
  }

  // 한 입력을 한 스텝 적용. player = {pos,vel,yaw,pitch,grounded}.
  function step(player, input, dt, map) {
    if (dt > C.MAX_DT) dt = C.MAX_DT;
    if (dt < 0.0001) dt = 0.0001;

    if (typeof input.yaw === 'number') player.yaw = input.yaw;
    if (typeof input.pitch === 'number') player.pitch = input.pitch;

    var grounded = !!player.grounded;   // 직전 틱 collide 결과

    if (input.jump && grounded) {
      player.vel.y = C.JUMP_SPEED;
      grounded = false;
    }
    player.vel.y -= C.GRAVITY * dt;

    var mv = input.move || {};
    var f = (mv.f ? 1 : 0) - (mv.b ? 1 : 0);
    var s = (mv.r ? 1 : 0) - (mv.l ? 1 : 0);
    var fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    var rx = -fz, rz = fx;
    var dx = fx * f + rx * s;
    var dz = fz * f + rz * s;
    var len = Math.sqrt(dx * dx + dz * dz);
    var desX = 0, desZ = 0;
    if (len > 1e-6) {
      desX = (dx / len) * C.MOVE_SPEED;
      desZ = (dz / len) * C.MOVE_SPEED;
    }
    var accel = grounded ? C.GROUND_ACCEL : C.AIR_ACCEL;
    var k = accel * dt;
    if (k > 1) k = 1;
    player.vel.x += (desX - player.vel.x) * k;
    player.vel.z += (desZ - player.vel.z) * k;

    player.pos.x += player.vel.x * dt;
    player.pos.y += player.vel.y * dt;
    player.pos.z += player.vel.z * dt;

    collide(player, map);
    return player;
  }

  return { C: C, step: step, dirFromYawPitch: dirFromYawPitch, clamp: clamp };
});
