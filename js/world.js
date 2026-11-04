// Builds the visible world for a map: terrain, park features, scenery, sky, particles.
import * as THREE from '../lib/three.module.min.js';

const V3 = THREE.Vector3;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function snowTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const r = rng(7);
  for (let i = 0; i < S * S; i++) {
    const y = (i / S) | 0;
    // corduroy grooming lines + speckle
    const cord = 0.035 * Math.sin(y * Math.PI * 2 / 6);
    const v = 0.93 + cord + (r() - 0.5) * 0.06;
    const c = Math.max(0, Math.min(255, v * 255));
    img.data[i * 4] = c * 0.97; img.data[i * 4 + 1] = c * 0.985; img.data[i * 4 + 2] = c; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function bannerTexture(text, bg, fg) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 128);
  g.fillStyle = fg;
  g.font = 'bold 84px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  constructor(scene, map, quality) {
    this.scene = scene;
    this.map = map;
    this.quality = quality;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.buildSky();
    this.buildLights();
    this.buildTerrain();
    this.buildFeatures();
    this.buildScenery();
    this.buildSnowfall();
    this.buildSpray();
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    });
    this.scene.fog = null;
  }

  // ------------------------------------------------------------------ sky
  buildSky() {
    const horizon = new THREE.Color(0xcfe3f5);
    this.scene.fog = new THREE.Fog(horizon, 160, 900);
    this.scene.background = horizon;
    const geo = new THREE.SphereGeometry(2500, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: new V3(0.4, 0.55, -0.7).normalize() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
        void main(){
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 top = vec3(0.16, 0.38, 0.78);
          vec3 hor = vec3(0.80, 0.89, 0.96);
          vec3 c = mix(hor, top, pow(max(h,0.0), 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0,0.92,0.75) * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, m);
    this.sky.renderOrder = -1;
    this.group.add(this.sky);
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8aa0b8, 1.15);
    this.group.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    this.sunOffset = new V3(40, 70, -55);
    sun.castShadow = this.quality > 0;
    const sz = this.quality > 1 ? 2048 : 1024;
    sun.shadow.mapSize.set(sz, sz);
    const c = sun.shadow.camera;
    c.left = -32; c.right = 32; c.top = 32; c.bottom = -32; c.near = 1; c.far = 220;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this.group.add(sun);
    this.group.add(sun.target);
  }

  // ------------------------------------------------------------------ terrain
  buildTerrain() {
    const m = this.map;
    const xs = m.xs, zs = m.zs;
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    const nor = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    const col = new Float32Array(nx * nz * 3);
    const n = { x: 0, y: 1, z: 0 };
    let i = 0;
    for (let j = 0; j < nz; j++) {
      const z = zs[j];
      for (let k = 0; k < nx; k++) {
        const x = xs[k];
        const y = m.H(x, z);
        m.normal(x, z, n);
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z;
        uv[i * 2] = x / 3; uv[i * 2 + 1] = z / 3;
        // steeper faces get a faint blue cast so features read well
        const steep = Math.min(1, Math.max(0, (0.97 - n.y) * 2.2));
        const off = Math.abs(x) > m.halfWidth + 2 ? 0.04 : 0;
        col[i * 3] = 1 - steep * 0.13 - off; col[i * 3 + 1] = 1 - steep * 0.07 - off * 0.5; col[i * 3 + 2] = 1;
        i++;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let t = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let k = 0; k < nx - 1; k++) {
        const a = j * nx + k, b = a + 1, c = a + nx, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const tex = snowTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.92, metalness: 0, color: 0xffffff });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // distant snowfield beneath / around everything
    const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0xe9f0f8, roughness: 1 }));
    far.rotation.x = -Math.PI / 2;
    const zMid = (zs[0] + zs[nz - 1]) / 2;
    let lowY = Infinity;
    for (let j = 0; j < nz; j += 4) lowY = Math.min(lowY, m.H(0, zs[j]));
    far.position.set(0, lowY - 25, zMid);
    this.lowGround = far;
    this.group.add(far);
  }

  // ------------------------------------------------------------------ park features
  buildFeatures() {
    const m = this.map;
    const blue = new THREE.MeshStandardMaterial({ color: 0x1f6fff, roughness: 0.6 });
    // lip lines
    for (const L of m.lips) {
      const w = L.angle > 60 ? m.halfWidth * 1.4 : L.w;
      const seg = 24;
      for (let i = 0; i < seg; i++) {
        const x0 = L.x - w / 2 + (w * (i + 0.5)) / seg;
        const y = m.H(x0, L.z + 0.25);
        const box = new THREE.Mesh(new THREE.BoxGeometry(w / seg, 0.03, 0.25), blue);
        box.position.set(x0, y + 0.01, L.z + 0.18);
        this.group.add(box);
      }
    }
    // dye lines along the landings & transitions of jumps
    // rails & boxes
    const metal = new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.25, metalness: 0.9 });
    const post = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.6 });
    const boxTop = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.3 });
    const boxSide = new THREE.MeshStandardMaterial({ color: 0xff3d6e, roughness: 0.6 });
    const up = new V3(0, 1, 0);
    for (const r of m.rails) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const A = new V3(r.pts[i].x, r.pts[i].y, r.pts[i].z);
        const B = new V3(r.pts[i + 1].x, r.pts[i + 1].y, r.pts[i + 1].z);
        const d = new V3().subVectors(B, A);
        const len = d.length();
        const mid = new V3().addVectors(A, B).multiplyScalar(0.5);
        if (r.type === 'rail') {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len + 0.02, 12), metal);
          c.position.copy(mid);
          c.quaternion.setFromUnitVectors(up, d.clone().normalize());
          c.castShadow = true;
          this.group.add(c);
        } else {
          const bx = new THREE.Mesh(new THREE.BoxGeometry(r.width, 0.1, len + 0.02), [boxSide, boxSide, boxTop, boxSide, boxSide, boxSide]);
          bx.position.copy(mid).y -= 0.05;
          bx.lookAt(mid.clone().add(d));
          bx.position.y = mid.y - 0.05;
          bx.castShadow = true; bx.receiveShadow = true;
          this.group.add(bx);
          // box body down to the snow
          const hA = A.y - m.H(A.x, A.z), hB = B.y - m.H(B.x, B.z);
          const hh = Math.max(hA, hB);
          if (hh > 0.12) {
            const body = new THREE.Mesh(new THREE.BoxGeometry(r.width * 0.92, hh, len), boxSide);
            body.position.copy(mid); body.position.y = mid.y - 0.1 - hh / 2 + 0.05;
            body.lookAt(new V3(B.x, body.position.y, B.z));
            body.castShadow = true;
            this.group.add(body);
          }
        }
        // supports
        if (r.type === 'rail' && r.supports) {
          const nSup = Math.max(1, Math.round(len / 3.5));
          for (let k = 0; k <= nSup; k++) {
            if (k === 0 && i > 0) continue;
            const p = new V3().lerpVectors(A, B, k / nSup);
            const g = m.H(p.x, p.z);
            const h = p.y - g;
            if (h < 0.05) continue;
            const s = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, h, 8), post);
            s.position.set(p.x, g + h / 2, p.z);
            s.castShadow = true;
            this.group.add(s);
            const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.3), post);
            foot.position.set(p.x, g + 0.02, p.z);
            this.group.add(foot);
          }
        }
      }
    }
    // pipe coping stripes
    if (m.pipe) {
      const P = m.pipe;
      const red = new THREE.MeshStandardMaterial({ color: 0xff3b30, roughness: 0.6 });
      for (const side of [-1, 1]) {
        const pts = [];
        for (let s = 2; s <= P.len - 2; s += 2) {
          const x = side * (P.wallStart + 0.05);
          pts.push(new V3(x, m.H(x + side * 0.2, -s) + 0.02, -s));
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, 0.06, 6, false), red);
        this.group.add(tube);
      }
    }
    this.buildStartGate();
  }

  buildStartGate() {
    const m = this.map;
    const s = m.spawn.s - 3;
    const z = -s;
    const y = m.H(0, z);
    const w = m.pipe ? (m.pipe.wallStart + 2) * 2 : Math.min(18, m.halfWidth);
    const postM = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.5 });
    for (const sx of [-1, 1]) {
      const x = sx * w / 2;
      const gy = m.H(x, z);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6 + (y - gy) + 4, 0.4), postM);
      p.position.set(x, gy + (6 + (y - gy) + 4) / 2 - 2, z);
      p.castShadow = true;
      this.group.add(p);
    }
    const tex = bannerTexture('FROSTLINE  ·  ' + m.name.toUpperCase(), '#0b1f3a', '#ffffff');
    const ban = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, 0.15), [null, null, null, null, new THREE.MeshBasicMaterial({ map: tex }), new THREE.MeshBasicMaterial({ map: tex })].map((x) => x || postM));
    ban.position.set(0, y + 6.5 + (m.pipe ? m.pipe.wallH : 0), z);
    this.group.add(ban);
  }

  // ------------------------------------------------------------------ scenery
  buildScenery() {
    const m = this.map;
    const r = rng(42 + m.id.length);
    // pine trees
    const trunkG = new THREE.CylinderGeometry(0.15, 0.22, 1.6, 6);
    trunkG.translate(0, 0.8, 0);
    const coneG = new THREE.ConeGeometry(1, 1, 8);
    const leafM = new THREE.MeshStandardMaterial({ color: 0x1d4a34, roughness: 0.9, flatShading: true });
    const snowM = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.9, flatShading: true });
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 });
    const N = this.quality > 1 ? 1400 : this.quality > 0 ? 900 : 500;
    const trunks = new THREE.InstancedMesh(trunkG, trunkM, N);
    const leaves = new THREE.InstancedMesh(coneG, leafM, N * 3);
    const caps = new THREE.InstancedMesh(coneG, snowM, N);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new V3(), P = new V3();
    const s0 = m.sRange[0], s1 = m.sRange[1];
    let count = 0;
    for (let i = 0; i < N * 4 && count < N; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side * (m.halfWidth + 6 + Math.pow(r(), 1.4) * 115);
      const s = s0 - 40 + r() * (s1 - s0 + 80);
      const z = -s;
      if (m.pipe && Math.abs(x) < m.pipe.wallStart + 14) continue;
      const y = m.H(x, z);
      const h = 5 + r() * 9;
      Q.setFromAxisAngle(new V3(0, 1, 0), r() * 6.28);
      M.compose(P.set(x, y - 0.3, z), Q, S.set(1, h / 10, 1));
      trunks.setMatrixAt(count, M);
      for (let k = 0; k < 3; k++) {
        const rad = (h * 0.28) * (1 - k * 0.24);
        const ch = h * 0.42;
        M.compose(P.set(x, y + 1.2 + k * h * 0.22 + ch / 2, z), Q, S.set(rad, ch, rad));
        leaves.setMatrixAt(count * 3 + k, M);
      }
      const rad = h * 0.28 * 0.42;
      M.compose(P.set(x, y + 1.2 + 2 * h * 0.22 + h * 0.42 * 0.62, z), Q, S.set(rad, h * 0.2, rad));
      caps.setMatrixAt(count, M);
      count++;
    }
    trunks.count = count; leaves.count = count * 3; caps.count = count;
    for (const im of [trunks, leaves, caps]) { im.castShadow = this.quality > 1; im.instanceMatrix.needsUpdate = true; this.group.add(im); }

    // distant mountains
    const mtnM = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
    const zMid = -(s0 + s1) / 2;
    const yMid = m.H(0, zMid);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + r() * 0.2;
      const d = 900 + r() * 600;
      const h = 220 + r() * 420;
      const rad = 260 + r() * 260;
      const g = new THREE.ConeGeometry(rad, h, 7 + ((r() * 4) | 0), 4);
      const p = g.attributes.position;
      const c = new Float32Array(p.count * 3);
      for (let k = 0; k < p.count; k++) {
        const yy = p.getY(k) / h + 0.5;
        p.setX(k, p.getX(k) * (0.85 + r() * 0.3));
        p.setZ(k, p.getZ(k) * (0.85 + r() * 0.3));
        const snow = yy > 0.45 + r() * 0.15;
        const col = snow ? [0.94, 0.96, 1] : [0.45, 0.52, 0.62];
        c[k * 3] = col[0]; c[k * 3 + 1] = col[1]; c[k * 3 + 2] = col[2];
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mtnM);
      mesh.position.set(Math.cos(a) * d, yMid + h / 2 - 120, zMid + Math.sin(a) * d);
      this.group.add(mesh);
    }

    // course fences (orange netting)
    if (!m.pipe) {
      const fenceM = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.8, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      for (const side of [-1, 1]) {
        const x = side * (m.halfWidth + 1);
        const pts = [];
        for (let s = s0 + 5; s < s1 - 5; s += 2) pts.push([x, -s]);
        const pos = new Float32Array(pts.length * 2 * 3);
        const idx = [];
        pts.forEach(([px, pz], i) => {
          const y = m.H(px, pz);
          pos.set([px, y + 0.15, pz, px, y + 1.1, pz], i * 6);
          if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        this.group.add(new THREE.Mesh(g, fenceM));
      }
    }

    // flags marking the jumps
    const flagCols = [0xff3b30, 0x1f6fff, 0xffd60a, 0x34c759];
    for (const L of m.lips) {
      if (L.angle > 60) continue;
      for (const sx of [-1, 1]) {
        const x = L.x + sx * (L.w / 2 + 2.5);
        const z = L.z + 2;
        const y = m.H(x, z);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
        pole.position.set(x, y + 1.2, z);
        this.group.add(pole);
        const fl = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshStandardMaterial({ color: flagCols[(r() * 4) | 0], side: THREE.DoubleSide }));
        fl.position.set(x + sx * 0.4, y + 2.15, z);
        this.group.add(fl);
      }
    }
  }

  // ------------------------------------------------------------------ particles
  buildSnowfall() {
    const N = this.quality > 0 ? 2500 : 1000;
    const pos = new Float32Array(N * 3);
    const r = rng(3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (r() - 0.5) * 80; pos[i * 3 + 1] = r() * 40; pos[i * 3 + 2] = (r() - 0.5) * 80; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.8, depthWrite: false });
    this.snow = new THREE.Points(g, m);
    this.snow.frustumCulled = false;
    this.group.add(this.snow);
  }

  buildSpray() {
    const N = 600;
    this.sprayN = N;
    this.sprayPos = new Float32Array(N * 3);
    this.sprayVel = new Float32Array(N * 3);
    this.sprayLife = new Float32Array(N);
    this.sprayIdx = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sprayPos, 3));
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const c = cv.getContext('2d');
    const grd = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = grd; c.fillRect(0, 0, 32, 32);
    const m = new THREE.PointsMaterial({ size: 0.35, map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.9 });
    this.spray = new THREE.Points(g, m);
    this.spray.frustumCulled = false;
    for (let i = 0; i < N; i++) this.sprayPos[i * 3 + 1] = -1e5;
    this.group.add(this.spray);
  }

  emitSpray(p, v, count, spread) {
    for (let k = 0; k < count; k++) {
      const i = this.sprayIdx;
      this.sprayIdx = (i + 1) % this.sprayN;
      this.sprayPos[i * 3] = p.x + (Math.random() - 0.5) * 0.4;
      this.sprayPos[i * 3 + 1] = p.y + 0.05;
      this.sprayPos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.4;
      this.sprayVel[i * 3] = v.x + (Math.random() - 0.5) * spread;
      this.sprayVel[i * 3 + 1] = v.y + Math.random() * spread * 0.8;
      this.sprayVel[i * 3 + 2] = v.z + (Math.random() - 0.5) * spread;
      this.sprayLife[i] = 0.5 + Math.random() * 0.5;
    }
  }

  update(dt, focus, camera) {
    // keep shadow camera around the rider
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(camera.position);
    this.lowGround.position.x = camera.position.x;
    // snowfall wraps around the camera
    const p = this.snow.geometry.attributes.position;
    const a = p.array;
    for (let i = 0; i < p.count; i++) {
      a[i * 3 + 1] -= dt * 1.2;
      a[i * 3] += Math.sin(i + performance.now() * 0.0005) * dt * 0.3;
      let x = a[i * 3] - camera.position.x, y = a[i * 3 + 1] - camera.position.y, z = a[i * 3 + 2] - camera.position.z;
      if (y < -15) y += 40; if (y > 25) y -= 40;
      if (x < -40) x += 80; if (x > 40) x -= 80;
      if (z < -40) z += 80; if (z > 40) z -= 80;
      a[i * 3] = x + camera.position.x; a[i * 3 + 1] = y + camera.position.y; a[i * 3 + 2] = z + camera.position.z;
    }
    p.needsUpdate = true;
    // spray
    const sp = this.sprayPos, sv = this.sprayVel, sl = this.sprayLife;
    for (let i = 0; i < this.sprayN; i++) {
      if (sl[i] <= 0) continue;
      sl[i] -= dt;
      if (sl[i] <= 0) { sp[i * 3 + 1] = -1e5; continue; }
      sv[i * 3 + 1] -= 6 * dt;
      const drag = Math.exp(-dt * 2.5);
      sv[i * 3] *= drag; sv[i * 3 + 2] *= drag;
      sp[i * 3] += sv[i * 3] * dt; sp[i * 3 + 1] += sv[i * 3 + 1] * dt; sp[i * 3 + 2] += sv[i * 3 + 2] * dt;
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
  }
}
