/* render.js — Three.js 씬 / 엔티티 / 연출. v0.2.
 * 마인크래프트식 6파트 캐릭터 모델 + 파트 회전 애니메이션.
 * 서버는 수치만 시뮬, 메시·파티클·애니메이션은 전부 클라. */
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

// 관절(pivot) 그룹 — 메시를 아래로 h/2 내려 달아 그룹 회전 = 팔/다리 스윙
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b3a55);
    this.scene.fog = new THREE.Fog(0x2b3a55, 40, 95);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.1, 400);
    this.camera.rotation.order = 'YXZ';

    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x39402f, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
    sun.position.set(28, 46, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 42;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 130;
    sun.shadow.bias = -0.0014;
    this.scene.add(sun);

    this.players = new Map();
    this.projectiles = new Map();
    this.effects = [];
    this.shakeAmt = 0;

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

  // ── 1인칭 뷰모델 (무기) ─────────────────────────────────────
  _ensureViewmodel() {
    if (this.vm) return;
    this.scene.add(this.camera);          // 카메라 자식이 렌더되도록
    this.vm = new THREE.Group();
    this.vm.position.set(0.32, -0.3, -0.62);
    this.camera.add(this.vm);
    this.vmWeapon = null;
    this.vmRecoil = 0;
    this.vmBob = 0;
    this.vmLastCam = null;
    // 손 (간단한 박스)
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
    else { geo = new THREE.CylinderGeometry(0.13, 0.13, 0.05, 18); color = 0xffd23f; }  // disc
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    if (weaponId === 'pencil') mesh.rotation.x = Math.PI / 2;
    else if (weaponId === 'disc') mesh.rotation.x = Math.PI / 2;
    else if (weaponId === 'bow') mesh.rotation.y = Math.PI / 2;
    mesh.position.set(0, 0, -0.18);
    this.vm.add(mesh);
    this.vmWeapon = mesh;
  }

  viewmodelRecoil() { this.vmRecoil = Math.min(1, this.vmRecoil + 0.7); }

  _updateViewmodel(camPos, dt) {
    if (!this.vm) return;
    // 이동 보브
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

  // ── 캐릭터 모델 (마인크래프트식 6파트) ──────────────────────
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

    const rec = {
      root, head, torso, armL, armR, legL, legR, mat, matD, color,
      phase: 0, lastPos: null, flash: 0, deadLean: 0
    };
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

    // 피격 플래시
    if (rec.flash > 0) {
      rec.flash = Math.max(0, rec.flash - dt);
      const e = rec.flash / 0.2;
      rec.mat.emissive.setRGB(e, 0, 0);
      rec.matD.emissive.setRGB(e, 0, 0);
    }
  }

  syncPlayers(list, selfId, dt) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = this.players.get(p.id);
      if (!rec) rec = this._makePlayer(p.id, p.name);
      if (p.id === selfId) { rec.root.visible = false; continue; }
      rec.root.visible = true;
      rec.root.position.set(p.x, p.y, p.z);

      // 사망 시 쓰러짐
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
        rec.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
        this.players.delete(id);
      }
    }
  }

  flashPlayer(id) {
    const rec = this.players.get(id);
    if (rec) rec.flash = 0.2;
  }

  // ── 투사체 ──────────────────────────────────────────────────
  _makeProjectile(ptype) {
    let mesh;
    if (ptype === 'disc') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.14, 20),
        new THREE.MeshLambertMaterial({ color: 0xffd23f }));
    } else if (ptype === 'pushball') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.8, 18, 14),
        new THREE.MeshLambertMaterial({ color: 0x4fc3f7 }));
    } else if (ptype === 'ironball') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 14, 12),
        new THREE.MeshStandardMaterial({ color: 0x9aa6b4, metalness: 0.9, roughness: 0.3 }));
    } else if (ptype === 'bearing') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xdfe6ef, metalness: 0.9, roughness: 0.25 }));
    } else if (ptype === 'pencil') {
      const g = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8);
      g.rotateX(Math.PI / 2);  // 장축을 +Z로
      mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xf4c542 }));
    } else if (ptype === 'arrow') {
      const g = new THREE.CylinderGeometry(0.045, 0.045, 0.7, 8);
      g.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xd9b38c }));
    } else if (ptype === 'eraser') {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 1.05, 2.2),
        new THREE.MeshLambertMaterial({ color: 0xff9ec4 }));
    } else if (ptype === 'stickybomb') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 14, 12),
        new THREE.MeshStandardMaterial({ color: 0x2e3340, emissive: 0x661111, roughness: 0.6 }));
    } else {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 10),
        new THREE.MeshLambertMaterial({ color: 0xffffff }));
    }
    mesh.castShadow = true;
    this.scene.add(mesh);
    return { mesh, ptype, spinAngle: Math.random() * 6.28, blink: 0 };
  }

  syncProjectiles(list, dt) {
    const seen = new Set();
    for (const pr of list) {
      seen.add(pr.id);
      let rec = this.projectiles.get(pr.id);
      if (!rec) { rec = this._makeProjectile(pr.ptype); this.projectiles.set(pr.id, rec); }
      rec.mesh.position.set(pr.x, pr.y, pr.z);
      rec.spinAngle += (pr.spin || 8) * dt;
      const flat = new THREE.Vector3(pr.vx, 0, pr.vz);
      const vel = new THREE.Vector3(pr.vx, pr.vy, pr.vz);

      if (pr.ptype === 'disc') {
        if (flat.lengthSq() < 1e-4) flat.set(1, 0, 0);
        const axis = new THREE.Vector3().crossVectors(UP, flat).normalize();
        rec.mesh.quaternion.setFromUnitVectors(UP, axis);
        rec.mesh.rotateY(rec.spinAngle);
      } else if (pr.ptype === 'pencil' || pr.ptype === 'arrow') {
        if (vel.lengthSq() > 1e-4) {
          rec.mesh.quaternion.setFromUnitVectors(FWD, vel.normalize());
          if (pr.ptype === 'pencil') rec.mesh.rotateZ(rec.spinAngle);
        }
      } else if (pr.ptype === 'eraser') {
        rec.mesh.scale.setScalar(pr.radius || 0.3);
        rec.mesh.rotation.y = rec.spinAngle * 0.4;
        rec.mesh.rotation.z = rec.spinAngle * 0.25;
      } else if (pr.ptype === 'stickybomb') {
        rec.blink += dt * (pr.state === 'stuck' ? 14 : 5);
        const e = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(rec.blink));
        rec.mesh.material.emissive.setRGB(e * 0.7, e * 0.1, e * 0.1);
        rec.mesh.rotation.y = rec.spinAngle;
      } else {
        rec.mesh.rotation.y = rec.spinAngle;
        rec.mesh.rotation.x = rec.spinAngle * 0.6;
      }
    }
    for (const [id, rec] of this.projectiles) {
      if (!seen.has(id)) {
        this.scene.remove(rec.mesh);
        rec.mesh.geometry.dispose();
        this.projectiles.delete(id);
      }
    }
  }

  // ── 연출 효과 ───────────────────────────────────────────────
  burst(pos, color, scale) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    this.effects.push({
      mesh, life: 0, max: 0.35,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(scale * (0.4 + k * 2.6));
        mat.opacity = 0.9 * (1 - k);
      }
    });
  }

  ring(pos, radius, color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.1, pos.z);
    this.scene.add(mesh);
    this.effects.push({
      mesh, life: 0, max: 0.55,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(radius * k);
        mat.opacity = 0.85 * (1 - k);
      }
    });
  }

  explosion(pos, radius) {
    this.ring(pos, radius, 0xffae42);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7733, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    this.effects.push({
      mesh, life: 0, max: 0.45,
      update(t) {
        const k = t / this.max;
        mesh.scale.setScalar(0.3 + k * radius);
        mat.opacity = 0.95 * (1 - k);
      }
    });
    this.debris(pos, 0xffae42, 14);
  }

  debris(pos, color, count) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const parts = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), mat);
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
      dispose() {
        scene.remove(group);
        for (const m of parts) m.geometry.dispose();
        mat.dispose();
      }
    });
  }

  shake(amt) { this.shakeAmt = Math.min(1.4, this.shakeAmt + amt); }

  _updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life += dt;
      e.update(e.life, dt);
      if (e.life >= e.max) {
        if (e.dispose) {
          e.dispose();
        } else {
          this.scene.remove(e.mesh);
          e.mesh.geometry.dispose();
          e.mesh.material.dispose();
        }
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
