import * as THREE from '../lib/three.module.min.js';
import { createMap, MAP_LIST } from './terrain.js';
import { Rider } from './physics.js';
import { RiderModel, OUTFITS } from './rider.js';
import { World } from './world.js';
import { Input, ACTIONS, keyLabel } from './input.js';
import { GRABS, nameAirTrick } from './tricks.js';
import { Sound } from './sound.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 120;
const PIVOT_H = 0.85; // height of the rider's centre of mass above the board
const PIVOT_LOCAL = new THREE.Vector3(0, PIVOT_H, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const pivotOff = new THREE.Vector3();

// ------------------------------------------------------------------ settings
const SETTINGS_KEY = 'frostline.settings.v1';
const settings = Object.assign(
  { map: 'slopestyle', sport: 'snowboard', goofy: false, assist: true, quality: 2, outfit: 0, sound: true, camDist: 1 },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } };
const bestKey = () => `frostline.best.${settings.map}.${settings.sport}`;
const getBest = () => { try { return +localStorage.getItem(bestKey()) || 0; } catch (e) { return 0; } };
const setBest = (v) => { try { localStorage.setItem(bestKey(), String(v)); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------------ renderer
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);

function applyQuality() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.quality >= 2 ? 2 : settings.quality === 1 ? 1.5 : 1));
  renderer.shadowMap.enabled = settings.quality > 0;
  resize();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ game state
const input = new Input();
const sound = new Sound();
let map = null, world = null, rider = null, model = null;
let state = 'menu';
let acc = 0;
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const camDir = new THREE.Vector3(0, 0, -1);
const renderPos = new THREE.Vector3();
const renderQuat = new THREE.Quaternion();
let menuT = 0;

function loadMap(id) {
  if (world) world.dispose();
  map = createMap(id);
  world = new World(scene, map, settings.quality);
}

function startRun() {
  if (!map || map.id !== settings.map) loadMap(settings.map);
  if (model) scene.remove(model.root);
  rider = new Rider(map, { sport: settings.sport, goofy: settings.goofy, assist: settings.assist });
  model = new RiderModel(settings.sport, settings.goofy, settings.outfit);
  scene.add(model.root);
  camDir.set(0, 0, -1);
  snapCamera();
  acc = 0;
  $('popups').innerHTML = '';
  $('finish').classList.add('hidden');
  updateHud(true);
}

function snapCamera() {
  rider.updateQuat(1);
  computeCamera(1, true);
}

// ------------------------------------------------------------------ menus
function setState(s) {
  state = s;
  $('menu').classList.toggle('hidden', s !== 'menu');
  $('pause').classList.toggle('hidden', s !== 'paused');
  $('hud').classList.toggle('hidden', s !== 'play' && s !== 'finished');
  if (s !== 'finished') $('finish').classList.add('hidden');
}

function buildMenu() {
  const cards = $('maps');
  cards.innerHTML = '';
  for (const m of MAP_LIST) {
    const b = document.createElement('button');
    b.className = 'card' + (settings.map === m.id ? ' on' : '');
    b.innerHTML = `<b>${m.name}</b><span>${m.desc}</span><em>Best: ${bestFor(m.id).toLocaleString()}</em>`;
    b.onclick = () => { settings.map = m.id; saveSettings(); buildMenu(); loadMap(m.id); };
    cards.appendChild(b);
  }
  const seg = (id, val) => { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(val)); };
  seg('sportSel', settings.sport);
  seg('stanceSel', settings.goofy ? 'goofy' : 'regular');
  seg('assistSel', settings.assist ? 'on' : 'off');
  seg('qualitySel', settings.quality);
  seg('soundSel', settings.sound ? 'on' : 'off');
  $('stanceRow').style.display = '';
  $('outfitName').textContent = OUTFITS[settings.outfit % OUTFITS.length].name;
  buildCheatSheet($('menuSheet'));
}
function bestFor(mapId) { try { return +localStorage.getItem(`frostline.best.${mapId}.${settings.sport}`) || 0; } catch (e) { return 0; } }

function wireSeg(id, fn) {
  for (const b of $(id).querySelectorAll('button')) b.onclick = () => { fn(b.dataset.v); saveSettings(); buildMenu(); };
}
wireSeg('sportSel', (v) => { settings.sport = v; });
wireSeg('stanceSel', (v) => { settings.goofy = v === 'goofy'; });
wireSeg('assistSel', (v) => { settings.assist = v === 'on'; });
wireSeg('qualitySel', (v) => { settings.quality = +v; applyQuality(); loadMap(settings.map); });
wireSeg('soundSel', (v) => { settings.sound = v === 'on'; sound.setEnabled(settings.sound); });
$('outPrev').onclick = () => { settings.outfit = (settings.outfit + OUTFITS.length - 1) % OUTFITS.length; saveSettings(); buildMenu(); };
$('outNext').onclick = () => { settings.outfit = (settings.outfit + 1) % OUTFITS.length; saveSettings(); buildMenu(); };
$('playBtn').onclick = () => { sound.start(settings.sound); startRun(); setState('play'); };
$('controlsBtn').onclick = () => openControls();
$('resumeBtn').onclick = () => setState('play');
$('restartBtn').onclick = () => { startRun(); setState('play'); };
$('pauseControlsBtn').onclick = () => openControls();
$('menuBtn').onclick = () => { setState('menu'); buildMenu(); };
$('againBtn').onclick = () => { startRun(); setState('play'); };
$('finishMenuBtn').onclick = () => { setState('menu'); buildMenu(); };
$('closeControls').onclick = () => { $('controls').classList.add('hidden'); buildMenu(); buildCheatSheet($('pauseSheet')); };
$('resetBinds').onclick = () => { input.resetDefaults(); buildControls(); };

function openControls() { buildControls(); $('controls').classList.remove('hidden'); }
function buildControls() {
  const t = $('bindTable');
  t.innerHTML = '';
  for (const a of ACTIONS) {
    const tr = document.createElement('tr');
    let label = a.label;
    const gi = { grab1: 0, grab2: 1, grab3: 2, grab4: 3 }[a.id];
    if (gi !== undefined) label += ` <small>(${GRABS[settings.sport][gi]} / alt: ${GRABS[settings.sport][gi + 4]})</small>`;
    tr.innerHTML = `<td>${label}</td>`;
    for (let s = 0; s < 2; s++) {
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.className = 'key';
      b.textContent = keyLabel(input.binds[a.id][s]);
      b.onclick = () => {
        b.textContent = 'press key…';
        b.classList.add('wait');
        input.capture = (code) => {
          if (code === 'Escape' && a.id !== 'pause') { buildControls(); return; }
          if (code === 'Backspace' || code === 'Delete') input.binds[a.id][s] = '', input.save();
          else input.setBind(a.id, s, code);
          buildControls();
        };
      };
      td.appendChild(b);
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
}

function buildCheatSheet(el) {
  const k = (a) => keyLabel(input.binds[a][0]);
  const g = GRABS[settings.sport];
  el.innerHTML = `
    <div><kbd>${k('left')}</kbd><kbd>${k('right')}</kbd> carve · spin in air</div>
    <div><kbd>${k('up')}</kbd><kbd>${k('down')}</kbd> tuck / brake · front / back flip in air</div>
    <div><kbd>${k('jump')}</kbd> hold &amp; release to ollie · pre-wind spins by holding a direction</div>
    <div><kbd>${k('rollL')}</kbd><kbd>${k('rollR')}</kbd> roll (rodeos, side flips) · combine with spin + flip for corks</div>
    <div><kbd>${k('grabJapan')}</kbd> Japan · <kbd>${k('grabTail')}</kbd> Tail · <kbd>${k('butter')}</kbd> nose butter (steer while holding to spin it)</div>
    <div><kbd>${k('grab1')}</kbd>${g[0]} <kbd>${k('grab2')}</kbd>${g[1]} <kbd>${k('grab3')}</kbd>${g[2]} <kbd>${k('grab4')}</kbd>${g[3]}</div>
    <div>hold <kbd>${k('grabAlt')}</kbd> for ${g[4]}, ${g[5]}, ${g[6]}, ${g[7]}</div>
    <div>On rails: <kbd>${k('left')}</kbd><kbd>${k('right')}</kbd> swap 90°, <kbd>${k('up')}</kbd><kbd>${k('down')}</kbd> press, <kbd>${k('jump')}</kbd> pop off</div>
    <div><kbd>${k('reset')}</kbd> checkpoint · <kbd>${k('camera')}</kbd> camera · <kbd>${k('pause')}</kbd> pause</div>`;
}

// ------------------------------------------------------------------ HUD
function popup(text, sub, cls) {
  const d = document.createElement('div');
  d.className = 'pop ' + (cls || '');
  d.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
  $('popups').prepend(d);
  setTimeout(() => d.classList.add('fade'), 2200);
  setTimeout(() => d.remove(), 3000);
  while ($('popups').children.length > 5) $('popups').lastChild.remove();
}

let hudScore = -1;
function updateHud(force) {
  if (!rider) return;
  if (force || hudScore !== rider.runScore) {
    hudScore = rider.runScore;
    $('score').textContent = rider.runScore.toLocaleString();
    $('best').textContent = 'BEST ' + getBest().toLocaleString();
  }
  $('speed').textContent = Math.round(rider.speed * 3.6) + ' km/h';
  // live trick
  let live = '';
  if (rider.mode === 'air' && rider.airTime > 0.15) {
    const rec = rider.airRecord('clean');
    const spins = Math.abs(rec.spin) > 0.6 || Math.abs(rec.flip) > 1 || Math.abs(rec.roll) > 1 || rec.grabs.length;
    if (spins) live = nameAirTrick(rec);
    const deg = Math.round(Math.abs(rider.spin) * 180 / Math.PI);
    if (deg > 30) live += ` <i>${deg}°</i>`;
  } else if (rider.mode === 'rail') {
    live = rider.rail.name + ' <i>' + rider.rail.time.toFixed(1) + 's</i>';
  }
  $('trick').innerHTML = live;
  // combo
  if (rider.combo.length) {
    const sum = rider.combo.reduce((a, r) => a + r.pts, 0);
    $('combo').innerHTML = `${rider.combo.map((r) => r.name).join(' + ')}<br><b>${sum.toLocaleString()} × ${rider.combo.length}</b>`;
    $('combo').classList.add('on');
  } else $('combo').classList.remove('on');
  $('modeLabel').textContent = `${map.name} · ${settings.sport === 'ski' ? 'Ski' : 'Snowboard'}${rider.switch && rider.mode === 'ground' ? ' · SWITCH' : ''}`;
}

function handleEvents() {
  for (const e of rider.events) {
    if (e.type === 'trick') {
      popup(`+${e.pts.toLocaleString()}`, e.name + (e.landing === 'sketchy' ? ' · sketchy' : ''), e.landing === 'sketchy' ? 'warn' : '');
    } else if (e.type === 'bank') {
      if (e.mult > 1) popup(`COMBO ×${e.mult}`, `+${e.total.toLocaleString()}`, 'big');
      sound.chime();
    } else if (e.type === 'crash') {
      popup('BAIL', e.lost ? `lost ${e.lost.toLocaleString()}` : (e.name || ''), 'bad');
      sound.thud(1);
    } else if (e.type === 'land') {
      world.emitSpray(rider.pos, { x: rider.vel.x * 0.3, y: 1.5, z: rider.vel.z * 0.3 }, 20 + Math.min(40, e.impact * 4), 3);
      sound.thud(Math.min(1, e.impact / 10));
    } else if (e.type === 'takeoff') {
      sound.pop();
    } else if (e.type === 'rail') {
      sound.grind(true);
    } else if (e.type === 'finish') {
      const best = getBest();
      const nb = e.score > best;
      if (nb) setBest(e.score);
      $('finScore').textContent = e.score.toLocaleString();
      $('finBest').textContent = nb ? 'NEW BEST!' : 'Best ' + best.toLocaleString();
      setTimeout(() => { if (state === 'play') { $('finish').classList.remove('hidden'); state = 'finished'; } }, 900);
    }
    if (e.type !== 'rail' && rider.mode !== 'rail') sound.grind(false);
  }
  rider.events.length = 0;
}

// ------------------------------------------------------------------ camera
const tmp = new THREE.Vector3();
function computeCamera(dt, snap) {
  const r = rider;
  const target = renderPos;
  // desired viewing direction
  if (map.pipe) {
    tmp.set(0, 0, -1);
  } else {
    tmp.set(r.vel.x, 0, r.vel.z);
    if (tmp.lengthSq() < 1) tmp.copy(camDir);
    tmp.normalize();
  }
  const rate = snap ? 1 : r.mode === 'air' ? 0.6 : r.mode === 'crash' ? 0.5 : 3.0;
  camDir.lerp(tmp, Math.min(1, dt * rate)).normalize();
  const d = settings.camDist;
  let back, up, side = 0;
  if (camMode === 0) { back = 5.8 * d; up = 2.4 * d; }
  else if (camMode === 1) { back = 10 * d; up = 4.2 * d; }
  else { back = 3; up = 2.0; side = 8; }
  if (map.pipe && camMode !== 2) { back *= 1.45; up *= 1.6; }
  const right = new THREE.Vector3(-camDir.z, 0, camDir.x);
  const want = new THREE.Vector3().copy(target).addScaledVector(camDir, -back).addScaledVector(right, side);
  want.y += up;
  if (map.pipe && camMode !== 2) want.x = target.x * 0.55;
  const g = map.H(want.x, want.z) + 1.0;
  if (want.y < g) want.y = g;
  const look = new THREE.Vector3().copy(target);
  look.y += 1.0;
  if (map.pipe) look.y += 0.6;
  if (snap) { camPos.copy(want); camLook.copy(look); }
  else {
    camPos.lerp(want, Math.min(1, dt * (r.mode === 'air' ? 4 : 7)));
    camLook.lerp(look, Math.min(1, dt * 14));
  }
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  const fov = 68 + Math.min(14, r.speed * 0.35);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
}

function menuCamera(dt) {
  menuT += dt * 0.05;
  const s0 = map.sRange[0], s1 = map.sRange[1];
  const s = s0 + ((Math.sin(menuT) * 0.5 + 0.5) * 0.8 + 0.05) * (s1 - s0);
  const z = -s;
  const x = Math.cos(menuT * 1.7) * 25;
  const y = map.H(0, z) + 18;
  camera.position.set(x, y, z + 25);
  camera.lookAt(0, map.H(0, z - 30), z - 30);
  world.update(dt, camera.position, camera);
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (input.pressed('pause')) {
    if (state === 'play') setState('paused');
    else if (state === 'paused') setState('play');
  }

  if (state === 'menu' || !rider) {
    if (map) menuCamera(dt);
  } else {
    if (state === 'play' || state === 'finished') {
      const inp = input.poll();
      if (input.pressed('reset')) rider.respawn();
      if (input.pressed('camera')) camMode = (camMode + 1) % 3;
      if (state === 'finished' && inp.jumpPressed) { startRun(); setState('play'); }
      acc += dt;
      let first = true;
      while (acc >= STEP) {
        if (!first) inp.jumpPressed = false;
        rider.step(STEP, inp);
        first = false;
        acc -= STEP;
      }
      handleEvents();
      // carving spray
      if (rider.mode === 'ground' && rider.speed > 6 && (Math.abs(rider.lean) > 0.35 || rider.brake > 0.5)) {
        const side = new THREE.Vector3().crossVectors(rider.vel, rider.n).normalize().multiplyScalar(rider.lean > 0 ? -2.5 : 2.5);
        world.emitSpray(rider.pos, { x: side.x + rider.vel.x * 0.2, y: 1.2, z: side.z + rider.vel.z * 0.2 }, 2, 1.5);
      }
      sound.update(dt, rider);
    } else {
      input.poll();
    }
    const alpha = acc / STEP;
    renderPos.lerpVectors(rider.prevPos, rider.pos, alpha);
    renderQuat.copy(rider.quat);
    // rotate around the middle of the body, not the board: keep the body's centre on the
    // physics path and swing the feet around it
    if (rider.mode === 'air' || rider.mode === 'crash') {
      const up = rider.mode === 'air' ? rider.upBase : WORLD_UP;
      pivotOff.copy(PIVOT_LOCAL).applyQuaternion(renderQuat);
      renderPos.addScaledVector(up, PIVOT_H).sub(pivotOff);
    }
    model.update(rider, dt, renderPos, renderQuat);
    computeCamera(dt, false);
    world.update(dt, renderPos, camera);
    updateHud(false);
  }
  input.endFrame();
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ boot
applyQuality();
loadMap(settings.map);
buildMenu();
buildCheatSheet($('pauseSheet'));
setState('menu');
requestAnimationFrame(frame);
window.__game = { get rider() { return rider; }, get state() { return state; }, startRun, setState, settings };
