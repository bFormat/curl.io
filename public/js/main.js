/* main.js — 렌더 루프 / 입력 / 클라 예측 / 보간 / 로드아웃. v0.2 */
import { Net } from './net.js';
import { Renderer } from './render.js';
import { HUD } from './hud.js';
import { Sfx } from './audio.js';
import { buildPicker, DEFAULT_LOADOUT } from './loadout.js';

const Sim = window.Sim;
const STEP = 1 / 60;
const INTERP_MS = 100;
const SENS = 0.0022;
const MAX_PITCH = 1.5;
const PROJ_G = 16;  // arc 투사체 중력 — 서버와 일치

const net = new Net();
const hud = new HUD();
const audio = new Sfx();
let renderer = null;

let selfId = null, map = null, defs = null, EYE = 1.5;
const loadout = JSON.parse(JSON.stringify(DEFAULT_LOADOUT));

const self = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
const posError = { x: 0, y: 0, z: 0 };
let pending = [], inputSeq = 0, prevJump = false;
let you = null, started = false, positioned = false, wasAlive = true;

const snapshots = [];
let latestPlayers = [];
let lastSnap = { t: 0, perf: 0 };

const keys = {};
const fireHeld = { primary: false, secondary: false };
const nextFire = { primary: 0, secondary: 0 };
let chargingPrimary = false, chargeStartPerf = 0;
let locked = false, acc = 0, lastFrame = performance.now();

const serverNow = () => lastSnap.t + (performance.now() - lastSnap.perf);
const PROJ_COLOR = {
  disc: 0xffd23f, pushball: 0x4fc3f7, ironball: 0x9aa6b4, bearing: 0xdfe6ef,
  pencil: 0xf4c542, arrow: 0xd9b38c, eraser: 0xff9ec4, stickybomb: 0x9a5555
};
const projColor = (t) => PROJ_COLOR[t] || 0xffffff;
function volAt(x, z) {
  const d = Math.hypot((x || 0) - self.pos.x, (z || 0) - self.pos.z);
  return Math.max(0.12, Math.min(1, 1 - d / 45));
}
const isPrimaryCharge = () => loadout.primary === 'bow' && !(you && you.bearings > 0);

// ───────── 메뉴 ─────────
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
buildPicker(document.getElementById('menu-loadout'), loadout, null, false);

playBtn.onclick = () => {
  audio.init();
  audio.resume();
  playBtn.disabled = true;
  statusEl.style.color = '#9fb0c8';
  statusEl.textContent = '서버 연결 중...';
  net.connect(
    () => {
      const name = (document.getElementById('name').value || '').trim() || 'curler';
      net.send({ type: 'JOIN', name, loadout });
    },
    () => {
      statusEl.style.color = '#ff6b6b';
      statusEl.textContent = '연결이 끊겼습니다. 새로고침하세요.';
    }
  );
};

net.on('ERROR', (m) => {
  statusEl.style.color = '#ff6b6b';
  statusEl.textContent = m.message || '입장 실패';
  playBtn.disabled = false;
});

net.on('WELCOME', (m) => {
  selfId = m.selfId;
  map = m.map;
  defs = { primary: m.primary, secondary: m.secondary, skills: m.skills, bearingProj: m.bearingProj };
  EYE = (m.sim && m.sim.EYE_HEIGHT) || Sim.C.EYE_HEIGHT;

  renderer = new Renderer(document.getElementById('game'));
  renderer.buildMap(map);
  hud.configure(defs, m.map && m.map.name);

  // 리스폰 화면 로드아웃 패널 — 변경 시 SET_LOADOUT 전송
  buildPicker(document.getElementById('death-loadout'), loadout, (lo) => {
    net.send({ type: 'SET_LOADOUT', primary: lo.primary, secondary: lo.secondary, skills: lo.skills });
  }, true);

  document.getElementById('menu').classList.add('hidden');
  started = true;
  setupInput();
  requestPointerLock();
  lastFrame = performance.now();
  requestAnimationFrame(loop);
});

net.on('SNAPSHOT', (msg) => {
  const perf = performance.now();
  lastSnap = { t: msg.t, perf };
  you = msg.you;
  latestPlayers = msg.players;

  const players = {}, projectiles = {};
  for (const p of msg.players) players[p.id] = p;
  for (const pr of msg.projectiles) projectiles[pr.id] = pr;
  snapshots.push({ t: msg.t, perf, players, projectiles });
  while (snapshots.length > 50) snapshots.shift();

  const srv = players[selfId];
  if (srv) {
    if (!you.alive) {
      self.pos = { x: srv.x, y: srv.y, z: srv.z };
      self.vel = { x: srv.vx, y: srv.vy, z: srv.vz };
      pending = [];
      posError.x = posError.y = posError.z = 0;
    } else {
      const before = { x: self.pos.x, y: self.pos.y, z: self.pos.z };
      self.pos = { x: srv.x, y: srv.y, z: srv.z };
      self.vel = { x: srv.vx, y: srv.vy, z: srv.vz };
      pending = pending.filter((i) => i.seq > msg.ack);
      for (const inp of pending) Sim.step(self, inp, inp.dt, map);
      if (positioned) {
        posError.x += before.x - self.pos.x;
        posError.y += before.y - self.pos.y;
        posError.z += before.z - self.pos.z;
        if (Math.hypot(posError.x, posError.y, posError.z) > 2.5) {
          posError.x = posError.y = posError.z = 0;
        }
      }
    }
    positioned = true;
  }

  // 사망 전환 시 포인터락 해제 → 리스폰 패널 클릭 가능
  if (wasAlive && !you.alive) {
    chargingPrimary = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  wasAlive = you.alive;

  for (const ev of msg.events || []) handleEvent(ev);
});

function handleEvent(ev) {
  if (!renderer) return;
  const pos = { x: ev.x, y: ev.y, z: ev.z };
  if (ev.kind === 'hit') {
    renderer.burst(pos, 0xffe27a, 1);
    renderer.debris(pos, 0xffd23f, 5);
    if (ev.victimId) renderer.flashPlayer(ev.victimId);
    const isSelf = ev.victimId === selfId;
    if (isSelf) renderer.shake(0.5);
    audio.hit(isSelf ? 1 : volAt(ev.x, ev.z));
  } else if (ev.kind === 'kill') {
    hud.pushKill(ev);
    if (ev.x != null) {
      renderer.burst(pos, 0xff8a5c, 2);
      renderer.debris(pos, 0xff6b6b, 12);
    }
    const involved = ev.killerId === selfId || ev.victimId === selfId;
    audio.kill(involved ? 1 : volAt(ev.x, ev.z));
  } else if (ev.kind === 'skill') {
    if (ev.skill === 'repulse') {
      renderer.ring(pos, defs.skills.repulse.radius, 0x4fc3f7);
      renderer.burst({ x: ev.x, y: ev.y + 1, z: ev.z }, 0x9fe0ff, 1.6);
      if (Math.hypot(ev.x - self.pos.x, ev.z - self.pos.z) < defs.skills.repulse.radius + 4) {
        renderer.shake(0.6);
      }
    } else if (ev.skill === 'dash') {
      renderer.ring(pos, 3, 0xffd23f);
    }
    audio.skill(ev.skill, ev.id === selfId ? 1 : volAt(ev.x, ev.z));
  } else if (ev.kind === 'jumppack') {
    renderer.ring(pos, 3.5, 0x9fe0ff);
    renderer.burst({ x: ev.x, y: ev.y + 0.6, z: ev.z }, 0x9fe0ff, 1.3);
    if (ev.id === selfId) renderer.shake(0.3);
  } else if (ev.kind === 'pop') {
    renderer.debris(pos, projColor(ev.ptype), 6);
    renderer.burst(pos, projColor(ev.ptype), 0.7);
    audio.bounce(volAt(ev.x, ev.z) * 0.6);
  } else if (ev.kind === 'bounce') {
    renderer.burst(pos, 0x9fe0ff, 0.6);
    audio.bounce(volAt(ev.x, ev.z));
  } else if (ev.kind === 'stick') {
    renderer.burst(pos, 0xff6b6b, 0.6);
    audio.stick(volAt(ev.x, ev.z));
  } else if (ev.kind === 'explosion') {
    renderer.explosion(pos, ev.radius || 4);
    const d = Math.hypot(ev.x - self.pos.x, ev.z - self.pos.z);
    if (d < (ev.radius || 4) + 6) renderer.shake(0.9);
    audio.explosion(volAt(ev.x, ev.z));
  } else if (ev.kind === 'spawn') {
    if (ev.id === selfId) audio.respawn();
  }
}

// ───────── 입력 ─────────
function requestPointerLock() {
  document.getElementById('game').requestPointerLock();
}

function setupInput() {
  const canvas = document.getElementById('game');

  addEventListener('keydown', (e) => {
    if (!started) return;
    keys[e.code] = true;
    if (e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'ShiftLeft') useSkill(0);
    if (e.code === 'KeyE') useSkill(1);
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    fireHeld.primary = fireHeld.secondary = false;
    if (chargingPrimary) {
      net.send({ type: 'FIRE_RELEASE', slot: 'primary', yaw: self.yaw, pitch: self.pitch });
      chargingPrimary = false;
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!locked) { requestPointerLock(); return; }
    if (!you || !you.alive) return;
    if (e.button === 0) {
      if (isPrimaryCharge()) {
        net.send({ type: 'FIRE_START', slot: 'primary', yaw: self.yaw, pitch: self.pitch });
        chargingPrimary = true;
        chargeStartPerf = performance.now();
        audio.bowDraw();
      } else {
        fireHeld.primary = true;
      }
    } else if (e.button === 2) {
      fireHeld.secondary = true;
    }
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      if (chargingPrimary) {
        net.send({ type: 'FIRE_RELEASE', slot: 'primary', yaw: self.yaw, pitch: self.pitch });
        chargingPrimary = false;
        audio.fire('arrow');
      } else {
        fireHeld.primary = false;
      }
    } else if (e.button === 2) {
      fireHeld.secondary = false;
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('mousemove', (e) => {
    if (!locked) return;
    self.yaw -= e.movementX * SENS;
    self.pitch -= e.movementY * SENS;
    if (self.pitch > MAX_PITCH) self.pitch = MAX_PITCH;
    if (self.pitch < -MAX_PITCH) self.pitch = -MAX_PITCH;
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
  });
}

function useSkill(slot) {
  if (!you || !you.alive || !locked) return;
  net.send({ type: 'USE_SKILL', slot });
}

function effType(slot) {
  if (slot === 'primary') {
    return you.bearings > 0 ? 'bearing' : defs.primary[loadout.primary].ptype;
  }
  const w = defs.secondary[loadout.secondary];
  return w.kind === 'instant' ? 'jumppack' : w.ptype;
}
function cooldownFor(slot) {
  if (slot === 'primary') {
    return you.bearings > 0 ? defs.bearingProj.cooldown : defs.primary[loadout.primary].cooldown;
  }
  return defs.secondary[loadout.secondary].cooldown;
}

function tryFire(slot, now) {
  if (!you || !you.alive || !locked) return;
  if (slot === 'primary' && isPrimaryCharge()) return;  // 차징 무기는 click 경로 제외
  if (now < nextFire[slot]) return;
  net.send({ type: 'FIRE_START', slot, yaw: self.yaw, pitch: self.pitch });
  audio.fire(effType(slot));
  nextFire[slot] = now + cooldownFor(slot);
}

function stepInput() {
  if (!you || !you.alive || !positioned) return;
  const input = {
    type: 'INPUT', seq: ++inputSeq, dt: STEP,
    move: { f: !!keys['KeyW'], b: !!keys['KeyS'], l: !!keys['KeyA'], r: !!keys['KeyD'] },
    jump: !!keys['Space'], yaw: self.yaw, pitch: self.pitch
  };
  const grounded = self.pos.y <= 0.03;
  if (input.jump && !prevJump && grounded) audio.jump();
  prevJump = input.jump;

  net.send(input);
  pending.push(input);
  if (pending.length > 200) pending.shift();
  Sim.step(self, input, STEP, map);
}

// ───────── 보간 / 외삽 ─────────
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function interpolate(tt) {
  if (snapshots.length === 0) return { players: {} };
  let a = snapshots[0], b = snapshots[0], f = 0;
  if (tt >= snapshots[snapshots.length - 1].t) {
    a = b = snapshots[snapshots.length - 1];
  } else if (tt > snapshots[0].t) {
    for (let i = 0; i < snapshots.length - 1; i++) {
      if (tt >= snapshots[i].t && tt <= snapshots[i + 1].t) {
        a = snapshots[i]; b = snapshots[i + 1];
        f = (tt - a.t) / (b.t - a.t || 1);
        break;
      }
    }
  }
  const players = {};
  const ids = new Set([...Object.keys(a.players), ...Object.keys(b.players)]);
  for (const id of ids) {
    const pa = a.players[id], pb = b.players[id];
    if (pa && pb) {
      const far = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) > 6;
      players[id] = far ? pb : {
        id, name: pb.name, alive: pb.alive,
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
        yaw: lerpAngle(pa.yaw, pb.yaw, f),
        pitch: pa.pitch + (pb.pitch - pa.pitch) * f
      };
    } else {
      players[id] = pb || pa;
    }
  }
  return { players };
}

function extrapolatedProjectiles(sn) {
  if (snapshots.length === 0) return [];
  const last = snapshots[snapshots.length - 1];
  let age = (sn - last.t) / 1000;
  if (age < 0) age = 0;
  if (age > 0.3) age = 0.3;
  const out = [];
  for (const id in last.projectiles) {
    const p = last.projectiles[id];
    const arc = p.arc && p.state !== 'stuck';
    out.push({
      id, ptype: p.ptype, spin: p.spin, radius: p.radius, state: p.state,
      x: p.x + p.vx * age,
      y: p.y + p.vy * age - (arc ? 0.5 * PROJ_G * age * age : 0),
      z: p.z + p.vz * age,
      vx: p.vx, vy: arc ? p.vy - PROJ_G * age : p.vy, vz: p.vz
    });
  }
  return out;
}

// ───────── 메인 루프 ─────────
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (dt > 0.1) dt = 0.1;

  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 8) { stepInput(); acc -= STEP; }

  const sn = serverNow();
  if (fireHeld.primary) tryFire('primary', sn);
  if (fireHeld.secondary) tryFire('secondary', sn);

  const ek = Math.exp(-dt / 0.07);
  posError.x *= ek; posError.y *= ek; posError.z *= ek;

  const world = interpolate(sn - INTERP_MS);
  const playerList = [];
  for (const id in world.players) {
    if (id === selfId) continue;
    playerList.push(world.players[id]);
  }
  playerList.push({
    id: selfId, name: '', alive: you ? you.alive : true,
    x: self.pos.x, y: self.pos.y, z: self.pos.z,
    yaw: self.yaw, pitch: self.pitch
  });
  renderer.syncPlayers(playerList, selfId, dt);
  renderer.syncProjectiles(extrapolatedProjectiles(sn), dt);

  const camPos = {
    x: self.pos.x + posError.x,
    y: self.pos.y + posError.y + EYE,
    z: self.pos.z + posError.z
  };
  renderer.render(camPos, self.yaw, self.pitch, dt);

  if (you) hud.update(you, sn);
  hud.setPing(net.rtt);
  hud.setCharge(chargingPrimary, defs ? (performance.now() - chargeStartPerf) / defs.primary.bow.charge.maxHold : 0);
  hud.showLock(started && !locked && (!you || you.alive));
  hud.showScoreboard(!!keys['Tab'], latestPlayers, selfId);
}
