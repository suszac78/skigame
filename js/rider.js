// Procedural rider model (original design) with simple IK posing.
import * as THREE from '../lib/three.module.min.js';

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

function mat(color, rough = 0.7, metal = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

// cylinder with unit height, centered, aligned to Y; placed between two points
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
function limb(material, r) {
  const m = new THREE.Mesh(unitCyl, material);
  m.userData.r = r;
  m.castShadow = true;
  return m;
}
const _d = new V3();
function placeLimb(m, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.scale.set(m.userData.r, len, m.userData.r);
  if (len > 1e-5) m.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
}

// two-bone IK: returns joint position given root a, target t, lengths, bend hint
function ik(a, t, l1, l2, hint, outJoint, outEnd) {
  const d = new V3().subVectors(t, a);
  let dist = d.length();
  const maxR = (l1 + l2) * 0.999;
  if (dist > maxR) { d.multiplyScalar(maxR / dist); dist = maxR; }
  outEnd.copy(a).add(d);
  const dir = d.clone().divideScalar(Math.max(dist, 1e-5));
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const side = hint.clone().addScaledVector(dir, -hint.dot(dir));
  if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
  side.normalize();
  outJoint.copy(a).addScaledVector(dir, x).addScaledVector(side, h);
}

function boardGeometry(len, wid, rise, tipStart) {
  const hl = len / 2, hw = wid / 2, r = hw * 0.95;
  const sh = new THREE.Shape();
  sh.moveTo(-hw, -hl + r);
  sh.lineTo(-hw, hl - r);
  sh.quadraticCurveTo(-hw, hl, 0, hl);
  sh.quadraticCurveTo(hw, hl, hw, hl - r);
  sh.lineTo(hw, -hl + r);
  sh.quadraticCurveTo(hw, -hl, 0, -hl);
  sh.quadraticCurveTo(-hw, -hl, -hw, -hl + r);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.022, bevelEnabled: false, curveSegments: 6 });
  // shape is in XY, extruded along Z -> rotate so the board lies in XZ with nose toward +Z
  g.rotateX(Math.PI / 2);
  g.rotateY(Math.PI);
  // bend tips up
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const a = Math.abs(z) - tipStart;
    if (a > 0) p.setY(i, p.getY(i) + a * a * rise);
  }
  g.computeVertexNormals();
  // uv from position for graphic
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / wid + 0.5, p.getZ(i) / len + 0.5);
  return g;
}

function graphicTexture(c1, c2, c3) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = c1; g.fillRect(0, 0, 64, 256);
  g.fillStyle = c2;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.moveTo(0, 20 + i * 26); g.lineTo(64, 4 + i * 26); g.lineTo(64, 14 + i * 26); g.lineTo(0, 30 + i * 26);
    g.fill();
  }
  g.fillStyle = c3;
  g.fillRect(26, 0, 12, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const OUTFITS = [
  { name: 'Ember', jacket: 0xff5a1f, pants: 0x1f2a44, helmet: 0xf2f2f2, accent: 0x18c0ff, board: ['#111827', '#ff5a1f', '#ffd166'] },
  { name: 'Glacier', jacket: 0x2bb3ff, pants: 0xf0f0f0, helmet: 0x1a1a1a, accent: 0xff2e88, board: ['#f8fafc', '#2bb3ff', '#0f172a'] },
  { name: 'Moss', jacket: 0x5f8f3e, pants: 0x3b2f2a, helmet: 0xd9a400, accent: 0xffffff, board: ['#2b2b2b', '#9bd35a', '#f4f4f4'] },
  { name: 'Violet', jacket: 0x8b5cf6, pants: 0x111111, helmet: 0xffffff, accent: 0xfacc15, board: ['#fef3c7', '#8b5cf6', '#111827'] },
  { name: 'Hi-Vis', jacket: 0xd7ff1f, pants: 0x2a2a2a, helmet: 0x2a2a2a, accent: 0xff3b3b, board: ['#1f2937', '#d7ff1f', '#ef4444'] },
];

// grab targets in body frame (chest +Z, rider's left +X, up +Y)
// snowboard x is "toward the nose" (multiplied by nose sign), hand 'f' = front, 'b' = back
const BOARD_GRABS = [
  { p: [-0.05, 0.1, 0.16], hand: 'b' },          // Indy
  { p: [0.05, 0.1, -0.16], hand: 'f' },          // Melon
  { p: [0.72, 0.12, 0.0], hand: 'f' },           // Nose
  { p: [-0.72, 0.12, 0.0], hand: 'b' },          // Tail
  { p: [0.14, 0.1, 0.16], hand: 'f' },           // Mute
  { p: [-0.14, 0.1, -0.16], hand: 'b' },         // Stalefish
  { p: [0.05, 0.1, -0.16], hand: 'f', tweak: 0.5 },  // Method
  { p: [0.3, 0.1, 0.16], hand: 'f', tweak: -0.4 },   // Japan
];
const SKI_GRABS = [
  { p: [0.22, 0.08, 0.05], hand: 'l' },             // Safety
  { p: [-0.12, 0.1, 0.32], hand: 'l' },             // Mute
  { p: [0.12, 0.12, 0.22], hand: 'l', tweak: 0.35 },// Japan
  { p: [-0.14, 0.1, -0.55], hand: 'r' },            // Tail
  { p: [0.15, 0.08, 0.02], hand: 'r' },             // Critical
  { p: [-0.12, 0.12, -0.78], hand: 'r' },           // Blunt
  { p: [0.12, 0.1, 0.55], hand: 'both', p2: [-0.12, 0.1, 0.55] }, // Truck Driver
  { p: [-0.12, 0.1, -0.45], hand: 'l' },            // Octo
];

export class RiderModel {
  constructor(sport, goofy, outfitIdx = 0) {
    this.sport = sport;
    this.goofy = goofy;
    const o = OUTFITS[outfitIdx % OUTFITS.length];
    this.root = new THREE.Group();       // placed at the feet by physics orientation
    this.tilt = new THREE.Group();       // lean / press / crash wobble
    this.root.add(this.tilt);
    this.equip = new THREE.Group();
    this.tilt.add(this.equip);
    this.body = new THREE.Group();
    this.tilt.add(this.body);

    const jacket = mat(o.jacket, 0.75), pants = mat(o.pants, 0.85), skin = mat(0xe0b08a, 0.6);
    const helmet = mat(o.helmet, 0.35, 0.1), dark = mat(0x16181d, 0.5), glove = mat(0x202228, 0.8);
    const goggle = new THREE.MeshStandardMaterial({ color: 0xffa21a, roughness: 0.1, metalness: 0.9, emissive: 0x331a00 });
    const accent = mat(o.accent, 0.6);

    // equipment
    const gtex = graphicTexture(...o.board);
    if (sport === 'snowboard') {
      const b = new THREE.Mesh(boardGeometry(1.56, 0.29, 1.4, 0.56), [new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.4 }), mat(0x111111, 0.4)]);
      b.castShadow = true;
      this.equip.add(b);
      for (const z of [-0.26, 0.26]) {
        const bind = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.14), dark);
        bind.position.set(0, 0.05, z);
        bind.castShadow = true;
        this.equip.add(bind);
      }
    } else {
      const sg = boardGeometry(1.75, 0.095, 2.6, 0.7);
      for (const x of [-0.12, 0.12]) {
        const s = new THREE.Mesh(sg, [new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.4 }), mat(0x111111, 0.4)]);
        s.position.x = x;
        s.castShadow = true;
        this.equip.add(s);
        const bind = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.32), dark);
        bind.position.set(x, 0.045, 0);
        this.equip.add(bind);
      }
    }
    // body yaw: snowboarders ride sideways
    this.bodyYaw = sport === 'snowboard' ? (goofy ? Math.PI / 2 : -Math.PI / 2) : 0;
    this.body.rotation.y = this.bodyYaw;
    this.noseSign = sport === 'snowboard' ? (goofy ? -1 : 1) : 1;

    // body parts
    const add = (m) => { m.castShadow = true; this.body.add(m); return m; };
    this.thighL = add(limb(pants, 0.085)); this.thighR = add(limb(pants, 0.085));
    this.shinL = add(limb(pants, 0.075)); this.shinR = add(limb(pants, 0.075));
    this.uArmL = add(limb(jacket, 0.065)); this.uArmR = add(limb(jacket, 0.065));
    this.fArmL = add(limb(jacket, 0.056)); this.fArmR = add(limb(jacket, 0.056));
    this.bootL = add(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.3), dark));
    this.bootR = add(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.3), dark));
    this.handL = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glove));
    this.handR = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glove));
    this.pelvis = add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.22), pants));
    this.torso = new THREE.Group();
    this.body.add(this.torso);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.26, 4, 10), jacket);
    chest.scale.set(1, 1, 0.68);
    chest.position.y = 0.27;
    chest.castShadow = true;
    this.torso.add(chest);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.392, 0.05, 0.27), accent);
    stripe.position.y = 0.3;
    this.torso.add(stripe);
    const hood = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.045, 6, 12), jacket);
    hood.rotation.x = Math.PI / 2;
    hood.position.y = 0.5;
    this.torso.add(hood);
    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 0.56;
    this.torso.add(this.headPivot);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), skin);
    head.position.y = 0.1;
    this.headPivot.add(head);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58), helmet);
    helm.position.y = 0.11;
    helm.castShadow = true;
    this.headPivot.add(helm);
    const gog = new THREE.Mesh(new THREE.CylinderGeometry(0.128, 0.128, 0.065, 16, 1, true, -1.1, 2.2), goggle);
    gog.position.set(0, 0.1, 0.008);
    gog.rotation.y = 0;
    this.headPivot.add(gog);
    const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.131, 0.131, 0.045, 16, 1, true, 1.1, Math.PI * 2 - 2.2), dark);
    strap.position.set(0, 0.1, 0.008);
    this.headPivot.add(strap);

    if (sport === 'ski') {
      const poleM = mat(0xc7ccd6, 0.3, 0.8);
      this.poleL = add(limb(poleM, 0.011));
      this.poleR = add(limb(poleM, 0.011));
      this.basketL = add(new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 4, 10), dark));
      this.basketR = add(new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 4, 10), dark));
    }

    this.pose = { hip: 0.92, tilt: 0.15, twist: 0, armsOut: 0.3, grab: 0 };
    this.grabTarget = new V3();
    this.grabTarget2 = new V3();
    this.handTargetL = new V3(); this.handTargetR = new V3();
    this.handSmoothL = new V3(0.3, 0.6, 0.1); this.handSmoothR = new V3(-0.3, 0.6, 0.1);
    this.flail = 0;
    this.t = 0;
  }

  // r: Rider physics object
  update(r, dt, renderPos, renderQuat) {
    this.t += dt;
    this.root.position.copy(renderPos);
    this.root.quaternion.copy(renderQuat);
    const ski = this.sport === 'ski';
    const mode = r.mode;
    // ---- targets
    let hip = 0.9 - r.crouch * 0.38 - r.landSquash * 0.22;
    let tilt = 0.18 + r.crouch * 0.35;
    let armsOut = 0.25;
    const grabIdx = mode === 'air' ? r.grabIdx : -1;
    if (grabIdx >= 0) { hip = 0.4; tilt = 0.85; }
    if (mode === 'rail') { hip = 0.72; tilt = 0.25; armsOut = 0.9; }
    if (mode === 'air' && grabIdx < 0) armsOut = 0.45 + Math.min(0.5, Math.abs(r.spinRate) * 0.06);
    if (mode === 'crash') { hip = 0.6; tilt = 0.4; armsOut = 1; }
    const k = Math.min(1, dt * 14);
    const P = this.pose;
    P.hip += (hip - P.hip) * k;
    P.tilt += (tilt - P.tilt) * k;
    P.armsOut += (armsOut - P.armsOut) * k;

    // lean & press on the tilt group
    const lean = mode === 'ground' ? r.lean : 0;
    const butter = mode === 'ground' ? (r.butter || 0) : 0;
    const press = mode === 'rail' ? r.press * 0.22 : butter * 0.3;
    let tweak = 0;
    if (grabIdx >= 0) {
      const gdef = (ski ? SKI_GRABS : BOARD_GRABS)[grabIdx];
      tweak = (gdef.tweak || 0) * r.grabBlend;
    }
    this.tilt.rotation.set(press, 0, -lean * (ski ? 0.8 : 0.9));
    // pivot the press on the nose so it stays on the snow
    this.tilt.position.set(0, butter * Math.sin(0.3) * (ski ? 0.85 : 0.75), 0);
    this.equip.rotation.set(0, 0, 0);
    if (!ski) this.equip.rotation.z = tweak * 0.8 * this.noseSign; else this.equip.rotation.x = -tweak * 0.6;

    // ---- skeleton in body frame
    const fs = ski ? 0.12 : 0.26;
    const footL = new V3(fs, 0.08, 0), footR = new V3(-fs, 0.08, 0);
    // feet follow equipment tweak in body frame (approx): lift the tail foot when tweaking
    if (!ski && tweak) {
      const lift = Math.abs(tweak) * 0.18;
      if (this.noseSign > 0) footR.y += lift; else footL.y += lift;
    }
    const pel = new V3(0, P.hip, -0.04 - r.crouch * 0.05);
    const hipL = pel.clone().add(new V3(0.11, -0.04, 0)), hipR = pel.clone().add(new V3(-0.11, -0.04, 0));
    const kneeL = new V3(), kneeR = new V3(), eL = new V3(), eR = new V3();
    const kneeHintL = new V3(ski ? 0.05 : -0.25, 0, 1), kneeHintR = new V3(ski ? -0.05 : 0.25, 0, 1);
    ik(hipL, footL, 0.47, 0.47, kneeHintL, kneeL, eL);
    ik(hipR, footR, 0.47, 0.47, kneeHintR, kneeR, eR);
    placeLimb(this.thighL, hipL, kneeL); placeLimb(this.shinL, kneeL, eL);
    placeLimb(this.thighR, hipR, kneeR); placeLimb(this.shinR, kneeR, eR);
    this.bootL.position.set(eL.x, eL.y - 0.02, eL.z + (ski ? 0.04 : 0.0));
    this.bootR.position.set(eR.x, eR.y - 0.02, eR.z + (ski ? 0.04 : 0.0));
    if (!ski) { this.bootL.rotation.y = 0; this.bootR.rotation.y = 0; }

    this.pelvis.position.copy(pel);
    this.torso.position.copy(pel);
    // snowboarders twist the upper body toward the nose a bit
    const twist = ski ? 0 : 0.35 * this.noseSign;
    this.torso.rotation.set(P.tilt, twist, 0, 'YXZ');
    this.headPivot.rotation.set(-P.tilt * 0.6, ski ? 0 : 0.9 * this.noseSign - twist, 0, 'YXZ');
    this.torso.updateMatrix();

    // shoulders in body frame
    const shL = new V3(0.21, 0.44, 0).applyEuler(this.torso.rotation).add(pel);
    const shR = new V3(-0.21, 0.44, 0).applyEuler(this.torso.rotation).add(pel);

    // hand targets
    const tL = this.handTargetL, tR = this.handTargetR;
    if (ski && mode !== 'crash' && grabIdx < 0) {
      tL.set(0.3 + P.armsOut * 0.08, P.hip - 0.02, 0.3 + (mode === 'air' ? -0.1 : 0));
      tR.set(-0.3 - P.armsOut * 0.08, P.hip - 0.02, 0.3 + (mode === 'air' ? -0.1 : 0));
    } else {
      const ao = P.armsOut;
      tL.set(0.25 + ao * 0.4, P.hip + 0.15 + ao * 0.25, 0.12);
      tR.set(-0.25 - ao * 0.4, P.hip + 0.15 + ao * 0.25, 0.05);
      if (mode === 'crash') {
        tL.y += Math.sin(this.t * 13) * 0.3; tR.y += Math.cos(this.t * 11) * 0.3;
      }
    }
    if (grabIdx >= 0) {
      const defs = ski ? SKI_GRABS : BOARD_GRABS;
      const g = defs[grabIdx];
      const gp = this.grabTarget.set(g.p[0] * this.noseSign, g.p[1], g.p[2]);
      let hand = g.hand;
      if (!ski) hand = (g.hand === 'f') === (this.noseSign > 0) ? 'l' : 'r';
      const b = r.grabBlend;
      if (hand === 'l' || hand === 'both') tL.lerp(gp, b);
      if (hand === 'r') tR.lerp(gp, b);
      if (hand === 'both') tR.lerp(this.grabTarget2.set(g.p2[0], g.p2[1], g.p2[2]), b);
    }
    this.handSmoothL.lerp(tL, Math.min(1, dt * 18));
    this.handSmoothR.lerp(tR, Math.min(1, dt * 18));
    const elL = new V3(), elR = new V3(), hL = new V3(), hR = new V3();
    ik(shL, this.handSmoothL, 0.32, 0.31, new V3(1, -0.3, -0.6), elL, hL);
    ik(shR, this.handSmoothR, 0.32, 0.31, new V3(-1, -0.3, -0.6), elR, hR);
    placeLimb(this.uArmL, shL, elL); placeLimb(this.fArmL, elL, hL);
    placeLimb(this.uArmR, shR, elR); placeLimb(this.fArmR, elR, hR);
    this.handL.position.copy(hL); this.handR.position.copy(hR);

    if (ski) {
      // poles: from hand toward the snow, trailing back in the air
      const back = mode === 'air' ? 0.75 : 0.35;
      const tipL = hL.clone().add(new V3(0.08, -1.0, -back).normalize().multiplyScalar(1.12));
      const tipR = hR.clone().add(new V3(-0.08, -1.0, -back).normalize().multiplyScalar(1.12));
      const topL = hL.clone().add(new V3(0, 0.08, 0)), topR = hR.clone().add(new V3(0, 0.08, 0));
      placeLimb(this.poleL, topL, tipL); placeLimb(this.poleR, topR, tipR);
      this.basketL.position.copy(tipL).lerp(hL, 0.08);
      this.basketR.position.copy(tipR).lerp(hR, 0.08);
      this.basketL.quaternion.copy(this.poleL.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new V3(1, 0, 0), Math.PI / 2));
      this.basketR.quaternion.copy(this.poleR.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new V3(1, 0, 0), Math.PI / 2));
    }
  }
}
