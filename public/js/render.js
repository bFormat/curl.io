/* render.js — Three.js 씬 / 엔티티 / 연출. v0.2 + 성능 최적화.
 * 핵심: 투사체·이펙트 메시 풀링(런타임 지오메트리 할당 0) → GC 튐 제거.
 * 마인크래프트식 6파트 캐릭터 모델 + 파트 회전 애니메이션. */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

function hueColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  const c = new THREE.Color();
  c.setHSL(((h >>> 0) % 360) / 360, 0.62, 0.56);
  return c;
}

function nameSprite(name) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 34px Trebuchet MS, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#11161f';
  ctx.strokeText(name, 128, 34);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(2.4, 0.6, 1);
  spr.position.y = 2.05;
  return spr;
}

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}
function limb(w, h, d, mat) {
  const g = new THREE.Group();
  const m = box(w, h, d, mat);
  m.position.y = -h / 2;
  g.add(m);
  return g;
}
function lerp(a, b, t) { return a + (b - a) * t; }

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));  // 픽셀 과렌더 방지
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;              // Soft보다 가벼움

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b3a55);
    this.scene.fog = new THREE.Fog(0x2b3a55, 50, 130);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.1, 400);
    this.camera.rotation.order = 'YXZ';

    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x39402f, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
    sun.position.set(40, 64, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);          // 2048→1024
    const s = 58;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 180;
    sun.shadow.bias = -0.0016;
    this.scene.add(sun);

    this.players = new Map();
    this.projectiles = new Map();
    this.effects = [];
    this.shakeAmt = 0;

    // ── 풀링 자원 ──
    this._seen = new Set();
    this._projAssets = {};   // ptype → {geo,mat} (공유)
    this._projFree = {};     // ptype → 재사용 대기 rec 배열
    this._fx = {             // 이펙트 공유 지오메트리
      ico: new THREE.IcosahedronGeometry(0.3, 0),
      ring: new THREE.RingGeometry(0.85, 1, 32),
      sphere: new THREE.SphereGeometry(1, 16, 12),
      cube: new THREE.BoxGeometry(0.13, 0.13, 0.13)
    };
    this.FX_CAP = 80;        // 동시 이펙트 상한

    this._onResize();
    addEventListener('resize', () => this._onResize());
  }

  _onResize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildMap(map) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.half * 2 + 8, map.half * 2 + 8),
      new THREE.MeshLambertMaterial({ color: 0x46603f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(map.half * 2, map.half, 0x5a7350, 0x3c5237);
    grid.position.y = 0.02;
    this.scene.add(grid);

    const KIND_COLOR = {
      wall: 0x3a4661, pillar: 0xc06b4f, floor: 0x6f7e93,
      stair: 0x8c99aa, crate: 0xb98a52
    };
    map.obstacles.forEach((b) => {
      const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshLambertMaterial({ color: KIND_COLOR[b.kind] || 0x3a4661 })
      );
      mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    });
  }

  // ── 1인칭 뷰모델 ────────────────────────────────────────────
  _ensureViewmodel() {
    if (this.vm) return;
    this.scene.add(this.camera);
    this.vm = new THREE.Group();
    this.vm.position.set(0.32, -0.3, -0.62);
    this.camera.add(this.vm);
    this.vmWeapon = null;
    this.vmRecoil = 0;
    this.vmBob = 0;
    this.vmLastCam = null;
    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.34),
      new THREE.MeshLambertMaterial({ color: 0xd9a06b })
    );
    hand.position.set(-0.04, -0.06, 0.12);
    this.vm.add(hand);
  }

  setViewmodel(weaponId) {
    this._ensureViewmodel();
    if (this.vmWeapon) {
      this.vm.remove(this.vmWeapon);
      this.vmWeapon.geometry.dispose();
      this.vmWeapon.material.dispose();
    }
    let geo, color;
    if (weaponId === 'ironball') { geo = new THREE.SphereGeometry(0.09, 12, 10); color = 0x9aa6b4; }
    else if (weaponId === 'pencil') { geo = new THREE.CylinderGeometry(0.022, 0.022, 0.46, 8); color = 0xf4c542; }
    else if (weaponId === 'bow') { geo = new THREE.TorusGeometry(0.24, 0.025, 8, 16, Math.PI * 1.2); color = 0xd9b38c; }
    else if (weaponId === 'eraser') { geo = new THREE.BoxGeometry(0.2, 0.12, 0.3); color = 0xff9ec4; }
    else { geo = new THREE.CylinderGeometry(0.13, 0.13, 0.05, 18); color = 0xffd23f; }
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    if (weaponId === 'pencil' || weaponId === 'disc') mesh.rotation.x = Math.PI / 2;
    else if (weaponId === 'bow') mesh.rotation.y = Math.PI / 2;
    mesh.position.set(0, 0, -0.18);
    this.vm.add(mesh);
    this.vmWeapon = mesh;
  }

  viewmodelRecoil() { this.vmRecoil = Math.min(1, this.vmRecoil + 0.7); }

  _updateViewmodel(camPos, dt) {
    if (!this.vm) return;
    let spd = 0;
    if (this.vmLastCam) {
      spd = Math.hypot(camPos.x - this.vmLastCam.x, camPos.z - this.vmLastCam.z) / Math.max(dt, 1e-3);
    }
    this.vmLastCam = { x: camPos.x, z: camPos.z };
    this.vmBob += dt * Math.min(spd, 9) * 1.6;
    const bobAmt = Math.min(spd, 8) * 0.004;
    this.vmRecoil *= Math.pow(0.0009, dt);
    if (this.vmRecoil < 0.01) this.vmRecoil = 0;
    this.vm.position.set(
      0.32 + Math.cos(this.vmBob) * bobAmt,
      -0.3 + Math.abs(Math.sin(this.vmBob)) * bobAmt - this.vmRecoil * 0.04,
      -0.62 + this.vmRecoil * 0.12
    );
    this.vm.rotation.x = this.vmRecoil * 0.5;
  }

  // ── 캐릭터 모델 ─────────────────────────────────────────────
  _makePlayer(id, name) {
    const color = hueColor(id);
    const dark = color.clone().multiplyScalar(0.6);
    const mat = new THREE.MeshLambertMaterial({ color });
    const matD = new THREE.MeshLambertMaterial({ color: dark });
    const root = new THREE.Group();
    const head = box(0.42, 0.42, 0.42, mat); head.position.y = 1.49;
    const torso = box(0.42, 0.64, 0.21, matD); torso.position.y = 0.96;
    const armL = limb(0.21, 0.64, 0.21, mat); armL.position.set(-0.32, 1.27, 0);
    const armR = limb(0.21, 0.64, 0.21, mat); armR.position.set(0.32, 1.27, 0);
    const legL = limb(0.21, 0.64, 0.21, matD); legL.position.set(-0.11, 0.64, 0);
    const legR = limb(0.21, 0.64, 0.21, matD); legR.position.set(0.11, 0.64, 0);
    const label = nameSprite(name);
    root.add(head, torso, armL, armR, legL, legR, label);
    this.scene.add(root);
    const rec = { root, head, torso, armL, armR, legL, legR, mat, matD, color,
      phase: 0, lastPos: null, flash: 0, deadLean: 0 };
    this.players.set(id, rec);
    return rec;
  }

  _animatePlayer(rec, p, dt) {
    const horiz = rec.lastPos
      ? Math.hypot(p.x - rec.lastPos.x, p.z - rec.lastPos.z) / Math.max(dt, 1e-3)
      : 0;
    rec.lastPos = { x: p.x, z: p.z };
    const airborne = p.y > 0.28;
    if (airborne) {
      rec.legL.rotation.x = lerp(rec.legL.rotation.x, 0.5, 0.25);
      rec.legR.rotation.x = lerp(rec.legR.rotation.x, 0.5, 0.25);
      rec.armL.rotation.x = lerp(rec.armL.rotation.x, -2.4, 0.25);
      rec.armR.rotation.x = lerp(rec.armR.rotation.x, -2.4, 0.25);
      rec.torso.position.y = 0.96;
    } else if (horiz > 1.2) {
      rec.phase += dt * Math.min(horiz, 9) * 1.7;
      const amp = Math.min(0.35 + horiz * 0.05, 0.95);
      const sw = Math.sin(rec.phase) * amp;
      rec.legL.rotation.x = sw;
      rec.legR.rotation.x = -sw;
      rec.armL.rotation.x = -sw;
      rec.armR.rotation.x = sw;
      rec.torso.position.y = 0.96;
    } else {
      rec.phase += dt * 2;
      const b = Math.sin(rec.phase) * 0.06;
      rec.legL.rotation.x = lerp(rec.legL.rotation.x, 0, 0.2);
      rec.legR.rotation.x = lerp(rec.legR.rotation.x, 0, 0.2);
      rec.armL.rotation.x = lerp(rec.armL.rotation.x, b, 0.2);
      rec.armR.rotation.x = lerp(rec.armR.rotation.x, -b, 0.2);
      rec.torso.position.y = 0.96 + Math.abs(b) * 0.25;
    }
    if (rec.flash > 0) {
      rec.flash = Math.max(0, rec.flash - dt);
      const e = rec.flash / 0.2;
      rec.mat.emissive.setRGB(e, 0, 0);
      rec.matD.emissive.setRGB(e, 0, 0);
    }
  }

  syncPlayers(list, selfId, dt) {
    const seen = this._seen;
    seen.clear();
    for (const p of list) {
      seen.add(p.id);
      let rec = this.players.get(p.id);
      if (!rec) rec = this._makePlayer(p.id, p.name);
      if (p.id === selfId) { rec.root.visible = false; continue; }
      rec.root.visible = true;
      rec.root.position.set(p.x, p.y, p.z);
      const targetLean = p.alive ? 0 : 1;
      rec.deadLean = lerp(rec.deadLean, targetLean, 0.18);
      rec.root.rotation.y = p.yaw;
      rec.root.rotation.x = rec.deadLean * 1.4;
      this._animatePlayer(rec, p, dt);
      rec.head.rotation.x = -p.pitch * 0.6;
    }
    for (const [id, rec] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(rec.root);
        // 지오메트리·머티리얼·캔버스 텍스처(닉네임 스프라이트)까지 모두 해제
        rec.root.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          const m = o.material;
          if (m) {
            if (m.map) m.map.dispose();
            m.dispose();
          }
        });
        this.players.delete(id);
      }
    }
  }

  flashPlayer(id) {
    const rec = this.players.get(id);
    if (rec) rec.flash = 0.2;
  }

  // ── 투사체 (풀링) ───────────────────────────────────────────
  _projAsset(ptype) {
    let a = this._projAssets[ptype];
    if (a) return a;
    let geo, mat;
    if (ptype === 'disc') {
      geo = new THREE.CylinderGeometry(0.4, 0.4, 0.14, 20);
      mat = new THREE.MeshLambertMaterial({ color: 0xffd23f });
    } else if (ptype === 'pushball') {
      geo = new THREE.SphereGeometry(0.8, 16, 12);
      mat = new THREE.MeshLambertMaterial({ color: 0x4fc3f7 });
    } else if (ptype === 'ironball') {
      geo = new THREE.SphereGeometry(0.16, 12, 10);
      mat = new THREE.MeshStandardMaterial({ color: 0x9aa6b4, metalness: 0.9, roughness: 0.3 });
    } else if (ptype === 'bearing') {
      geo = new THREE.SphereGeometry(0.14, 10, 8);
      mat = new THREE.MeshStandardMaterial({ color: 0xdfe6ef, metalness: 0.9, roughness: 0.25 });
    } else if (ptype === 'pencil') {
      geo = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8); geo.rotateX(Math.PI / 2);
      mat = new THREE.MeshLambertMaterial({ color: 0xf4c542 });
    } else if (ptype === 'arrow') {
      geo = new THREE.CylinderGeometry(0.045, 0.045, 0.7, 8); geo.rotateX(Math.PI / 2);
      mat = new THREE.MeshLambertMaterial({ color: 0xd9b38c });
    } else if (ptype === 'eraser') {
      geo = new THREE.BoxGeometry(1.8, 1.05, 2.2);
      mat = new THREE.MeshLambertMaterial({ color: 0xff9ec4 });
    } else if (ptype === 'stickybomb') {
      geo = new THREE.SphereGeometry(0.3, 12, 10);
      mat = new THREE.MeshStandardMaterial({ color: 0x2e3340, emissive: 0x661111, roughness: 0.6 });
    } else {
      geo = new THREE.SphereGeometry(0.2, 10, 8);
      mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    }
    a = { geo, mat };
    this._projAssets[ptype] = a;
    return a;
  }

  _acquireProj(ptype) {
    const free = this._projFree[ptype];
    if (free && free.length) {
      const r = free.pop();
      r.mesh.visible = true;
      return r;
    }
    const a = this._projAsset(ptype);
    // 점착폭탄만 매 프레임 emissive를 변조하므로 인스턴스별 머티리얼이 필요.
    // (공유했더니 여러 폭탄이 마지막 한 개 기준으로 동기 깜빡임)
    const mat = ptype === 'stickybomb' ? a.mat.clone() : a.mat;
    const mesh = new THREE.Mesh(a.geo, mat);
    mesh.castShadow = false;
    this.scene.add(mesh);
    return { mesh, ptype, spinAngle: Math.random() * 6.28, blink: 0 };
  }

  _releaseProj(rec) {
    rec.mesh.visible = false;
    rec.mesh.scale.setScalar(1);
    let free = this._projFree[rec.ptype];
    if (!free) free = this._projFree[rec.ptype] = [];
    free.push(rec);
  }

  syncProjectiles(list, dt) {
    const seen = this._seen;
    seen.clear();
    for (const pr of list) {
      seen.add(pr.id);
      let rec = this.projectiles.get(pr.id);
      if (!rec || rec.ptype !== pr.ptype) {
        if (rec) this._releaseProj(rec);
        rec = this._acquireProj(pr.ptype);
        this.projectiles.set(pr.id, rec);
      }
      const m = rec.mesh;
      m.position.set(pr.x, pr.y, pr.z);
      rec.spinAngle += (pr.spin || 8) * dt;
      if (pr.ptype === 'disc') {
        const fx = pr.vx, fz = pr.vz;
        const flat = (fx * fx + fz * fz < 1e-4)
          ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(fx, 0, fz);
        const axis = new THREE.Vector3().crossVectors(UP, flat).normalize();
        m.quaternion.setFromUnitVectors(UP, axis);
        m.rotateY(rec.spinAngle);
      } else if (pr.ptype === 'pencil' || pr.ptype === 'arrow') {
        const v = new THREE.Vector3(pr.vx, pr.vy, pr.vz);
        if (v.lengthSq() > 1e-4) {
          m.quaternion.setFromUnitVectors(FWD, v.normalize());
          if (pr.ptype === 'pencil') m.rotateZ(rec.spinAngle);
        }
      } else if (pr.ptype === 'eraser') {
        m.scale.setScalar(pr.radius || 0.3);
        m.rotation.set(0, rec.spinAngle * 0.4, rec.spinAngle * 0.25);
      } else if (pr.ptype === 'stickybomb') {
        rec.blink += dt * (pr.state === 'stuck' ? 14 : 5);
        const e = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(rec.blink));
        m.material.emissive.setRGB(e * 0.7, e * 0.1, e * 0.1);
        m.rotation.y = rec.spinAngle;
      } else {
        m.rotation.set(rec.spinAngle * 0.6, rec.spinAngle, 0);
      }
    }
    for (const [id, rec] of this.projectiles) {
      if (!seen.has(id)) {
        this._releaseProj(rec);
        this.projectiles.delete(id);
      }
    }
  }

  // ── 연출 효과 (공유 지오메트리 + 상한) ─────────────────────
  burst(pos, color, scale) {
    if (this.effects.length > this.FX_CAP) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(this._fx.ico, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    const scene = this.scene;
    this.effects.push({
      mesh, life: 0, max: 0.35,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(scale * (0.4 + k * 2.6));
        mat.opacity = 0.9 * (1 - k);
      },
      dispose() { scene.remove(mesh); mat.dispose(); }
    });
  }

  ring(pos, radius, color) {
    if (this.effects.length > this.FX_CAP) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(this._fx.ring, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.1, pos.z);
    this.scene.add(mesh);
    const scene = this.scene;
    this.effects.push({
      mesh, life: 0, max: 0.55,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(radius * k);
        mat.opacity = 0.85 * (1 - k);
      },
      dispose() { scene.remove(mesh); mat.dispose(); }
    });
  }

  explosion(pos, radius) {
    this.ring(pos, radius, 0xffae42);
    this.debris(pos, 0xffae42, 12);
    if (this.effects.length > this.FX_CAP) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(this._fx.sphere, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    const scene = this.scene;
    this.effects.push({
      mesh, life: 0, max: 0.45,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(0.3 + k * radius);
        mat.opacity = 0.95 * (1 - k);
      },
      dispose() { scene.remove(mesh); mat.dispose(); }
    });
  }

  debris(pos, color, count) {
    if (this.effects.length > this.FX_CAP) return;
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const parts = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this._fx.cube, mat);
      m.position.set(pos.x, pos.y + 0.2, pos.z);
      const a = Math.random() * 6.283, sp = 2.5 + Math.random() * 5;
      m.userData.v = { x: Math.cos(a) * sp, y: 2.5 + Math.random() * 4, z: Math.sin(a) * sp };
      group.add(m);
      parts.push(m);
    }
    this.scene.add(group);
    const scene = this.scene;
    this.effects.push({
      mesh: group, life: 0, max: 0.7,
      update(t, dt) {
        for (const m of parts) {
          const v = m.userData.v;
          v.y -= 16 * dt;
          m.position.x += v.x * dt;
          m.position.y += v.y * dt;
          m.position.z += v.z * dt;
          if (m.position.y < 0.07) { m.position.y = 0.07; v.x *= 0.6; v.z *= 0.6; v.y *= -0.35; }
          m.rotation.x += dt * 8;
          m.rotation.y += dt * 6;
        }
        mat.opacity = Math.max(0, 1 - t / 0.7);
      },
      dispose() { scene.remove(group); mat.dispose(); }
    });
  }

  shake(amt) { this.shakeAmt = Math.min(1.4, this.shakeAmt + amt); }

  _updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life += dt;
      e.update(e.life, dt);
      if (e.life >= e.max) {
        e.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  render(camPos, yaw, pitch, dt) {
    this._updateEffects(dt);
    this.camera.position.set(camPos.x, camPos.y, camPos.z);
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = pitch;
    if (this.shakeAmt > 0.001) {
      const a = this.shakeAmt;
      this.camera.position.x += (Math.random() - 0.5) * a * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * a * 0.5;
      this.camera.rotation.z = (Math.random() - 0.5) * a * 0.06;
      this.shakeAmt *= Math.pow(0.0025, dt);
      if (this.shakeAmt < 0.01) this.shakeAmt = 0;
    } else {
      this.camera.rotation.z = 0;
    }
    this._updateViewmodel(camPos, dt);
    this.renderer.render(this.scene, this.camera);
  }
}
