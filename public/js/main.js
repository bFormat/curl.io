/* main.js — 렌더 루프 / 입력 / 클라 예측 / 스냅샷 보간 오케스트레이션. */
import { Net } from './net.js';
import { Renderer } from './render.js';
import { HUD } from './hud.js';

const Sim = window.Sim;
const STEP = 1 / 60;          // 입력 고정 간격
const INTERP_MS = 100;        // 타 엔티티 보간 지연
const SENS = 0.0022;          // 마우스 감도
const MAX_PITCH = 1.5;

// ───────── 메뉴: 스킬 선택 ─────────
const SKILLS_UI = [
  { id: 'repulse', ic: '✷', name: 'Repulse Nova', cd: '30s', desc: '주변 폭발+밀침' },
  { id: 'bearing', ic: '◉', name: 'Sniper Bearings', cd: '15s', desc: '저격 쇠구슬 2발' },
  { id: 'dash', ic: '↣', name: 'Dash', cd: '25s', desc: '전방 돌진' }
];
let picked = ['repulse', 'dash'];

const pickEl = document.getElementById('skillpick');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');

function renderPicker() {
  pickEl.innerHTML = '';
  for (const s of SKILLS_UI) {
    const card = document.createElement('div');
    card.className = 'skill-card' + (picked.includes(s.id) ? ' sel' : '');
    card.innerHTML = `<div class="ic">${s.ic}</div><div class="cn">${s.name.split(' ')[0]}</div><div class="cd-txt">${s.cd}</div>`;
    card.title = s.desc;
    card.onclick = () => {
      if (picked.includes(s.id)) picked = picked.filter((x) => x !== s.id);
      else { picked.push(s.id); if (picked.length > 2) picked.shift(); }
      renderPicker();
    };
    pickEl.appendChild(card);
  }
  playBtn.disabled = picked.length !== 2;
}
renderPicker();

// ───────── 게임 상태 ─────────
const net = new Net();
const hud = new HUD();
let renderer = null;

let selfId = null;
let map = null;
let weapons = null;
let skillDefs = null;
let EYE = 1.5;

const self = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
let pending = [];
let inputSeq = 0;
let you = null;            // 서버 권위 자기 상태
let started = false;
let positioned = false;    // 첫 스냅샷으로 위치 확정됨

const snapshots = [];      // 보간 버퍼
let latestPlayers = [];    // 스코어보드용
let lastSnap = { t: 0, perf: 0 };

const keys = {};
const fireHeld = { primary: false, secondary: false };
const nextFire = { primary: 0, secondary: 0 };
let locked = false;
let acc = 0;
let lastFrame = performance.now();

function serverNow() {
  return lastSnap.t + (performance.now() - lastSnap.perf);
}

// ───────── 입장 ─────────
playBtn.onclick = () => {
  if (picked.length !== 2) return;
  playBtn.disabled = true;
  statusEl.style.color = '#9fb0c8';
  statusEl.textContent = '서버 연결 중...';
  net.connect(
    () => {
      const name = (document.getElementById('name').value || '').trim() || 'curler';
      net.send({ type: 'JOIN', name, skills: picked });
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
  weapons = m.weapons;
  skillDefs = m.skills;
  EYE = (m.sim && m.sim.EYE_HEIGHT) || Sim.C.EYE_HEIGHT;

  renderer = new Renderer(document.getElementById('game'));
  renderer.buildMap(map);
  hud.configure(weapons, skillDefs, m.loadout.skills);

  document.getElementById('menu').classList.add('hidden');
  started = true;
  setupInput();
  requestPointerLock();
  hud.showLock(true); // 락 성공 시 pointerlockchange가 숨김
  lastFrame = performance.now();
  requestAnimationFrame(loop);
});

net.on('SNAPSHOT', (msg) => {
  const perf = performance.now();
  lastSnap = { t: msg.t, perf };
  you = msg.you;
  latestPlayers = msg.players;

  // 보간 버퍼에 적재 (id 키로 변환)
  const players = {}, projectiles = {};
  for (const p of msg.players) players[p.id] = p;
  for (const pr of msg.projectiles) projectiles[pr.id] = pr;
  snapshots.push({ t: msg.t, perf, players, projectiles });
  while (snapshots.length > 50) snapshots.shift();

  // 자기 위치 reconciliation
  const srv = players[selfId];
  if (srv) {
    if (!you.alive) {
      self.pos = { x: srv.x, y: srv.y, z: srv.z };
      self.vel = { x: srv.vx, y: srv.vy, z: srv.vz };
      pending = [];
    } else {
      self.pos = { x: srv.x, y: srv.y, z: srv.z };
      self.vel = { x: srv.vx, y: srv.vy, z: srv.vz };
      pending = pending.filter((i) => i.seq > msg.ack);
      for (const inp of pending) Sim.step(self, inp, inp.dt, map);
    }
    positioned = true;
  }

  for (const ev of msg.events || []) handleEvent(ev);
});

function handleEvent(ev) {
  if (!renderer) return;
  if (ev.kind === 'hit') {
    renderer.burst({ x: ev.x, y: ev.y, z: ev.z }, 0xffe27a, 1);
    if (ev.victimId === selfId) renderer.shake(0.45);
  } else if (ev.kind === 'kill') {
    hud.pushKill(ev);
  } else if (ev.kind === 'skill') {
    if (ev.skill === 'repulse') {
      renderer.ring({ x: ev.x, y: ev.y, z: ev.z }, skillDefs.repulse.radius, 0x4fc3f7);
      renderer.burst({ x: ev.x, y: ev.y + 1, z: ev.z }, 0x9fe0ff, 1.6);
      const dx = ev.x - self.pos.x, dz = ev.z - self.pos.z;
      if (Math.sqrt(dx * dx + dz * dz) < skillDefs.repulse.radius + 4) {
        renderer.shake(0.6);
      }
    }
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
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!locked) { requestPointerLock(); return; }
    if (e.button === 0) fireHeld.primary = true;
    if (e.button === 2) fireHeld.secondary = true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) fireHeld.primary = false;
    if (e.button === 2) fireHeld.secondary = false;
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
    hud.showLock(!locked);
  });
}

function useSkill(slot) {
  if (!you || !you.alive || !locked) return;
  net.send({ type: 'USE_SKILL', slot });
}

function tryFire(slot, now) {
  if (!you || !you.alive || !locked) return;
  if (now < nextFire[slot]) return;
  net.send({ type: 'FIRE', slot, yaw: self.yaw, pitch: self.pitch });
  const cd = slot === 'primary'
    ? weapons[you.bearings > 0 ? 'bearing' : 'disc'].cooldown
    : weapons.pushball.cooldown;
  nextFire[slot] = now + cd;
}

function stepInput() {
  if (!you || !you.alive || !positioned) return;
  const input = {
    type: 'INPUT',
    seq: ++inputSeq,
    dt: STEP,
    move: {
      f: !!keys['KeyW'], b: !!keys['KeyS'],
      l: !!keys['KeyA'], r: !!keys['KeyD']
    },
    jump: !!keys['Space'],
    yaw: self.yaw,
    pitch: self.pitch
  };
  net.send(input);
  pending.push(input);
  if (pending.length > 200) pending.shift();
  Sim.step(self, input, STEP, map);
}

// ───────── 보간 ─────────
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function interpolate(tt) {
  if (snapshots.length === 0) return { players: {}, projectiles: {} };
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
      players[id] = {
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
  const projectiles = {};
  const pids = new Set([...Object.keys(a.projectiles), ...Object.keys(b.projectiles)]);
  for (const id of pids) {
    const ra = a.projectiles[id], rb = b.projectiles[id];
    if (ra && rb) {
      projectiles[id] = {
        id, type: rb.type, spin: rb.spin,
        x: ra.x + (rb.x - ra.x) * f,
        y: ra.y + (rb.y - ra.y) * f,
        z: ra.z + (rb.z - ra.z) * f,
        vx: rb.vx, vy: rb.vy, vz: rb.vz
      };
    } else {
      projectiles[id] = rb || ra;
    }
  }
  return { players, projectiles };
}

// ───────── 메인 루프 ─────────
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (dt > 0.1) dt = 0.1;

  // 고정 간격 입력/예측
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 8) {
    stepInput();
    acc -= STEP;
  }

  // 발사 (홀드 가능)
  const sn = serverNow();
  if (fireHeld.primary) tryFire('primary', sn);
  if (fireHeld.secondary) tryFire('secondary', sn);

  // 보간된 월드 상태
  const world = interpolate(sn - INTERP_MS);
  const playerList = [];
  for (const id in world.players) {
    if (id === selfId) continue;
    playerList.push(world.players[id]);
  }
  // 자기는 예측 위치
  playerList.push({
    id: selfId, name: '', alive: you ? you.alive : true,
    x: self.pos.x, y: self.pos.y, z: self.pos.z,
    yaw: self.yaw, pitch: self.pitch
  });
  renderer.syncPlayers(playerList, selfId);
  renderer.syncProjectiles(Object.values(world.projectiles), dt);

  const camPos = { x: self.pos.x, y: self.pos.y + EYE, z: self.pos.z };
  renderer.render(camPos, self.yaw, self.pitch, dt);

  // HUD
  if (you) hud.update(you, sn);
  hud.setPing(net.rtt);
  hud.showScoreboard(!!keys['Tab'], latestPlayers, selfId);
}
