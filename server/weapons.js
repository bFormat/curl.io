/* server/weapons.js — 무기/스킬 정의 테이블 (데이터 주도, v0.2).
 * 주무기 5종 + 보조 3종 + 스킬 3종. 밸런스는 여기서만 수정.
 * cooldown/ttl/fuse 단위는 ms. */
'use strict';

// ── 주무기 5종 (좌클릭) ──
const PRIMARY = {
  disc: {
    name: '원판', ptype: 'disc', trajectory: 'straight',
    speed: 42, radius: 0.4, damage: 25, knockback: 5,
    cooldown: 500, ttl: 2500, bounces: 0
  },
  ironball: {
    name: '쇠구슬', ptype: 'ironball', trajectory: 'straight',
    speed: 70, radius: 0.12, damage: 55, knockback: 3,
    cooldown: 1100, ttl: 3000, bounces: 0
  },
  pencil: {
    name: '연필', ptype: 'pencil', trajectory: 'straight',
    speed: 60, radius: 0.08, damage: 12, knockback: 1,
    cooldown: 180, ttl: 2000, bounces: 0
  },
  bow: {
    name: '활', ptype: 'arrow', trajectory: 'arc',
    speed: 25, radius: 0.15, damage: 20, knockback: 8,
    cooldown: 400, ttl: 4000, bounces: 0,
    charge: { minHold: 200, maxHold: 1200, minDmg: 20, maxDmg: 80, minSpeed: 25, maxSpeed: 55 }
  },
  eraser: {
    name: '지우개', ptype: 'eraser', trajectory: 'straight',
    speed: 16, radius: 0.3, damage: 30, knockback: 10,
    cooldown: 1400, ttl: 3500, bounces: 0,
    grow: { startRadius: 0.3, maxRadius: 1.0, growTime: 1500, minDmg: 30, maxDmg: 100 }
  }
};

// ── 보조무기 3종 (우클릭) ──
const SECONDARY = {
  pushball: {
    name: '큰 공', kind: 'projectile', ptype: 'pushball', trajectory: 'straight',
    speed: 20, radius: 0.8, damage: 5, knockback: 24,
    cooldown: 1600, ttl: 3000, bounces: 1
  },
  stickybomb: {
    name: '점착폭탄', kind: 'projectile', ptype: 'stickybomb', trajectory: 'arc',
    speed: 26, radius: 0.28, damage: 0, knockback: 0,
    cooldown: 4000, ttl: 6000, bounces: 0,
    sticky: { fuse: 3000, explodeRadius: 4, explodeDamage: 40, explodeKnockback: 20 }
  },
  jumppack: {
    name: '점프팩', kind: 'instant',
    cooldown: 5000,
    jump: { impulse: 12, damageRadius: 3.5, damage: 18, knockback: 12 }
  }
};

// ── 스킬 3종 (v0.1 유지) ──
const SKILLS = {
  repulse: { name: 'Repulse Nova', cooldown: 30000, radius: 6, damage: 15, knockback: 20 },
  bearing: { name: 'Sniper Bearings', cooldown: 15000, charges: 2 },
  dash: { name: 'Dash', cooldown: 25000, impulse: 16 }
};

// bearing 스킬이 발사하는 투사체 (주무기 ironball과 별개 — 거의 히트스캔)
const BEARING_PROJ = {
  ptype: 'bearing', trajectory: 'straight',
  speed: 90, radius: 0.1, damage: 55, knockback: 3, cooldown: 450, ttl: 2000, bounces: 0
};

const SPIN_RATE = { disc: 14, ironball: 20, pencil: 30, arrow: 0, eraser: 4, pushball: 3, stickybomb: 6, bearing: 26 };

// 클라가 보낸 로드아웃 검증
function sanitizeLoadout(l) {
  l = l || {};
  const primary = PRIMARY[l.primary] ? l.primary : 'disc';
  const secondary = SECONDARY[l.secondary] ? l.secondary : 'pushball';
  let skills = Array.isArray(l.skills) ? [...new Set(l.skills.filter((s) => SKILLS[s]))] : [];
  if (skills.length !== 2) skills = ['repulse', 'dash'];
  return { primary, secondary, skills };
}

module.exports = { PRIMARY, SECONDARY, SKILLS, BEARING_PROJ, SPIN_RATE, sanitizeLoadout };
