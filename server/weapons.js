/* server/weapons.js — 무기/스킬 정의 테이블 (데이터 주도).
 * 밸런스는 여기 한 곳에서만 고친다. 클라에는 WELCOME으로 전송된다. */
'use strict';

const WEAPONS = {
  // 주무기 — 기본 원판
  disc: {
    speed: 45, radius: 0.25, damage: 25, knockback: 4,
    cooldown: 450, ttl: 2500
  },
  // 보조 — 큰 공 (밀어내기)
  pushball: {
    speed: 22, radius: 0.7, damage: 8, knockback: 18,
    cooldown: 1600, ttl: 3000
  },
  // 스킬 투사체 — 저격 쇠구슬
  bearing: {
    speed: 90, radius: 0.1, damage: 55, knockback: 3,
    cooldown: 450, ttl: 2000
  }
};

const SKILLS = {
  // A. 주변 약뎀 + 방사형 밀어내기
  repulse: {
    name: 'Repulse Nova', cooldown: 30000,
    radius: 6, damage: 15, knockback: 20
  },
  // B. 저격 쇠구슬 2발 장전
  bearing: {
    name: 'Sniper Bearings', cooldown: 15000, charges: 2
  },
  // C. 전방 돌진
  dash: {
    name: 'Dash', cooldown: 25000, impulse: 16
  }
};

const SKILL_IDS = Object.keys(SKILLS);

// 클라 검증된 로드아웃 생성
function sanitizeLoadout(skills) {
  let chosen = Array.isArray(skills)
    ? skills.filter((s) => SKILLS[s])
    : [];
  // 중복 제거
  chosen = [...new Set(chosen)];
  if (chosen.length !== 2) chosen = ['repulse', 'dash'];
  return {
    primary: 'disc',
    secondary: 'pushball',
    skills: chosen
  };
}

module.exports = { WEAPONS, SKILLS, SKILL_IDS, sanitizeLoadout };
