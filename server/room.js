/* server/room.js — 한 게임 룸의 상태머신 + 권위 시뮬레이션 루프(30Hz).
 * FFA, 최대 10인, 무한 진행, 사망 3초 후 리스폰. */
'use strict';

const Sim = require('../shared/sim');
const { pickMap } = require('./map');
const { WEAPONS, SKILLS, sanitizeLoadout } = require('./weapons');
const physics = require('./physics');
const { S2C, encode } = require('./protocol');

const TICK_MS = 1000 / Sim.C.TICK_HZ;
const MAX_PLAYERS = 10;
const RESPAWN_MS = 3000;
const PLAYER_HIT_R = 0.7;        // 피격 구 반경
const PLAYER_HIT_YOFF = 0.85;    // 피격 구 중심 높이
const SELF_IGNORE_MS = 100;      // 발사 후 자기 피격 무시
const SPIN_RATE = { disc: 14, pushball: 3, bearing: 26 };
const INPUT_DT_BUDGET = (TICK_MS / 1000) * 1.5;  // 안티치트: 틱당 소비 dt 상한
const BOUNCE_DAMP = 0.86;        // 바운스 시 속도 감쇠

let roomSeq = 0;

function rand(a, b) { return a + Math.random() * (b - a); }
function len2(x, z) { return Math.sqrt(x * x + z * z); }
function finite(n) { return typeof n === 'number' && isFinite(n); }

class Room {
  constructor(onEmpty) {
    this.id = 'room-' + (++roomSeq);
    this.map = pickMap();
    this.players = new Map();
    this.projectiles = [];
    this.events = [];
    this.status = 'open';
    this.projSeq = 0;
    this.tickCount = 0;
    this.onEmpty = onEmpty;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  get size() { return this.players.size; }
  get isJoinable() { return this.status === 'open' && this.size < MAX_PLAYERS; }

  pickSpawn() {
    // 다른 플레이어와 가장 먼 스폰 선호
    let best = this.map.spawns[0], bestD = -1;
    for (const sp of this.map.spawns) {
      let minD = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = len2(p.pos.x - sp.x, p.pos.z - sp.z);
        if (d < minD) minD = d;
      }
      if (minD > bestD) { bestD = minD; best = sp; }
    }
    return best;
  }

  addPlayer(id, name, ws, skills) {
    const sp = this.pickSpawn();
    const player = {
      id, name, ws,
      pos: { x: sp.x, y: 0, z: sp.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0,
      hp: 100, alive: true, respawnAt: null,
      score: 0, kills: 0, deaths: 0,
      loadout: sanitizeLoadout(skills),
      cooldowns: {},
      fireReady: { primary: 0, secondary: 0 },
      buffs: {},
      lastInputSeq: 0,
      inputQueue: [], fireQueue: [], skillQueue: []
    };
    this.players.set(id, player);
    if (this.size >= MAX_PLAYERS) this.status = 'full';
    this.send(player, {
      type: S2C.WELCOME,
      selfId: id,
      map: this.map,
      tickRate: Sim.C.TICK_HZ,
      loadout: player.loadout,
      weapons: WEAPONS,
      skills: SKILLS,
      sim: Sim.C
    });
    this.events.push({ kind: 'spawn', id, name });
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.projectiles = this.projectiles.filter((p) => p.ownerId !== id);
    if (this.status === 'full' && this.size < MAX_PLAYERS) this.status = 'open';
    if (this.size === 0) {
      clearInterval(this.timer);
      if (this.onEmpty) this.onEmpty(this);
    }
  }

  send(player, obj) {
    if (player.ws && player.ws.readyState === 1) {
      player.ws.send(encode(obj));
    }
  }

  // ── 메시지 수신 ──────────────────────────────────────────────
  handleInput(player, msg) {
    // 안티치트: 형식 검증 후 큐 적재 (큐 길이 상한)
    if (!finite(msg.seq) || !finite(msg.yaw) || !finite(msg.pitch)) return;
    if (player.inputQueue.length < 64) player.inputQueue.push(msg);
  }

  handleFire(player, msg) {
    if (!player.alive) return;
    if (msg.slot !== 'primary' && msg.slot !== 'secondary') return;
    if (player.fireQueue.length < 16) player.fireQueue.push(msg);
  }

  handleSkill(player, msg) {
    if (!player.alive) return;
    if (msg.slot !== 0 && msg.slot !== 1) return;
    if (player.skillQueue.length < 8) player.skillQueue.push(msg);
  }

  // ── 시뮬레이션 틱 ────────────────────────────────────────────
  tick() {
    const now = Date.now();
    const dt = TICK_MS / 1000;

    this.applyInputs(dt);
    this.applyFire(now);
    this.applySkills(now);
    this.integrateProjectiles(dt);
    this.resolveCollisions(now);
    this.handleRespawns(now);
    this.cleanupBuffs();

    this.tickCount++;
    this.broadcast(now);
  }

  applyInputs(dt) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.inputQueue.length = 0; continue; }
      const fresh = p.inputQueue
        .filter((i) => i.seq > p.lastInputSeq)
        .sort((a, b) => a.seq - b.seq);
      // 안티치트: 틱당 소비 dt 예산(~1.5x) 제한 → 이동 속도 상한. 초과분은 다음 틱으로.
      let used = 0, taken = 0;
      for (const inp of fresh) {
        const idt = finite(inp.dt) && inp.dt > 0 ? Math.min(inp.dt, Sim.C.MAX_DT) : dt;
        if (taken > 0 && used + idt > INPUT_DT_BUDGET) break;
        Sim.step(p, inp, idt, this.map);
        p.lastInputSeq = inp.seq;
        used += idt;
        taken++;
      }
      p.inputQueue = fresh.slice(taken).slice(0, 64);
      if (taken === 0) {
        // 입력 없어도 중력/넉백 진행
        Sim.step(p, { move: {}, jump: false, yaw: p.yaw, pitch: p.pitch }, dt, this.map);
      }
    }
  }

  spawnProjectile(owner, type, yaw, pitch) {
    const w = WEAPONS[type];
    const dir = Sim.dirFromYawPitch(yaw, pitch);
    const now = Date.now();
    const id = this.id + '-p' + (++this.projSeq);
    this.projectiles.push({
      id, ownerId: owner.id, type,
      pos: {
        x: owner.pos.x + dir.x * 0.6,
        y: owner.pos.y + Sim.C.EYE_HEIGHT + dir.y * 0.6,
        z: owner.pos.z + dir.z * 0.6
      },
      vel: { x: dir.x * w.speed, y: dir.y * w.speed, z: dir.z * w.speed },
      radius: w.radius, damage: w.damage, knockback: w.knockback,
      spawnAt: now, ttl: w.ttl, spin: SPIN_RATE[type] || 8,
      bounces: w.bounces || 0,
      ignoreOwnerUntil: now + SELF_IGNORE_MS
    });
  }

  applyFire(now) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.fireQueue.length = 0; continue; }
      for (const f of p.fireQueue) {
        const yaw = finite(f.yaw) ? f.yaw : p.yaw;
        const pitch = finite(f.pitch) ? f.pitch : p.pitch;
        if (f.slot === 'primary') {
          if (now < p.fireReady.primary) continue;
          const useBearing = p.buffs.sniperBearings && p.buffs.sniperBearings.charges > 0;
          const type = useBearing ? 'bearing' : 'disc';
          this.spawnProjectile(p, type, yaw, pitch);
          p.fireReady.primary = now + WEAPONS[type].cooldown;
          if (useBearing) {
            p.buffs.sniperBearings.charges--;
            if (p.buffs.sniperBearings.charges <= 0) delete p.buffs.sniperBearings;
          }
        } else {
          if (now < p.fireReady.secondary) continue;
          this.spawnProjectile(p, 'pushball', yaw, pitch);
          p.fireReady.secondary = now + WEAPONS.pushball.cooldown;
        }
      }
      p.fireQueue.length = 0;
    }
  }

  applySkills(now) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.skillQueue.length = 0; continue; }
      for (const s of p.skillQueue) {
        const skillId = p.loadout.skills[s.slot];
        if (!skillId || !SKILLS[skillId]) continue;
        const readyAt = p.cooldowns[skillId] || 0;
        if (now < readyAt) continue;
        this.castSkill(p, skillId, now);
        p.cooldowns[skillId] = now + SKILLS[skillId].cooldown;
      }
      p.skillQueue.length = 0;
    }
  }

  castSkill(p, skillId, now) {
    const def = SKILLS[skillId];
    if (skillId === 'repulse') {
      for (const other of this.players.values()) {
        if (other === p || !other.alive) continue;
        const dx = other.pos.x - p.pos.x, dz = other.pos.z - p.pos.z;
        const d = len2(dx, dz);
        if (d > def.radius) continue;
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        other.vel.x += nx * def.knockback;
        other.vel.z += nz * def.knockback;
        other.vel.y += def.knockback * 0.25;
        this.damage(other, p, def.damage,
          { x: other.pos.x, y: other.pos.y + 1, z: other.pos.z }, now);
      }
      this.events.push({ kind: 'skill', skill: 'repulse', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    } else if (skillId === 'dash') {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      p.vel.x += fx * def.impulse;
      p.vel.z += fz * def.impulse;
      this.events.push({ kind: 'skill', skill: 'dash', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    } else if (skillId === 'bearing') {
      p.buffs.sniperBearings = { charges: def.charges };
      this.events.push({ kind: 'skill', skill: 'bearing', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
  }

  integrateProjectiles(dt) {
    const live = [];
    for (const pr of this.projectiles) {
      pr.prev = { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z };
      pr.pos.x += pr.vel.x * dt;
      pr.pos.y += pr.vel.y * dt;
      pr.pos.z += pr.vel.z * dt;
      pr.ttl -= dt * 1000;
      if (pr.ttl > 0) live.push(pr);
    }
    this.projectiles = live;
  }

  resolveCollisions(now) {
    const survivors = [];
    for (const pr of this.projectiles) {
      let hitT = Infinity, hitPlayer = null;

      // vs 플레이어 (CCD 선분-구)
      for (const target of this.players.values()) {
        if (!target.alive) continue;
        if (target.id === pr.ownerId && now < pr.ignoreOwnerUntil) continue;
        const center = {
          x: target.pos.x,
          y: target.pos.y + PLAYER_HIT_YOFF,
          z: target.pos.z
        };
        const t = physics.segmentSphere(pr.prev, pr.pos, center, pr.radius + PLAYER_HIT_R);
        if (t >= 0 && t < hitT) { hitT = t; hitPlayer = target; }
      }

      // vs 맵 장애물 (법선 포함)
      let wallT = Infinity, wallN = null;
      for (const box of this.map.obstacles) {
        const r = physics.segmentAABB(pr.prev, pr.pos, box, pr.radius);
        if (r && r.t >= 0 && r.t < wallT) { wallT = r.t; wallN = r.normal; }
      }
      // vs 지면
      if (pr.prev.y > pr.radius && pr.pos.y <= pr.radius) {
        const gt = (pr.prev.y - pr.radius) / (pr.prev.y - pr.pos.y);
        if (gt < wallT) { wallT = gt; wallN = { x: 0, y: 1, z: 0 }; }
      }

      if (hitPlayer && hitT <= wallT) {
        const owner = this.players.get(pr.ownerId);
        const hp = {
          x: pr.prev.x + (pr.pos.x - pr.prev.x) * hitT,
          y: pr.prev.y + (pr.pos.y - pr.prev.y) * hitT,
          z: pr.prev.z + (pr.pos.z - pr.prev.z) * hitT
        };
        const speed = Math.sqrt(pr.vel.x ** 2 + pr.vel.y ** 2 + pr.vel.z ** 2) || 1;
        hitPlayer.vel.x += (pr.vel.x / speed) * pr.knockback;
        hitPlayer.vel.z += (pr.vel.z / speed) * pr.knockback;
        hitPlayer.vel.y += pr.knockback * 0.18;
        this.damage(hitPlayer, owner || null, pr.damage, hp, now);
        // 투사체 소멸
      } else if (wallT !== Infinity && wallN) {
        const hp = {
          x: pr.prev.x + (pr.pos.x - pr.prev.x) * wallT,
          y: pr.prev.y + (pr.pos.y - pr.prev.y) * wallT,
          z: pr.prev.z + (pr.pos.z - pr.prev.z) * wallT
        };
        if (pr.bounces > 0) {
          // 바운스: 법선 기준 반사 + 감쇠
          pr.bounces--;
          const vn = pr.vel.x * wallN.x + pr.vel.y * wallN.y + pr.vel.z * wallN.z;
          pr.vel.x = (pr.vel.x - 2 * vn * wallN.x) * BOUNCE_DAMP;
          pr.vel.y = (pr.vel.y - 2 * vn * wallN.y) * BOUNCE_DAMP;
          pr.vel.z = (pr.vel.z - 2 * vn * wallN.z) * BOUNCE_DAMP;
          const off = pr.radius + 0.06;
          pr.pos.x = hp.x + wallN.x * off;
          pr.pos.y = hp.y + wallN.y * off;
          pr.pos.z = hp.z + wallN.z * off;
          this.events.push({ kind: 'bounce', ptype: pr.type, x: pr.pos.x, y: pr.pos.y, z: pr.pos.z });
          survivors.push(pr);
        } else {
          this.events.push({ kind: 'pop', ptype: pr.type, x: hp.x, y: hp.y, z: hp.z });
        }
      } else {
        survivors.push(pr);
      }
    }
    this.projectiles = survivors;
  }

  damage(victim, attacker, amount, pos, now) {
    if (!victim.alive) return;
    victim.hp -= amount;
    this.events.push({
      kind: 'hit', victimId: victim.id,
      attackerId: attacker ? attacker.id : null,
      x: pos.x, y: pos.y, z: pos.z, damage: amount
    });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = now + RESPAWN_MS;
      victim.inputQueue.length = 0;
      victim.fireQueue.length = 0;
      victim.skillQueue.length = 0;
      victim.buffs = {};
      if (attacker && attacker !== victim && attacker.alive !== undefined) {
        attacker.score++;
        attacker.kills++;
      }
      this.events.push({
        kind: 'kill',
        victimId: victim.id, victimName: victim.name,
        killerId: attacker && attacker !== victim ? attacker.id : null,
        killerName: attacker && attacker !== victim ? attacker.name : null,
        x: victim.pos.x, y: victim.pos.y, z: victim.pos.z
      });
    }
  }

  handleRespawns(now) {
    for (const p of this.players.values()) {
      if (p.alive || p.respawnAt == null || now < p.respawnAt) continue;
      const sp = this.pickSpawn();
      p.pos = { x: sp.x, y: 0, z: sp.z };
      p.vel = { x: 0, y: 0, z: 0 };
      p.hp = 100;
      p.alive = true;
      p.respawnAt = null;
      p.cooldowns = {};
      p.fireReady = { primary: 0, secondary: 0 };
      this.events.push({ kind: 'spawn', id: p.id, name: p.name });
    }
  }

  cleanupBuffs() {
    for (const p of this.players.values()) {
      if (p.buffs.sniperBearings && p.buffs.sniperBearings.charges <= 0) {
        delete p.buffs.sniperBearings;
      }
    }
  }

  broadcast(now) {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, name: p.name,
        x: p.pos.x, y: p.pos.y, z: p.pos.z,
        vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
        yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, alive: p.alive, score: p.score,
        kills: p.kills, deaths: p.deaths
      });
    }
    const projectiles = this.projectiles.map((pr) => ({
      id: pr.id, type: pr.type,
      x: pr.pos.x, y: pr.pos.y, z: pr.pos.z,
      vx: pr.vel.x, vy: pr.vel.y, vz: pr.vel.z,
      spin: pr.spin
    }));
    const events = this.events;
    this.events = [];

    for (const p of this.players.values()) {
      this.send(p, {
        type: S2C.SNAPSHOT,
        t: now,
        ack: p.lastInputSeq,
        players, projectiles, events,
        you: {
          hp: p.hp, alive: p.alive, respawnAt: p.respawnAt,
          score: p.score, kills: p.kills, deaths: p.deaths,
          cd: p.cooldowns, fire: p.fireReady,
          bearings: p.buffs.sniperBearings ? p.buffs.sniperBearings.charges : 0,
          skills: p.loadout.skills
        }
      });
    }
  }
}

module.exports = { Room, MAX_PLAYERS };
