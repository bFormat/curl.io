/* render.js — Three.js 씬 / 엔티티 메시 관리 / 연출 효과.
 * 서버는 수치만 시뮬, 메시·파티클·연출은 전부 여기. */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

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
  spr.position.y = 2.25;
  return spr;
}

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

    this.players = new Map();      // id → {group, body, nose, label, color}
    this.projectiles = new Map();  // id → {mesh, type, spinAngle}
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
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x46603f });
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.half * 2 + 8, map.half * 2 + 8),
      groundMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(map.half * 2, map.half, 0x5a7350, 0x3c5237);
    grid.position.y = 0.02;
    this.scene.add(grid);

    map.obstacles.forEach((b, i) => {
      const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
      const isWall = i < 4;
      const mat = new THREE.MeshLambertMaterial({ color: isWall ? 0x3a4661 : 0xc06b4f });
      const box = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      box.position.set(
        (b.min.x + b.max.x) / 2,
        (b.min.y + b.max.y) / 2,
        (b.min.z + b.max.z) / 2
      );
      box.castShadow = true;
      box.receiveShadow = true;
      this.scene.add(box);
    });
  }

  // ── 플레이어 ────────────────────────────────────────────────
  _makePlayer(id, name) {
    const color = hueColor(id);
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 0.9, 4, 12),
      new THREE.MeshLambertMaterial({ color })
    );
    body.position.y = 0.85;
    body.castShadow = true;
    group.add(body);
    // 시선 방향 표시
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x11161f })
    );
    nose.position.set(0, 1.15, -0.42);
    group.add(nose);
    const label = nameSprite(name);
    group.add(label);
    this.scene.add(group);
    const rec = { group, body, nose, label, color };
    this.players.set(id, rec);
    return rec;
  }

  syncPlayers(list, selfId) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = this.players.get(p.id);
      if (!rec) rec = this._makePlayer(p.id, p.name);
      if (p.id === selfId) { rec.group.visible = false; continue; }
      rec.group.visible = p.alive;
      rec.group.position.set(p.x, p.y, p.z);
      rec.group.rotation.y = p.yaw;
      rec.nose.rotation.x = -p.pitch;
    }
    for (const [id, rec] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(rec.group);
        rec.body.geometry.dispose();
        this.players.delete(id);
      }
    }
  }

  // ── 투사체 ──────────────────────────────────────────────────
  _makeProjectile(type) {
    let mesh;
    if (type === 'disc') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.25, 0.12, 18),
        new THREE.MeshLambertMaterial({ color: 0xffd23f })
      );
    } else if (type === 'pushball') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 18, 14),
        new THREE.MeshLambertMaterial({ color: 0x4fc3f7 })
      );
    } else {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xdfe6ef, metalness: 0.9, roughness: 0.25 })
      );
    }
    mesh.castShadow = true;
    this.scene.add(mesh);
    return { mesh, type, spinAngle: Math.random() * 6.28 };
  }

  syncProjectiles(list, dt) {
    const seen = new Set();
    for (const pr of list) {
      seen.add(pr.id);
      let rec = this.projectiles.get(pr.id);
      if (!rec) { rec = this._makeProjectile(pr.type); this.projectiles.set(pr.id, rec); }
      rec.mesh.position.set(pr.x, pr.y, pr.z);
      rec.spinAngle += (pr.spin || 8) * dt;
      const v = new THREE.Vector3(pr.vx, pr.vy, pr.vz);
      if (pr.type === 'disc') {
        // 진행 방향에 수직인 수평축으로 굴림
        const flat = new THREE.Vector3(pr.vx, 0, pr.vz);
        if (flat.lengthSq() < 1e-4) flat.set(1, 0, 0);
        const rollAxis = new THREE.Vector3().crossVectors(UP, flat).normalize();
        rec.mesh.quaternion.setFromUnitVectors(UP, rollAxis);
        rec.mesh.rotateY(rec.spinAngle);
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
        const sc = scale * (0.4 + k * 2.6);
        mesh.scale.setScalar(sc);
        mat.opacity = 0.9 * (1 - k);
      }
    });
  }

  ring(pos, radius, color) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide
    });
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

  // 중력 받는 파편 조각들
  debris(pos, color, count) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const parts = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), mat);
      m.position.set(pos.x, pos.y + 0.2, pos.z);
      const a = Math.random() * 6.283, sp = 2.5 + Math.random() * 4.5;
      m.userData.v = { x: Math.cos(a) * sp, y: 2.5 + Math.random() * 3.5, z: Math.sin(a) * sp };
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

  shake(amt) { this.shakeAmt = Math.min(1.2, this.shakeAmt + amt); }

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

  // ── 카메라 + 렌더 ───────────────────────────────────────────
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
    this.renderer.render(this.scene, this.camera);
  }
}
