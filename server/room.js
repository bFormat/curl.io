/* server/room.js — 한 게임 룸의 상태머신 + 권위 시뮬레이션 루프(30Hz). v0.2.
 * FFA, 최대 10인, 무한 진행, 사망 3초 후 리스폰(리스폰 시 로드아웃 변경 가능). */
'use strict';

const Sim = require('../shared/sim');
const { pickMap } = require('./map');
const { PRIMARY, SECONDARY, SKILLS, BEARING_PROJ, SPIN_RATE, sanitizeLoadout } = require('./weapons');
const physics = require('./physics');
const { S2C, encode } = require('./protocol');

const TICK_MS = 1000 / Sim.C.TICK_HZ;
const MAX_PLAYERS = 10;
const RESPAWN_MS = 3000;
const PLAYER_HIT_R = 0.7;
const PLAYER_HIT_YOFF = 0.85;
const SELF_IGNORE_MS = 100;
const INPUT_DT_BUDGET = (TICK_MS / 1000) * 1.5;  // 안티치트: 틱당 소비 dt 상한
const BOUNCE_DAMP = 0.86;
const PROJ_GRAVITY = 16;          // arc 투사체 중력 (m/s^2)

let roomSeq = 0;

function len2(x, z) { return Math.sqrt(x * x + z * z); }
function finite(n) { return typeof n === 'number' && isFinite(n); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function lerp(a, b, t) { return a + (b - a) * t; }

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

  addPlayer(id, name, ws, loadout) {
    const sp = this.pickSpawn();
    const player = {
      id, name, ws,
      pos: { x: sp.x, y: 0, z: sp.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0,
      hp: 100, alive: true, respawnAt: null,
      score: 0, kills: 0, deaths: 0,
      loadout: sanitizeLoadout(loadout),
      pendingLoadout: null,
      cooldowns: {},
      fireReady: { primary: 0, secondary: 0 },
      charge: null,
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
      primary: PRIMARY,
      secondary: SECONDARY,
      skills: SKILLS,
      bearingProj: BEARING_PROJ,
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
    if (player.ws && player.ws.readyState === 1) player.ws.send(encode(obj));
  }

  // ── 메시지 수신 ──────────────────────────────────────────────
  handleInput(player, msg) {
    if (!finite(msg.seq) || !finite(msg.yaw) || !finite(msg.pitch)) return;
    if (player.inputQueue.length < 64) player.inputQueue.push(msg);
  }

  handleFire(player, phase, msg) {
    if (!player.alive) return;
    if (msg.slot !== 'primary' && msg.slot !== 'secondary') return;
    if (player.fireQueue.length < 24) {
      player.fireQueue.push({ phase, slot: msg.slot, yaw: msg.yaw, pitch: msg.pitch });
    }
  }

  handleSkill(player, msg) {
    if (!player.alive) return;
    if (msg.slot !== 0 && msg.slot !== 1) return;
    if (player.skillQueue.length < 8) player.skillQueue.push(msg);
  }

  handleSetLoadout(player, msg) {
    // 생존 중 변경 불가 — 다음 스폰에 적용
    player.pendingLoadout = sanitizeLoadout(msg);
  }

  // ── 시뮬레이션 틱 ────────────────────────────────────────────
  tick() {
    const now = Date.now();
    const dt = TICK_MS / 1000;
    this.applyInputs(dt);
    this.applyFire(now);
    this.applySkills(now);
    this.integrateProjectiles(dt, now);
    this.resolveCollisions(now);
    this.explodeStickies(now);
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
        Sim.step(p, { move: {}, jump: false, yaw: p.yaw, pitch: p.pitch }, dt, this.map);
      }
    }
  }

  // ── 발사 (FIRE_START / FIRE_RELEASE) ──────────────────────────
  applyFire(now) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.fireQueue.length = 0; p.charge = null; continue; }
      for (const ev of p.fireQueue) {
        const yaw = finite(ev.yaw) ? ev.yaw : p.yaw;
        const pitch = finite(ev.pitch) ? ev.pitch : p.pitch;
        if (ev.slot === 'primary') {
          const bearingActive = p.buffs.sniperBearings && p.buffs.sniperBearings.charges > 0;
          if (ev.phase === 'start') {
            if (bearingActive) {
              this.fireBearing(p, yaw, pitch, now);
            } else {
              const w = PRIMARY[p.loadout.primary];
              if (w.charge) {
                if (now >= p.fireReady.primary && !p.charge) p.charge = { startAt: now };
              } else {
                this.fireWeapon(p, 'primary', w, yaw, pitch, now, null);
              }
            }
          } else if (p.charge) { // release
            const hold = now - p.charge.startAt;
            p.charge = null;
            this.fireWeapon(p, 'primary', PRIMARY.bow, yaw, pitch, now, hold);
          }
        } else if (ev.phase === 'start') { // secondary
          this.fireWeapon(p, 'secondary', SECONDARY[p.loadout.secondary], yaw, pitch, now, null);
        }
      }
      p.fireQueue.length = 0;
    }
  }

  fireWeapon(p, slot, w, yaw, pitch, now, holdMs) {
    if (now < p.fireReady[slot]) return;
    if (w.kind === 'instant') {            // 점프팩
      this.applyJumppack(p, now);
      p.fireReady[slot] = now + w.cooldown;
      return;
    }
    let speed = w.speed, damage = w.damage, radius = w.radius, knockback = w.knockback;
    if (w.charge && holdMs != null) {       // 활 차징
      const c = w.charge;
      const h = clamp01((holdMs - c.minHold) / (c.maxHold - c.minHold));
      damage = lerp(c.minDmg, c.maxDmg, h);
      speed = lerp(c.minSpeed, c.maxSpeed, h);
    }
    this.spawnProjectile(p, w, { yaw, pitch, speed, damage, radius, knockback }, now);
    p.fireReady[slot] = now + w.cooldown;
  }

  fireBearing(p, yaw, pitch, now) {
    if (now < p.fireReady.primary) return;
    this.spawnProjectile(p,
      { ptype: 'bearing', ttl: BEARING_PROJ.ttl, bounces: 0, trajectory: 'straight' },
      { yaw, pitch, speed: BEARING_PROJ.speed, damage: BEARING_PROJ.damage,
        radius: BEARING_PROJ.radius, knockback: BEARING_PROJ.knockback }, now);
    p.fireReady.primary = now + BEARING_PROJ.cooldown;
    p.buffs.sniperBearings.charges--;
    if (p.buffs.sniperBearings.charges <= 0) delete p.buffs.sniperBearings;
  }

  spawnProjectile(owner, w, o, now) {
    const dir = Sim.dirFromYawPitch(o.yaw, o.pitch);
    const id = this.id + '-p' + (++this.projSeq);
    this.projectiles.push({
      id, ownerId: owner.id, ptype: w.ptype,
      pos: {
        x: owner.pos.x + dir.x * 0.6,
        y: owner.pos.y + Sim.C.EYE_HEIGHT + dir.y * 0.6,
        z: owner.pos.z + dir.z * 0.6
      },
      vel: { x: dir.x * o.speed, y: dir.y * o.speed, z: dir.z * o.speed },
      radius: o.radius, damage: o.damage, knockback: o.knockback,
      bornAt: now, ttl: w.ttl, spin: SPIN_RATE[w.ptype] || 8,
      bounces: w.bounces || 0,
      trajectory: w.trajectory || 'straight',
      state: 'flying',
      grow: w.grow || null,
      sticky: w.sticky || null,
      stuckTo: null, stuckOff: null, fuseAt: 0,
      ignoreOwnerUntil: now + SELF_IGNORE_MS
    });
  }

  applyJumppack(p, now) {
    const j = SECONDARY.jumppack.jump;
    p.vel.y += j.impulse;
    for (const other of this.players.values()) {
      if (other === p || !other.alive) continue;
      const dx = other.pos.x - p.pos.x, dz = other.pos.z - p.pos.z;
      const d = len2(dx, dz);
      if (d > j.damageRadius) continue;
      const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
      other.vel.x += nx * j.knockback;
      other.vel.z += nz * j.knockback;
      other.vel.y += j.knockback * 0.3;
      this.damage(other, p, j.damage, { x: other.pos.x, y: other.pos.y + 1, z: other.pos.z }, now);
    }
    this.events.push({ kind: 'jumppack', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  }

  // ── 스킬 ──────────────────────────────────────────────────────
  applySkills(now) {
    for (const p of this.players.values()) {
      if (!p.alive) { p.skillQueue.length = 0; continue; }
      for (const s of p.skillQueue) {
        const skillId = p.loadout.skills[s.slot];
        if (!skillId || !SKILLS[skillId]) continue;
        if (now < (p.cooldowns[skillId] || 0)) continue;
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
        this.damage(other, p, def.damage, { x: other.pos.x, y: other.pos.y + 1, z: other.pos.z }, now);
      }
      this.events.push({ kind: 'skill', skill: 'repulse', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    } else if (skillId === 'dash') {
      p.vel.x += -Math.sin(p.yaw) * def.impulse;
      p.vel.z += -Math.cos(p.yaw) * def.impulse;
      this.events.push({ kind: 'skill', skill: 'dash', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    } else if (skillId === 'bearing') {
      p.buffs.sniperBearings = { charges: def.charges };
      this.events.push({ kind: 'skill', skill: 'bearing', id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
  }

  // ── 투사체 ────────────────────────────────────────────────────
  integrateProjectiles(dt, now) {
    const live = [];
    for (const pr of this.projectiles) {
      pr.prev = { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z };
      if (pr.state === 'stuck') {
        if (pr.stuckTo) {
          const host = this.players.get(pr.stuckTo);
          if (host && host.alive) {
            pr.pos.x = host.pos.x + pr.stuckOff.x;
            pr.pos.y = host.pos.y + pr.stuckOff.y;
            pr.pos.z = host.pos.z + pr.stuckOff.z;
          } else {
            pr.stuckTo = null; // 숙주 사망/이탈 → 그 자리에 고정
          }
        }
        live.push(pr);
        continue;
      }
      if (pr.trajectory === 'arc') pr.vel.y -= PROJ_GRAVITY * dt;
      pr.pos.x += pr.vel.x * dt;
      pr.pos.y += pr.vel.y * dt;
      pr.pos.z += pr.vel.z * dt;
      if (pr.grow) {
        const prog = clamp01((now - pr.bornAt) / pr.grow.growTime);
        pr.radius = lerp(pr.grow.startRadius, pr.grow.maxRadius, prog);
      }
      pr.ttl -= dt * 1000;
      if (pr.ttl > 0) live.push(pr);
    }
    this.projectiles = live;
  }

  resolveCollisions(now) {
    const survivors = [];
    for (const pr of this.projectiles) {
      if (pr.state === 'stuck') { survivors.push(pr); continue; }

      // vs 플레이어 (CCD)
      let hitT = Infinity, hitPlayer = null;
      for (const target of this.players.values()) {
        if (!target.alive) continue;
        if (target.id === pr.ownerId && now < pr.ignoreOwnerUntil) continue;
        const center = { x: target.pos.x, y: target.pos.y + PLAYER_HIT_YOFF, z: target.pos.z };
        const t = physics.segmentSphere(pr.prev, pr.pos, center, pr.radius + PLAYER_HIT_R);
        if (t >= 0 && t < hitT) { hitT = t; hitPlayer = target; }
      }
      // vs 맵
      let wallT = Infinity, wallN = null;
      for (const box of this.map.obstacles) {
        const r = physics.segmentAABB(pr.prev, pr.pos, box, pr.radius);
        if (r && r.t >= 0 && r.t < wallT) { wallT = r.t; wallN = r.normal; }
      }
      if (pr.prev.y > pr.radius && pr.pos.y <= pr.radius) {
        const gt = (pr.prev.y - pr.radius) / (pr.prev.y - pr.pos.y);
        if (gt < wallT) { wallT = gt; wallN = { x: 0, y: 1, z: 0 }; }
      }

      const lerpPt = (t) => ({
        x: pr.prev.x + (pr.pos.x - pr.prev.x) * t,
        y: pr.prev.y + (pr.pos.y - pr.prev.y) * t,
        z: pr.prev.z + (pr.pos.z - pr.prev.z) * t
      });

      if (hitPlayer && hitT <= wallT) {
        const hp = lerpPt(hitT);
        if (pr.sticky) {
          pr.state = 'stuck';
          pr.stuckTo = hitPlayer.id;
          pr.stuckOff = { x: hp.x - hitPlayer.pos.x, y: hp.y - hitPlayer.pos.y, z: hp.z - hitPlayer.pos.z };
          pr.pos = { x: hp.x, y: hp.y, z: hp.z };
          pr.vel = { x: 0, y: 0, z: 0 };
          pr.fuseAt = now + pr.sticky.fuse;
          this.events.push({ kind: 'stick', x: hp.x, y: hp.y, z: hp.z });
          survivors.push(pr);
        } else {
          const owner = this.players.get(pr.ownerId);
          let dmg = pr.damage;
          if (pr.grow) {
            const prog = clamp01((now - pr.bornAt) / pr.grow.growTime);
            dmg = lerp(pr.grow.minDmg, pr.grow.maxDmg, prog);
          }
          const speed = Math.sqrt(pr.vel.x ** 2 + pr.vel.y ** 2 + pr.vel.z ** 2) || 1;
          hitPlayer.vel.x += (pr.vel.x / speed) * pr.knockback;
          hitPlayer.vel.z += (pr.vel.z / speed) * pr.knockback;
          hitPlayer.vel.y += pr.knockback * 0.18;
          this.damage(hitPlayer, owner || null, dmg, hp, now);
        }
      } else if (wallT !== Infinity && wallN) {
        const hp = lerpPt(wallT);
        if (pr.sticky) {
          const off = pr.radius;
          pr.state = 'stuck';
          pr.stuckTo = null;
          pr.pos = { x: hp.x + wallN.x * off, y: hp.y + wallN.y * off, z: hp.z + wallN.z * off };
          pr.vel = { x: 0, y: 0, z: 0 };
          pr.fuseAt = now + pr.sticky.fuse;
          this.events.push({ kind: 'stick', x: pr.pos.x, y: pr.pos.y, z: pr.pos.z });
          survivors.push(pr);
        } else if (pr.bounces > 0) {
          pr.bounces--;
          const vn = pr.vel.x * wallN.x + pr.vel.y * wallN.y + pr.vel.z * wallN.z;
          pr.vel.x = (pr.vel.x - 2 * vn * wallN.x) * BOUNCE_DAMP;
          pr.vel.y = (pr.vel.y - 2 * vn * wallN.y) * BOUNCE_DAMP;
          pr.vel.z = (pr.vel.z - 2 * vn * wallN.z) * BOUNCE_DAMP;
          const off = pr.radius + 0.06;
          pr.pos = { x: hp.x + wallN.x * off, y: hp.y + wallN.y * off, z: hp.z + wallN.z * off };
          this.events.push({ kind: 'bounce', ptype: pr.ptype, x: pr.pos.x, y: pr.pos.y, z: pr.pos.z });
          survivors.push(pr);
        } else {
          this.events.push({ kind: 'pop', ptype: pr.ptype, x: hp.x, y: hp.y, z: hp.z });
        }
      } else {
        survivors.push(pr);
      }
    }
    this.projectiles = survivors;
  }

  explodeStickies(now) {
    const survivors = [];
    for (const pr of this.projectiles) {
      if (pr.state === 'stuck' && now >= pr.fuseAt) {
        const s = pr.sticky;
        const owner = this.players.get(pr.ownerId);
        for (const target of this.players.values()) {
          if (!target.alive) continue;
          const dx = target.pos.x - pr.pos.x, dz = target.pos.z - pr.pos.z;
          const dy = (target.pos.y + 0.9) - pr.pos.y;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > s.explodeRadius) continue;
          const hd = len2(dx, dz) || 1;
          target.vel.x += (dx / hd) * s.explodeKnockback;
          target.vel.z += (dz / hd) * s.explodeKnockback;
          target.vel.y += s.explodeKnockback * 0.3;
          this.damage(target, owner || null, s.explodeDamage,
            { x: target.pos.x, y: target.pos.y + 1, z: target.pos.z }, now);
        }
        this.events.push({ kind: 'explosion', x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, radius: s.explodeRadius });
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
      victim.charge = null;
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
      if (p.pendingLoadout) { p.loadout = p.pendingLoadout; p.pendingLoadout = null; }
      const sp = this.pickSpawn();
      p.pos = { x: sp.x, y: 0, z: sp.z };
      p.vel = { x: 0, y: 0, z: 0 };
      p.hp = 100;
      p.alive = true;
      p.respawnAt = null;
      p.cooldowns = {};
      p.fireReady = { primary: 0, secondary: 0 };
      p.charge = null;
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
      id: pr.id, ptype: pr.ptype,
      x: pr.pos.x, y: pr.pos.y, z: pr.pos.z,
      vx: pr.vel.x, vy: pr.vel.y, vz: pr.vel.z,
      spin: pr.spin, radius: pr.radius, state: pr.state,
      arc: pr.trajectory === 'arc' ? 1 : 0
    }));
    const events = this.events;
    this.events = [];

    // 공유 부분(players/projectiles/events)은 1회만 직렬화 — 클라별로 ack/you만 다름
    const shared = '"players":' + JSON.stringify(players)
      + ',"projectiles":' + JSON.stringify(projectiles)
      + ',"events":' + JSON.stringify(events);

    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      const you = JSON.stringify({
        hp: p.hp, alive: p.alive, respawnAt: p.respawnAt,
        score: p.score, kills: p.kills, deaths: p.deaths,
        cd: p.cooldowns, fire: p.fireReady,
        bearings: p.buffs.sniperBearings ? p.buffs.sniperBearings.charges : 0,
        loadout: p.loadout
      });
      p.ws.send('{"type":"SNAPSHOT","t":' + now + ',"ack":' + p.lastInputSeq
        + ',' + shared + ',"you":' + you + '}');
    }
  }
}

module.exports = { Room, MAX_PLAYERS };
