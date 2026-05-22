/* 스모크 테스트: 입장→이동→발사→피격/킬→스킬→바운스→안티치트 검증 (P0~P2) */
'use strict';
const WebSocket = require('ws');
const Sim = require('../shared/sim');

const URL = 'ws://localhost:3000';
const log = (...a) => console.log(...a);
let fail = false;
function check(cond, msg) {
  log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) fail = true;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, skills) {
  const ws = new WebSocket(URL);
  const st = { name, ws, welcome: null, snaps: 0, last: null, events: [], map: null, seq: 0 };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN', name, skills })));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'WELCOME') { st.welcome = m; st.map = m.map; }
    else if (m.type === 'SNAPSHOT') {
      st.snaps++; st.last = m;
      if (m.events && m.events.length) st.events.push(...m.events);
    }
  });
  return st;
}
const me = (c) => c.last.players.find((p) => p.id === c.welcome.selfId);
function walk(c, yaw, n) {
  for (let i = 0; i < n; i++) {
    c.ws.send(JSON.stringify({
      type: 'INPUT', seq: ++c.seq, dt: 1 / 60,
      move: { f: true }, jump: false, yaw, pitch: 0
    }));
  }
}

(async () => {
  const a = client('Alice', ['repulse', 'dash']);
  const b = client('Bob', ['bearing', 'dash']);
  await wait(700);

  check(a.welcome && b.welcome, '두 클라 WELCOME 수신');
  check(a.welcome.selfId !== b.welcome.selfId, '고유 id 발급');
  check(a.snaps > 5, `Alice 스냅샷 수신 (${a.snaps})`);
  check(a.last.players.some((p) => p.id === b.welcome.selfId), '같은 룸 — 서로 보임');
  check(['box-arena', 'pillar-yard'].includes(a.welcome.map.name),
    `맵 선택됨 (${a.welcome.map.name})`);

  // ── 이동 + 클라 예측 결정론 ──
  const start = me(a);
  const pred = { pos: { x: start.x, y: start.y, z: start.z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  walk(a, 0, 30);
  for (let i = 0; i < 30; i++) Sim.step(pred, { move: { f: true }, jump: false, yaw: 0, pitch: 0 }, 1 / 60, a.map);
  await wait(450);
  const moved = me(a);
  const dist = Math.hypot(moved.x - start.x, moved.z - start.z);
  const predErr = Math.hypot(pred.pos.x - moved.x, pred.pos.z - moved.z);
  check(dist > 1, `이동 입력 반영 (${dist.toFixed(2)}m)`);
  check(predErr < 1.2, `예측-서버 위치 오차 작음 (${predErr.toFixed(2)}m)`);

  // ── Bob이 Alice에게 호밍 접근 (장애물 슬라이드 회피) ──
  const gapBefore = Math.hypot(me(a).x - me(b).x, me(a).z - me(b).z);
  for (let i = 0; i < 44; i++) {
    const pa = me(a), pb = me(b);
    const g = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    if (g < 3.2) break;
    walk(b, Math.atan2(-(pa.x - pb.x), -(pa.z - pb.z)), 8);
    await wait(120);
  }
  const pa0 = me(a), pb0 = me(b);
  const gap = Math.hypot(pa0.x - pb0.x, pa0.z - pb0.z);
  log(`  접근: ${gapBefore.toFixed(1)}m → ${gap.toFixed(1)}m`);
  check(gap < gapBefore - 3, `호밍 접근 진척 (${gapBefore.toFixed(1)}→${gap.toFixed(1)}m)`);

  // ── 근접 원판 연사 → 피격/킬/점수 ──
  const yaw = Math.atan2(-(pa0.x - pb0.x), -(pa0.z - pb0.z));
  for (let i = 0; i < 8; i++) {
    b.ws.send(JSON.stringify({ type: 'FIRE', slot: 'primary', yaw, pitch: 0 }));
    await wait(480);
  }
  await wait(400);
  check(b.events.filter((e) => e.kind === 'hit').length > 0,
    `원판 명중 — hit ${b.events.filter((e) => e.kind === 'hit').length}건`);
  check(b.events.some((e) => e.kind === 'kill' && e.killerId === b.welcome.selfId), '킬 성립');
  check(me(b).score >= 1, `점수 가산 (Bob score=${me(b).score})`);

  // ── bearing 스킬 ──
  b.ws.send(JSON.stringify({ type: 'USE_SKILL', slot: 0 }));
  await wait(250);
  check(b.last.you.bearings === 2, `bearing 스킬 — 쇠구슬 ${b.last.you.bearings}발 장전`);

  // ── pushball 바운스 (지면으로 급발사 → 바닥 반사) ──
  const evBefore = b.events.length;
  b.ws.send(JSON.stringify({ type: 'FIRE', slot: 'secondary', yaw: 0, pitch: -1.2 }));
  await wait(450);
  const bounces = b.events.slice(evBefore).filter((e) => e.kind === 'bounce');
  check(bounces.length > 0, `pushball 바운스 — bounce 이벤트 ${bounces.length}건`);

  // ── 안티치트: 입력 폭주해도 이동 속도 상한 ──
  const acStart = me(b);
  for (let i = 0; i < 600; i++) {
    b.ws.send(JSON.stringify({
      type: 'INPUT', seq: ++b.seq, dt: 1 / 60,
      move: { f: true }, jump: false, yaw: 0, pitch: 0
    }));
  }
  await wait(1200);
  const acEnd = me(b);
  const flood = Math.hypot(acEnd.x - acStart.x, acEnd.z - acStart.z);
  const sane = isFinite(acEnd.x) && isFinite(acEnd.z) &&
    Math.abs(acEnd.x) <= b.map.half + 4 && Math.abs(acEnd.z) <= b.map.half + 4;
  check(sane, '안티치트 — 위치 유한·맵 범위 내');
  check(flood < 22, `안티치트 — 입력 폭주 이동 제한 (${flood.toFixed(1)}m, 비제한 시 ~70m)`);

  a.ws.close(); b.ws.close();
  await wait(200);
  log(fail ? '\n=== 일부 실패 ===' : '\n=== 전체 통과 ===');
  process.exit(fail ? 1 : 0);
})();
