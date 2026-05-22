/* 스모크 테스트 v0.2 — 로드아웃·5주무기·3보조·차징·성장·점착·점프팩·안티치트 */
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

function client(name, loadout) {
  const ws = new WebSocket(URL);
  const st = { name, ws, welcome: null, last: null, snaps: 0, events: [],
    map: null, seq: 0, ptypes: new Set(), eraserR: { min: 9, max: 0 } };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN', name, loadout })));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'WELCOME') { st.welcome = m; st.map = m.map; }
    else if (m.type === 'SNAPSHOT') {
      st.snaps++; st.last = m;
      for (const pr of m.projectiles) {
        st.ptypes.add(pr.ptype);
        if (pr.ptype === 'eraser') {
          st.eraserR.min = Math.min(st.eraserR.min, pr.radius);
          st.eraserR.max = Math.max(st.eraserR.max, pr.radius);
        }
      }
      if (m.events.length) st.events.push(...m.events);
    }
  });
  return st;
}
const me = (c) => c.last.players.find((p) => p.id === c.welcome.selfId);
function walk(c, yaw, n) {
  for (let i = 0; i < n; i++) {
    c.ws.send(JSON.stringify({ type: 'INPUT', seq: ++c.seq, dt: 1 / 60,
      move: { f: true }, jump: false, yaw, pitch: 0 }));
  }
}
const fireStart = (c, slot, yaw, pitch) =>
  c.ws.send(JSON.stringify({ type: 'FIRE_START', slot, yaw, pitch }));
const fireRelease = (c, slot, yaw, pitch) =>
  c.ws.send(JSON.stringify({ type: 'FIRE_RELEASE', slot, yaw, pitch }));

(async () => {
  const a = client('Alice', { primary: 'disc', secondary: 'pushball', skills: ['repulse', 'dash'] });
  const b = client('Bob', { primary: 'ironball', secondary: 'jumppack', skills: ['bearing', 'dash'] });
  const c = client('Carl', { primary: 'bow', secondary: 'jumppack', skills: ['repulse', 'dash'] });
  const d = client('Dora', { primary: 'eraser', secondary: 'stickybomb', skills: ['repulse', 'dash'] });
  await wait(900);

  check([a, b, c, d].every((x) => x.welcome), '4 클라 WELCOME 수신');
  check(Object.keys(a.welcome.primary).length === 5, `주무기 5종 테이블 (${Object.keys(a.welcome.primary).join(',')})`);
  check(Object.keys(a.welcome.secondary).length === 3, '보조무기 3종 테이블');
  check(a.last.players.length === 4, `같은 룸 4인 (${a.last.players.length})`);
  check(['box-arena', 'pillar-yard'].includes(a.welcome.map.name), `맵 (${a.welcome.map.name})`);

  // SET_LOADOUT — Alice 다음 리스폰에 pencil 적용 예약
  a.ws.send(JSON.stringify({ type: 'SET_LOADOUT',
    primary: 'pencil', secondary: 'pushball', skills: ['repulse', 'dash'] }));

  // 이동 + 예측 결정론
  const start = me(a);
  const pred = { pos: { x: start.x, y: start.y, z: start.z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  walk(a, 0, 30);
  for (let i = 0; i < 30; i++) Sim.step(pred, { move: { f: true }, jump: false, yaw: 0, pitch: 0 }, 1 / 60, a.map);
  await wait(450);
  const predErr = Math.hypot(pred.pos.x - me(a).x, pred.pos.z - me(a).z);
  check(predErr < 1.2, `예측-서버 위치 오차 작음 (${predErr.toFixed(2)}m)`);

  // Bob 호밍 접근
  const gap0 = Math.hypot(me(a).x - me(b).x, me(a).z - me(b).z);
  for (let i = 0; i < 44; i++) {
    const pa = me(a), pb = me(b);
    if (Math.hypot(pa.x - pb.x, pa.z - pb.z) < 3.2) break;
    walk(b, Math.atan2(-(pa.x - pb.x), -(pa.z - pb.z)), 8);
    await wait(120);
  }
  const gap1 = Math.hypot(me(a).x - me(b).x, me(a).z - me(b).z);
  check(gap1 < gap0 - 3, `Bob 호밍 접근 (${gap0.toFixed(1)}→${gap1.toFixed(1)}m)`);

  // Bob 쇠구슬 연사 → 킬
  for (let i = 0; i < 4; i++) {
    const pa = me(a), pb = me(b);
    fireStart(b, 'primary', Math.atan2(-(pa.x - pb.x), -(pa.z - pb.z)), 0);
    await wait(1150);
  }
  await wait(400);
  check(b.events.some((e) => e.kind === 'hit'), '쇠구슬 명중');
  check(b.events.some((e) => e.kind === 'kill' && e.killerId === b.welcome.selfId), '쇠구슬 킬');

  // Carl 활 차징 발사 → arrow 투사체
  fireStart(c, 'primary', 0, 0.6);
  await wait(750);
  fireRelease(c, 'primary', 0, 0.6);
  await wait(350);
  check(c.ptypes.has('arrow'), '활 차징 발사 — arrow 투사체 관측');

  // Carl 점프팩 → 상방 가속 + 이벤트
  fireStart(c, 'secondary', 0, 0);
  let maxVy = -9;
  for (let i = 0; i < 8; i++) { await wait(40); maxVy = Math.max(maxVy, me(c).vy); }
  check(c.events.some((e) => e.kind === 'jumppack'), '점프팩 — jumppack 이벤트');
  check(maxVy > 6, `점프팩 — 상방 임펄스 (vy ${maxVy.toFixed(1)})`);

  // Dora 지우개 발사 → 성장(반경 증가)
  fireStart(d, 'primary', 0, 1.4);
  await wait(1700);
  check(d.eraserR.max - d.eraserR.min > 0.3,
    `지우개 성장 (반경 ${d.eraserR.min.toFixed(2)}→${d.eraserR.max.toFixed(2)}m)`);

  // Dora 점착폭탄 → 부착 후 폭발
  d.events.length = 0;
  fireStart(d, 'secondary', 0, -1.3);
  await wait(3600);
  check(d.events.some((e) => e.kind === 'stick'), '점착폭탄 부착 — stick 이벤트');
  check(d.events.some((e) => e.kind === 'explosion'), '점착폭탄 폭발 — explosion 이벤트');

  // SET_LOADOUT 적용 확인 (Alice 리스폰 후 pencil)
  check(a.last.you.loadout.primary === 'pencil',
    `SET_LOADOUT 리스폰 적용 (primary=${a.last.you.loadout.primary})`);

  // 안티치트 — 입력 폭주 제한
  const ac0 = me(b);
  for (let i = 0; i < 600; i++) {
    b.ws.send(JSON.stringify({ type: 'INPUT', seq: ++b.seq, dt: 1 / 60,
      move: { f: true }, jump: false, yaw: 0, pitch: 0 }));
  }
  await wait(1200);
  const flood = Math.hypot(me(b).x - ac0.x, me(b).z - ac0.z);
  check(flood < 22, `안티치트 — 입력 폭주 이동 제한 (${flood.toFixed(1)}m)`);

  [a, b, c, d].forEach((x) => x.ws.close());
  await wait(200);
  log(fail ? '\n=== 일부 실패 ===' : '\n=== 전체 통과 ===');
  process.exit(fail ? 1 : 0);
})();
