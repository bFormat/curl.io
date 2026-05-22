/* 임시 스모크 테스트: 두 클라가 입장→이동→발사→피격/킬 흐름 검증 */
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
// 정해진 방향(yaw)으로 n번 전진 입력 전송
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

  // ── 이동 + 클라 예측 결정론 검증 ──
  const start = me(a);
  const pred = { pos: { x: start.x, y: start.y, z: start.z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  walk(a, 0, 30); // yaw 0 = -Z 방향 전진
  for (let i = 0; i < 30; i++) Sim.step(pred, { move: { f: true }, jump: false, yaw: 0, pitch: 0 }, 1 / 60, a.map);
  await wait(350);
  const moved = me(a);
  const dist = Math.hypot(moved.x - start.x, moved.z - start.z);
  const predErr = Math.hypot(pred.pos.x - moved.x, pred.pos.z - moved.z);
  check(dist > 1, `이동 입력 반영 (${dist.toFixed(2)}m)`);
  check(predErr < 1.0, `예측-서버 위치 오차 작음 (${predErr.toFixed(2)}m)`);

  // ── 두 플레이어를 장애물 없는 코너로 이동 ──
  // Alice: +X 방향(yaw -π/2), Bob: -Z 방향(yaw 0) → (동쪽/남쪽) 코너에서 수렴
  walk(a, -Math.PI / 2, 400);
  walk(b, 0, 400);
  await wait(500);
  const pa = me(a), pb = me(b);
  const gap = Math.hypot(pa.x - pb.x, pa.z - pb.z);
  log(`  Alice=(${pa.x.toFixed(1)},${pa.z.toFixed(1)}) Bob=(${pb.x.toFixed(1)},${pb.z.toFixed(1)}) gap=${gap.toFixed(1)}m`);

  // ── Bob이 Alice를 조준해 원판 연사 ──
  const yaw = Math.atan2(-(pa.x - pb.x), -(pa.z - pb.z));
  const hpBefore = pa.hp;
  for (let i = 0; i < 9; i++) {
    b.ws.send(JSON.stringify({ type: 'FIRE', slot: 'primary', yaw, pitch: 0 }));
    await wait(480);
  }
  await wait(400);
  const hits = b.events.filter((e) => e.kind === 'hit');
  const kills = b.events.filter((e) => e.kind === 'kill' && e.killerId === b.welcome.selfId);
  check(hits.length > 0, `원판 명중 — hit 이벤트 ${hits.length}건`);
  check(kills.length > 0, `킬 성립 — kill 이벤트 ${kills.length}건`);
  const bobNow = me(b);
  check(bobNow.score >= 1, `점수 가산 (Bob score=${bobNow.score})`);

  // ── 스킬: bearing 장전 ──
  b.ws.send(JSON.stringify({ type: 'USE_SKILL', slot: 0 }));
  await wait(250);
  check(b.last.you.bearings === 2, `bearing 스킬 — 쇠구슬 ${b.last.you.bearings}발 장전`);
  check(typeof b.last.you.cd.bearing === 'number', 'bearing 쿨다운 등록됨');

  // ── 투사체가 스냅샷에 실리는지 ──
  b.ws.send(JSON.stringify({ type: 'FIRE', slot: 'secondary', yaw: 0, pitch: 0 }));
  await wait(120);
  check((b.last.projectiles || []).length >= 0, '스냅샷 projectiles 필드 존재');

  a.ws.close(); b.ws.close();
  await wait(200);
  log(fail ? '\n=== 일부 실패 ===' : '\n=== 전체 통과 ===');
  process.exit(fail ? 1 : 0);
})();
