/*
 * Stranded in Space - PewPlay edition
 *
 * Rebuilt from "Lost in a Space Odyssey" by Marc Guinea (js13kGames 2017, MIT License).
 * Gameplay, graphics, sounds and the CRT/glow post-processing come from the original;
 * this edition adds a resolution-independent renderer that adapts to any screen shape,
 * touch controls, pause/mute, and a few bug fixes.
 *
 * Entities are stored as small arrays (tuples) like in the original; the indexes are
 * documented next to each entity.
 */

/* ------------------------------------------------------------------ */
/* Globals shared with font.js                                          */
/* ------------------------------------------------------------------ */
var ctx; // 2D context of the off-screen game canvas (font.js draws with it)

(function () {
  'use strict';

  var STORE_PREFIX = 'stranded-in-space:';
  var BASE_SIZE = 640; // length (in game units) of the shorter side of the view

  /* ---------------------------------------------------------------- */
  /* Storage (always wrapped: may be unavailable)                       */
  /* ---------------------------------------------------------------- */
  function storeGet(key) {
    try { return window.localStorage.getItem(STORE_PREFIX + key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { window.localStorage.setItem(STORE_PREFIX + key, value); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- */
  /* Palette (flat UI colors, same indexes as the original)             */
  /* ---------------------------------------------------------------- */
  var colors = [
    'rgba(16,16,16,0.2)', // 0 screen cleaner (trails)
    '#1abc9c', // 1 turquoise
    '#16a085', // 2 green sea
    '#005F29', // 3 emerald
    '#27ae60', // 4 nephritis
    '#3498db', // 5 peter river
    '#2980b9', // 6 belize hole
    '#9b59b6', // 7 amethyst
    '#8e44ad', // 8 wisteria
    '#34495e', // 9 wet asphalt
    '#2c3e50', // 10 midnight blue
    '#f1c40f', // 11 sunflower
    '#f39c12', // 12 orange
    '#e67e22', // 13 carrot
    '#d35400', // 14 pumpkin
    '#e74c3c', // 15 alizarin
    '#c0392b', // 16 pomegranate
    '#ecf0f1', // 17 clouds
    '#bdc3c7', // 18 silver
    '#95a5a6', // 19 concrete
    '#7f8c8d', // 20 asbestos
    '#ff0000', // 21 red
    '#00ff00', // 22 green
    '#0000ff', // 23 blue
    '#B9650D', // 24 brown
    '#924B00', // 25 brown 2
    '#000000', // 26 black
    'rgba(16,16,16,1.0)', // 27 normal screen cleaner
    'rgba(16,16,16,0.1)'  // 28 hyperspace screen cleaner
  ];

  /* ---------------------------------------------------------------- */
  /* Seeded random (each sector is generated from a seed)               */
  /* ---------------------------------------------------------------- */
  var seed = 1;
  function random(min, max) {
    var x = Math.sin(seed++) * 10000;
    x -= Math.floor(x);
    return x * (max - min) + min;
  }
  function toRad(d) { return d / 180 * Math.PI; }
  function toDeg(r) { return r * 180 / Math.PI; }

  /* ---------------------------------------------------------------- */
  /* DOM / canvases                                                     */
  /* ---------------------------------------------------------------- */
  var root = document.getElementById('game');
  var screenCanvas = document.getElementById('screen');
  var buffer = document.createElement('canvas');
  ctx = buffer.getContext('2d');

  var W = 800, H = 640;      // logical view size in game units
  var viewScale = 1;         // device pixels per game unit
  var pixelW = 800, pixelH = 640;

  /* ---------------------------------------------------------------- */
  /* WebGL post-processing (CRT curvature + vignette, chromatic glow)   */
  /* ---------------------------------------------------------------- */
  var VERTEX_SRC = [
    'attribute vec2 p;',
    'varying vec2 uv;',
    'void main() {',
    '  gl_Position = vec4(p, .0, 1.);',
    '  uv = .5 * (p + 1.);',
    '}'
  ].join('\n');

  var GLOW_SRC = [
    'precision highp float;',
    'uniform vec2 dim;',
    'uniform sampler2D tex;',
    'varying vec2 uv;',
    'void main() {',
    '  vec4 col = texture2D(tex, uv);',
    '  float rand = .3;',
    '  vec4 col_r = texture2D(tex, uv + vec2((-15. / dim.x) * rand, 0));',
    '  vec4 col_l = texture2D(tex, uv + vec2((8. / dim.x) * rand, 0));',
    '  vec4 col_g = texture2D(tex, uv + vec2((-7.5 / dim.x) * rand, 0));',
    '  float val = max(1., sin(uv.y * dim.y * 1.2) * 2.5) * rand;',
    '  col.r = col.r + col_l.r * val;',
    '  col.b = col.b + col_r.b * val;',
    '  col.g = col.g + col_g.g * val;',
    '  gl_FragColor = vec4(col.rgb, 1.);',
    '}'
  ].join('\n');

  var CRT_SRC = [
    'precision highp float;',
    'uniform vec2 dim;',
    'uniform sampler2D tex;',
    'varying vec2 uv;',
    'void main() {',
    '  vec2 coord = uv * dim;',
    '  coord -= dim / 2.;',
    '  float dis = length(coord);',
    '  if (dis < 600.) {',
    '    float percent = dis / 600.;',
    '    coord *= mix(1., smoothstep(0.0, 600. / dis, percent), .125);',
    '  }',
    '  coord += dim / 2.;',
    '  vec4 color = texture2D(tex, coord / dim);',
    '  float dist = distance(uv, vec2(.5, .5));',
    // slightly softer vignette than the original so the HUD stays readable on any screen shape
    '  color.rgb *= smoothstep(.95, .18, dist);',
    '  gl_FragColor = color;',
    '}'
  ].join('\n');

  var gl = null, glowShader, crtShader, gameTexture, fbo = null;

  function glCompile(fragmentSrc) {
    var program = gl.createProgram();
    var vs = gl.createShader(gl.VERTEX_SHADER);
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vs, VERTEX_SRC);
    gl.compileShader(vs);
    gl.shaderSource(fs, fragmentSrc);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('shader link failed');
    gl.useProgram(program);
    var p = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    return {
      program: program,
      dim: gl.getUniformLocation(program, 'dim'),
      tex: gl.getUniformLocation(program, 'tex')
    };
  }

  function glTexture() {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function glResize() {
    if (!gl) return;
    if (fbo) {
      gl.deleteFramebuffer(fbo.handle);
      gl.deleteTexture(fbo.texture);
    }
    var handle = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, handle);
    var texture = glTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pixelW, pixelH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fbo = { handle: handle, texture: texture };
    // The effects are expressed in game units, so they look the same at any resolution
    gl.useProgram(glowShader.program);
    gl.uniform2f(glowShader.dim, W, H);
    gl.useProgram(crtShader.program);
    gl.uniform2f(crtShader.dim, W, H);
  }

  function initGL() {
    try {
      gl = screenCanvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false }) ||
        screenCanvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false });
      if (!gl) return false;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      var quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      glowShader = glCompile(GLOW_SRC);
      crtShader = glCompile(CRT_SRC);
      gameTexture = glTexture();
      return true;
    } catch (e) {
      gl = null;
      return false;
    }
  }

  function drawPostProcessing() {
    if (!gl) return;
    // upload the 2D frame
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    gl.viewport(0, 0, pixelW, pixelH);
    // pass 1: CRT -> framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.handle);
    gl.useProgram(crtShader.program);
    gl.uniform1i(crtShader.tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // pass 2: glow -> screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
    gl.useProgram(glowShader.program);
    gl.uniform1i(glowShader.tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  if (!initGL()) {
    // No WebGL: show the 2D canvas directly (no CRT effect)
    buffer.id = 'screen';
    buffer.className = screenCanvas.className;
    screenCanvas.parentNode.replaceChild(buffer, screenCanvas);
    screenCanvas = buffer;
  }

  /* ---------------------------------------------------------------- */
  /* Resize: the view adapts to the shape of the screen                 */
  /* ---------------------------------------------------------------- */
  function resize() {
    var cw = Math.max(1, root.clientWidth), ch = Math.max(1, root.clientHeight);
    var aspect = cw / ch;
    if (aspect >= 1) { H = BASE_SIZE; W = BASE_SIZE * aspect; }
    else { W = BASE_SIZE; H = BASE_SIZE / aspect; }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = cw * dpr, ph = ch * dpr;
    var maxPixels = 3200000;
    if (pw * ph > maxPixels) {
      var f = Math.sqrt(maxPixels / (pw * ph));
      pw *= f; ph *= f;
    }
    pixelW = Math.max(1, Math.round(pw));
    pixelH = Math.max(1, Math.round(ph));
    viewScale = pixelW / W;
    buffer.width = pixelW;
    buffer.height = pixelH;
    if (screenCanvas !== buffer) {
      screenCanvas.width = pixelW;
      screenCanvas.height = pixelH;
    }
    glResize();
    resetBackStars();
  }

  /* ---------------------------------------------------------------- */
  /* Audio (jsfxr sounds generated after the first user gesture)        */
  /* ---------------------------------------------------------------- */
  var audioCtx = null, audioOut = null;
  var muted = storeGet('muted') === '1';
  var SOUND_DEFS = {
    shot: [0, , 0.1642, 0.1014, 0.1894, 0.7955, 0.2077, -0.3, , , , , , 0.1194, 0.1127, , , , 1, , , 0.0143, , 0.2],
    hit: [1, , 0.0749, , 0.1706, 0.5028, , -0.3501, , , , , , , , , , , 1, , , , , 0.5],
    alarm: [1, , 0.2285, , 0.3794, 0.3394, , 0.13, , , , , , , , , , , 1, , , , , 0.5],
    enemyShot: [0, , 0.2391, , 0.0422, 0.5045, 0.2, -0.207, , , , , , 0.3508, 0.0383, , , , 1, , , , , 0.5],
    life: [1, , 0.2084, , 0.3463, 0.3286, , 0.1104, , 0.5056, 0.4383, , , , , , , , 1, , , , , 0.5],
    passenger: [0, , 0.0899, , 0.2689, 0.3074, , 0.2746, , , , , , 0.2879, , 0.4763, , , 1, , , , , 0.5],
    hyperspace: [2, 0.872, 0.728, 0.3438, 0.616, 0.1266, , 0.0053, , , , , , , , , , , 1, , , , , 0.5],
    explosion: [3, , 0.38, 0.5369, 0.52, 0.18, , -0.02, , , , -0.7444, 0.78, , , 0.7619, , , 0.1, , , , , 0.5],
    rock: [0, , 0.1842, 0.104, 0.3469, 0.8561, 0.0921, -0.4082, , , , , , 0.7613, -0.0176, , 0.0897, -0.1449, 1, , , , , 0.5]
  };
  var sounds = {};

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      audioOut = audioCtx.createDynamicsCompressor();
      var gain = audioCtx.createGain();
      gain.gain.value = 1;
      audioOut.connect(gain);
      gain.connect(audioCtx.destination);
      Object.keys(SOUND_DEFS).forEach(function (name) {
        var slot = [];
        sounds[name] = slot;
        jsfxr(SOUND_DEFS[name], audioCtx, function (buf) { slot.push(buf); });
      });
    } catch (e) {
      audioCtx = null;
    }
  }

  function play(name) {
    if (muted || !audioCtx || audioCtx.state !== 'running') return;
    var slot = sounds[name];
    if (!slot || !slot[0]) return;
    var source = audioCtx.createBufferSource();
    source.buffer = slot[0];
    source.connect(audioOut);
    source.start(0);
  }

  /* ---------------------------------------------------------------- */
  /* Game state                                                         */
  /* ---------------------------------------------------------------- */
  var STATE_MENU = 0, STATE_PLAY = 1, STATE_HYPER = 2, STATE_OVER = 3;
  var gameState = STATE_MENU;
  var paused = false;
  var t = 0, dt = 0, lastTime = 0;
  var cam = [0, 0];

  var score = 0, bestScore = parseInt(storeGet('best') || '0', 10) || 0, newRecord = false;
  var sector = 1, rescued = 0;
  var gameOverAt = 0;
  var hyperSpace = false, hyperSpaceEnd = 0;
  var laserSoundAt = 0;
  var needsFullClear = false;

  // Groups
  var backStars = [], backStarsMenu = [], playerBullets = [], enemyBullets = [], enemies = [],
    passengers = [], jumpPoints = [], particles = [], asteroids = [], itemsLife = [], itemsScore = [];

  // Shapes
  var passengerPts = [[0, 0], [-2, 2], [-1, 3], [0, 2], [0, 7], [1, 7], [1, 4], [2, 4], [2, 7], [3, 7], [3, 2], [4, 3],
    [5, 2], [3, 0], [2, 0], [2, -1], [3, -1], [3, -4], [0, -4], [0, -1], [1, -1], [1, 0], [0, 0]];
  var asteroidPts = [[-4, 0], [-2, -3], [1, -4], [4, -2], [3, 0], [3, 0], [4, 1], [4, 2], [2, 4], [-1, 4], [-2, 4], [-4, 0]];
  var propellerPts = [[0, 0], [-1, 0], [-3, -3], [3, -3], [1, 0], [0, 0]];
  var jumpPointPts = [[0, 0], [0, 3], [-2, 5], [-1, 6], [-1, 8], [-2, 9], [0, 11], [0, 14], [0, 11], [2, 9], [1, 8],
    [1, 6], [2, 5], [0, 3], [0, 0]];
  var arrowPts = [[0, 0], [-5, -3], [-5, 3], [0, 0]];

  /* Player tuple
   * 0 x, 1 y, 2 radius, 3 angle, 4 force x, 5 force y, 6 (unused), 7 acceleration,
   * 8 (unused), 9 (unused), 10 next shot time, 11 shot cadence, 12 life,
   * 13 hyperjump enabled, 14 laser energy */
  var player = [];
  var lastSafePosition = [0, 0];

  /* Turrets: [angle, initial angle, [offset x, offset y], active] (up, down, left, right) */
  var turrets = [];
  /* Laser beams: [x, y, angle, length, width, color] */
  var lasers = [[0, 0, 0, 128, 1, 1], [0, 0, 0, 128, 1, 1]];
  var laserCount = 0;

  /* Enemy wave: [spawn time, armed] */
  var enemyWave = [0, 0];

  function resetPlayer() {
    player = [0, 0, 64, -90, 0, 0, 0, 100, 0, 10, 0, 0.5, 100, false, 100];
    turrets = [
      [-90, -90, [0, -64], 0],
      [90, 90, [0, 64], 0],
      [180, 180, [-64, 0], 0],
      [0, 0, [64, 0], 0]
    ];
    lastSafePosition = [0, 0];
  }

  /* ---------------------------------------------------------------- */
  /* Dialogs of the ship's AI                                           */
  /* dialog tuple: 0 seconds per phrase, 1 current phrase, 2 phrases,   */
  /*               3 start time (-1 = idle)                             */
  /* ---------------------------------------------------------------- */
  var dialogs = [];
  var dialog = 0, showDialog = false, introPlayed = false;

  function buildDialogs() {
    var touch = touchMode;
    dialogs = [
      [1.6, 0, [
        'GREETINGS, COMMANDER.',
        'I AM THIS SHIP\'S AI.',
        'OUR MISSION:',
        'RESCUE EVERY STRANDED PASSENGER.',
        'GREEN ARROWS POINT TO PASSENGERS,',
        'RED ARROWS TO ENEMIES',
        'AND BLUE ARROWS TO JUMP POINTS.',
        touch ? 'HOLD THE SCREEN TO AIM AND FIRE.' : 'CLICK TO AIM AND FIRE.',
        'BULLETS CANNOT BREAK ASTEROIDS:',
        touch ? 'SWITCH TO THE LASER FOR THEM.' : 'RIGHT CLICK FIRES THE LASER.',
        'GOOD LUCK!'
      ], -1],
      [2, 0, ['ENEMIES DETECTED!'], -1],
      [2, 0, ['MORE PASSENGERS ARE WAITING', 'IN THIS SECTOR.'], -1],
      [3, 0, ['WE MUST RESCUE ALL PASSENGERS', 'BEFORE LEAVING THIS SECTOR!'], -1],
      [3, 0, [touch ? 'TAP JUMP FOR A HYPERSPACE JUMP.' : 'PRESS H FOR A HYPERSPACE JUMP.'], -1],
      [3, 0, ['NO MORE PASSENGERS HERE.', 'HEAD TO ANY BLUE JUMP POINT.'], -1],
      [2.5, 0, ['NEW SECTOR. FIND THE PASSENGERS!'], -1]
    ];
    dialog = 0;
    showDialog = false;
  }

  function callDialog(index) {
    dialog = index;
    showDialog = true;
    if (dialogs[dialog][3] === -1) dialogs[dialog][3] = t;
  }

  function updateDialog() {
    if (!showDialog) return;
    var d = dialogs[dialog];
    if (t > d[3] + d[0] * (d[1] + 1)) ++d[1];
    if (d[1] > d[2].length - 1) {
      d[1] = 0;
      d[3] = -1;
      showDialog = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                              */
  /* ---------------------------------------------------------------- */
  var keys = {};
  var aim = [0, 0];          // aim point in screen game units
  var aimVisible = false;
  var mouseFire = false, mouseLaser = false;
  var touchFirePointer = null;
  var weaponLaser = false;   // touch weapon toggle
  var pendingShot = false;   // a quick tap/click still fires one volley
  var stick = { pointer: null, cx: 0, cy: 0, dx: 0, dy: 0, active: false };
  var touchMode = !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);

  var stickEl = document.getElementById('stick');
  var stickKnob = document.getElementById('stick-knob');
  var weaponBtn = document.getElementById('btn-weapon');
  var jumpBtn = document.getElementById('btn-jump');
  var pauseBtn = document.getElementById('btn-pause');
  var muteBtn = document.getElementById('btn-mute');
  var pauseOverlay = document.getElementById('pause-overlay');
  var resumeBtn = document.getElementById('btn-resume');
  var restartBtn = document.getElementById('btn-restart');

  function setTouchMode(on) {
    if (touchMode === on) return;
    touchMode = on;
    root.classList.toggle('touch', on);
    // phrases mention the right controls
    if (!showDialog) buildDialogs();
  }

  function toScreen(e) {
    var r = screenCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H];
  }

  function firing() {
    if (touchMode) return touchFirePointer !== null && !weaponLaser;
    return mouseFire && !mouseLaser;
  }
  function lasering() {
    if (touchMode) return touchFirePointer !== null && weaponLaser;
    return mouseLaser;
  }

  // Audio can only start from a user activation (pointerup / keydown / click)
  ['pointerup', 'touchend', 'click', 'keydown'].forEach(function (type) {
    document.addEventListener(type, initAudio, true);
  });

  function onPrimaryAction() {
    if (paused) return;
    if (gameState === STATE_MENU) startGame();
    else if (gameState === STATE_OVER && t - gameOverAt > 0.8) restartGame();
  }

  screenCanvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setTouchMode(true);
    else setTouchMode(false);
    if (gameState === STATE_MENU || gameState === STATE_OVER) {
      onPrimaryAction();
      return;
    }
    if (paused) return;
    aim = toScreen(e);
    aimVisible = true;
    if (touchMode) {
      touchFirePointer = e.pointerId;
      if (!weaponLaser) pendingShot = true;
    } else {
      if (e.button === 2 || (e.button === 0 && e.shiftKey)) mouseLaser = true;
      else if (e.button === 0) { mouseFire = true; pendingShot = true; }
    }
    try { screenCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  screenCanvas.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse') {
      aim = toScreen(e);
      aimVisible = true;
    } else if (e.pointerId === touchFirePointer) {
      aim = toScreen(e);
    }
  });

  function releasePointer(e) {
    if (e.pointerId === touchFirePointer) touchFirePointer = null;
    if (e.pointerType === 'mouse') {
      mouseFire = false;
      mouseLaser = false;
    }
  }
  screenCanvas.addEventListener('pointerup', releasePointer);
  screenCanvas.addEventListener('pointercancel', releasePointer);
  screenCanvas.addEventListener('lostpointercapture', releasePointer);

  root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Virtual joystick (touch)
  var STICK_RADIUS = 46; // css px of knob travel
  stickEl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    setTouchMode(true);
    var r = stickEl.getBoundingClientRect();
    stick.pointer = e.pointerId;
    stick.cx = r.left + r.width / 2;
    stick.cy = r.top + r.height / 2;
    updateStick(e);
    try { stickEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  stickEl.addEventListener('pointermove', function (e) {
    if (e.pointerId === stick.pointer) updateStick(e);
  });
  function endStick(e) {
    if (e.pointerId !== stick.pointer) return;
    stick.pointer = null;
    stick.active = false;
    stick.dx = stick.dy = 0;
    stickKnob.style.transform = 'translate(-50%, -50%)';
  }
  stickEl.addEventListener('pointerup', endStick);
  stickEl.addEventListener('pointercancel', endStick);
  stickEl.addEventListener('lostpointercapture', endStick);

  function updateStick(e) {
    var dx = e.clientX - stick.cx, dy = e.clientY - stick.cy;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
    stick.dx = dx / STICK_RADIUS;
    stick.dy = dy / STICK_RADIUS;
    stick.active = true;
    stickKnob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
  }

  function pressButton(el, fn) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    });
    el.addEventListener('click', function (e) { e.preventDefault(); });
  }

  pressButton(weaponBtn, function () {
    weaponLaser = !weaponLaser;
    updateWeaponButton();
  });
  pressButton(jumpBtn, function () { tryHyperJump(); });
  pressButton(pauseBtn, function () { setPaused(!paused); });
  pressButton(muteBtn, function () {
    muted = !muted;
    storeSet('muted', muted ? '1' : '0');
    updateMuteButton();
  });
  pressButton(resumeBtn, function () { setPaused(false); });
  pressButton(restartBtn, function () {
    setPaused(false);
    restartGame();
  });

  function updateWeaponButton() {
    weaponBtn.textContent = weaponLaser ? 'LASER' : 'GUN';
    weaponBtn.classList.toggle('laser', weaponLaser);
    weaponBtn.setAttribute('aria-label', weaponLaser ? 'Weapon: laser (tap for gun)' : 'Weapon: gun (tap for laser)');
  }
  function updateMuteButton() {
    muteBtn.classList.toggle('off', muted);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  document.addEventListener('keydown', function (e) {
    var k = e.code || e.key;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].indexOf(k) >= 0) e.preventDefault();
    if (e.repeat) { keys[k] = true; return; }
    keys[k] = true;
    if (k === 'KeyP' || k === 'Escape') {
      if (gameState === STATE_PLAY || gameState === STATE_HYPER || paused) setPaused(!paused);
      return;
    }
    if (paused) return;
    if (gameState === STATE_MENU && (k === 'Enter' || k === 'Space')) onPrimaryAction();
    else if (gameState === STATE_OVER && (k === 'KeyR' || k === 'Enter' || k === 'Space')) onPrimaryAction();
    else if (k === 'KeyH' || k === 'Space') tryHyperJump();
  });
  document.addEventListener('keyup', function (e) {
    keys[e.code || e.key] = false;
  });
  window.addEventListener('blur', function () {
    keys = {};
    mouseFire = mouseLaser = false;
  });

  function setPaused(p) {
    if (p && !(gameState === STATE_PLAY || gameState === STATE_HYPER)) p = false;
    paused = p;
    pauseOverlay.hidden = !p;
    root.classList.toggle('paused', p);
    keys = {};
    mouseFire = mouseLaser = false;
    touchFirePointer = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) setPaused(true);
  });

  /* ---------------------------------------------------------------- */
  /* Drawing helpers (world coordinates, camera applied)                */
  /* ---------------------------------------------------------------- */
  function setColor(index, attribute) {
    ctx[attribute ? 'fillStyle' : 'strokeStyle'] = colors[index];
  }
  function orbit(origin, angle, distance) {
    return [origin[0] + Math.cos(toRad(angle)) * distance, origin[1] + Math.sin(toRad(angle)) * distance];
  }
  function angleTo(e1, e2) {
    return Math.atan2(e2[1] - e1[1], e2[0] - e1[0]);
  }
  function aabb(e1, e2) {
    return e1[0] - e1[2] < e2[0] + e2[2] && e1[0] + e1[2] > e2[0] - e2[2] &&
      e1[1] - e1[2] < e2[1] + e2[2] && e1[1] + e1[2] > e2[1] - e2[2];
  }
  function distanceTo(e1, e2) {
    var dx = e1[0] - e2[0], dy = e1[1] - e2[1];
    return Math.sqrt(dx * dx + dy * dy) - (e1[2] + e2[2]);
  }
  // returns the circle distance when bounding boxes overlap, undefined otherwise
  function collides(e1, e2) {
    if (aabb(e1, e2)) return distanceTo(e1, e2);
  }
  function touching(e1, e2) {
    var d = collides(e1, e2);
    return d !== undefined && d <= 0;
  }

  function drawLine(x, y, r, l, w) {
    ctx.save();
    ctx.lineWidth = w;
    ctx.translate(x - cam[0], y - cam[1]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(toRad(r)) * l, Math.sin(toRad(r)) * l);
    ctx.stroke();
    ctx.restore();
  }
  function fillRectangle(x, y, w, h, r) {
    ctx.save();
    ctx.translate(x - cam[0], y - cam[1]);
    if (r) ctx.rotate(toRad(r));
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  function strokeRectangle(x, y, w, h, r) {
    ctx.save();
    ctx.translate(x - cam[0], y - cam[1]);
    if (r) ctx.rotate(toRad(r));
    ctx.strokeRect(0, 0, w, h);
    ctx.restore();
  }
  function fillCircle(x, y, r, from, to) {
    ctx.save();
    ctx.beginPath();
    ctx.translate(x - cam[0], y - cam[1]);
    ctx.arc(0, 0, r, Math.PI * (from || 0), Math.PI * (to || 2), true);
    ctx.fill();
    ctx.restore();
  }
  function strokeCircle(x, y, r) {
    ctx.save();
    ctx.beginPath();
    ctx.translate(x - cam[0], y - cam[1]);
    ctx.arc(0, 0, r, 0, Math.PI * 2, true);
    ctx.stroke();
    ctx.restore();
  }
  // strokes and fills a polyline shape
  function drawShape(x, y, r, pts, scale) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.translate(x - cam[0], y - cam[1]);
    ctx.rotate(toRad(r));
    for (var i = 0; i < pts.length; ++i) {
      if (i === 0) ctx.moveTo(pts[i][0] * scale, pts[i][1] * scale);
      else ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
    }
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
  function text(str, x, y, size, align, lineWidth, color) {
    ctx.save();
    ctx.strokeStyle = color || colors[17];
    ctx.translate(x, y);
    font(str, size, align, lineWidth);
    ctx.restore();
  }

  function camFocus(e) {
    cam[0] = e[0] - W / 2;
    cam[1] = e[1] - H / 2;
  }

  /* ---------------------------------------------------------------- */
  /* Particles                                                          */
  /* 0 x, 1 y, 2 size, 3 angle, 4 velocity, 5 end time, 6 alpha,        */
  /* 7 color choices, 8 shape (0 stroke circle, 1 fill circle,          */
  /* 2 stroke square, 3 fill square), 9 alive, 10 chosen color          */
  /* ---------------------------------------------------------------- */
  function initParticles() {
    particles = [];
    for (var i = 60; i > 0; --i) particles.push([0, 0, 0, 0, 0, 0, 0, [17], 0, 0, 17]);
  }
  function spawnParticle(p) {
    for (var i = particles.length - 1; i >= 0; --i) {
      var e = particles[i];
      if (e[9] === 0) {
        for (var j = 0; j <= 8; ++j) e[j] = p[j];
        e[9] = 1;
        e[10] = e[7][Math.floor(Math.random() * e[7].length)];
        return;
      }
    }
  }
  function updateParticle(e) {
    if (e[9] !== 1) return;
    if (t > e[5]) e[9] = 0;
    e[0] += e[4] * Math.cos(toRad(e[3])) * dt;
    e[1] += e[4] * Math.sin(toRad(e[3])) * dt;
  }
  function drawParticle(e) {
    if (e[9] !== 1) return;
    ctx.lineWidth = 1;
    setColor(e[10], 0);
    setColor(e[10], 1);
    if (e[8] === 0) strokeCircle(e[0], e[1], e[2]);
    else if (e[8] === 1) fillCircle(e[0], e[1], e[2]);
    else if (e[8] === 2) strokeRectangle(e[0], e[1], e[2], e[2], e[3]);
    else fillRectangle(e[0], e[1], e[2], e[2], e[3]);
  }

  /* ---------------------------------------------------------------- */
  /* Stars                                                              */
  /* ---------------------------------------------------------------- */
  function resetBackStars() {
    // amount scales with the visible area
    var n = Math.round(128 * (W * H) / (800 * 640));
    backStars = [];
    for (var i = n; i > 0; --i) {
      backStars.push([cam[0] + Math.random() * W, cam[1] + Math.random() * H, 1 + Math.random() * 2]);
    }
  }
  function updateBackStar(e) {
    if (e[0] - cam[0] < 0) e[0] += W;
    else if (e[0] - cam[0] > W) e[0] -= W;
    if (e[1] - cam[1] < 0) e[1] += H;
    else if (e[1] - cam[1] > H) e[1] -= H;
  }
  function drawBackStar(e) {
    setColor(17, 1);
    fillCircle(e[0], e[1], e[2]);
  }

  // Tunnel stars of the title screen / hyperspace: 0 x, 1 y, 2 size, 3 direction, 4 start time
  function initMenuStars() {
    backStarsMenu = [];
    for (var i = 128; i >= 0; --i) {
      var a = Math.random() * Math.PI * 2;
      var d = Math.random() * Math.max(W, H) * 0.6;
      backStarsMenu.push([W / 2 + Math.cos(a) * d, H / 2 + Math.sin(a) * d, 0, a, Math.random() * 1.5]);
    }
  }
  function updateMenuStar(e) {
    if (e[4] > t) return;
    var vel = hyperSpace ? 512 : 100;
    e[0] += vel * Math.cos(e[3]) * dt;
    e[1] += vel * Math.sin(e[3]) * dt;
    var dx = e[0] - W / 2, dy = e[1] - H / 2;
    e[2] = Math.sqrt(dx * dx + dy * dy) * 0.01;
    if (e[0] > W || e[0] < 0 || e[1] > H || e[1] < 0) {
      var a = Math.random() * Math.PI * 2;
      e[0] = W / 2 + Math.cos(a) * 6;
      e[1] = H / 2 + Math.sin(a) * 6;
      e[2] = 0;
      e[3] = a;
    }
  }
  function drawMenuStar(e) {
    setColor(17, 1);
    fillCircle(e[0], e[1], e[2]);
  }

  /* ---------------------------------------------------------------- */
  /* Scene                                                              */
  /* ---------------------------------------------------------------- */
  function createWaveEnemy() {
    enemyWave[0] = t + random(5, 15);
    if (dialog === 0 && showDialog) {
      enemyWave[0] = t + dialogs[0][2].length * dialogs[0][0] + random(5, 15);
    }
    enemyWave[1] = 1;
  }

  function destroyScene() {
    passengers = [];
    asteroids = [];
    jumpPoints = [];
    enemies = [];
    enemyBullets = [];
    itemsLife = [];
    itemsScore = [];
  }

  function createScene(s) {
    seed = s || 0;
    asteroids = [];
    var i, j, op;
    // Passengers (1-2)
    for (i = random(1, 3) - 1; i >= 0; --i) {
      op = orbit([0, 0], random(0, 360), random(512, 1024));
      passengers.push([op[0], op[1], 20, random(0, 360)]);
    }
    // Asteroid fields around each passenger
    for (i = passengers.length - 1; i >= 0; --i) {
      for (j = random(6, 12) - 1; j >= 0; --j) {
        op = orbit(passengers[i], random(0, 360), random(128, 1024));
        // 0 x, 1 y, 2 radius, 3 angle, 4 force x, 5 force y, 6 life, 7 scale
        var asteroid = [op[0], op[1], 100, random(0, 360), 0, 0, 150, 1];
        if (!touching(player, asteroid) && collides(player, asteroid) === undefined) asteroids.push(asteroid);
      }
    }
    // Jump points (1-2)
    for (i = random(1, 3) - 1; i >= 0; --i) {
      op = orbit(player, random(0, 360), random(1024, 1500));
      jumpPoints.push([op[0], op[1], 128, random(0, 360)]);
    }
    createWaveEnemy();
  }

  /* ---------------------------------------------------------------- */
  /* Asteroids                                                          */
  /* ---------------------------------------------------------------- */
  function aimWorld() {
    return [aim[0] + cam[0], aim[1] + cam[1]];
  }

  function updateAsteroid(e, j) {
    e[0] += e[4] * dt;
    e[1] += e[5] * dt;
    e[3] += 10 * dt;
    // bullets are absorbed by asteroids
    for (var i = playerBullets.length - 1; i >= 0; --i) {
      if (playerBullets[i][7] === 1 && distanceTo(e, playerBullets[i]) <= 0) playerBullets[i][7] = 0;
    }
    // the laser drills them
    var a = aimWorld();
    if (laserCount > 0 && player[14] > 0 && collides([a[0], a[1], 2], e) !== undefined && distanceTo([a[0], a[1], 2], e) <= 0) {
      e[6] -= 100 * dt;
      spawnParticle([a[0], a[1], 6 + Math.random() * 6, Math.random() * 360, 25, t + 0.6 + Math.random() * 0.4, 1, [14], 2]);
    }
    if (e[6] <= 0) {
      if (Math.random() * 10 > 9) itemsScore.push([e[0], e[1], 16, 0]);
      play('rock');
      score += 5;
      var s = e[7] / 2;
      if (s >= 0.5) {
        asteroids.push([e[0] + Math.random() * e[2] * s, e[1] + Math.random() * e[2] * s, e[2] * s, Math.random() * 360, 0, 0, 150, s]);
        asteroids.push([e[0] - Math.random() * e[2] * s, e[1] - Math.random() * e[2] * s, e[2] * s, Math.random() * 360, 0, 0, 150, s]);
      }
      for (var k = 5; k >= 0; --k) {
        spawnParticle([e[0], e[1], e[2] / 4 + Math.random() * e[2] / 4, Math.random() * 360, 7 + Math.random() * 18, t + 0.6 + Math.random() * 0.4, 1, [14, 24, 25], 2]);
      }
      asteroids.splice(j, 1);
    }
  }
  function drawAsteroid(e) {
    setColor(24, 0);
    setColor(25, 1);
    ctx.lineWidth = 10;
    drawShape(e[0], e[1], e[3], asteroidPts, 26 * e[7]);
  }

  /* ---------------------------------------------------------------- */
  /* Passengers, jump points, items                                     */
  /* ---------------------------------------------------------------- */
  function updatePassenger(e) {
    e[1] += Math.sin(t * 5) * 30 * dt;
    e[3] += 64 * dt;
  }
  function drawPassenger(e) {
    setColor(4, 1);
    setColor(17, 0);
    ctx.lineWidth = 3;
    drawShape(e[0], e[1], e[3], passengerPts, 5);
  }
  function updateJumpPoint(e) {
    if (e[2] > 256) e[2] = 0;
    e[2] += 100 * dt;
  }
  function drawJumpPoint(e) {
    setColor(6, 1);
    setColor(17, 0);
    ctx.lineWidth = 3;
    drawShape(e[0], e[1], e[3], jumpPointPts, 3);
    ctx.lineWidth = 1;
    strokeCircle(e[0], e[1], e[2]);
  }
  function updateItem(e) {
    e[1] += Math.sin(t * 2) * 12 * dt;
  }
  function drawItem(e, color, letter) {
    setColor(color, 1);
    setColor(17, 0);
    fillCircle(e[0], e[1], e[2]);
    ctx.save();
    ctx.translate(e[0] - cam[0] + 4, e[1] - cam[1] - 5);
    font(letter, 1, 0, 2);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Bullets                                                            */
  /* 0 x, 1 y, 2 radius, 3 angle, 4 velocity, 5 end time,               */
  /* 6 shrink time, 7 active (player bullets are pooled)                */
  /* ---------------------------------------------------------------- */
  function spawnPlayerBullet(b) {
    for (var i = playerBullets.length - 1; i >= 0; --i) {
      if (playerBullets[i][7] === 0) { playerBullets[i] = b; return; }
    }
    playerBullets.push(b);
  }
  function updatePlayerBullet(e) {
    if (e[7] === 0) return;
    if (t > e[5]) e[7] = 0;
    if (t > e[6]) e[2] = 4;
    e[0] += e[4] * Math.cos(toRad(e[3])) * dt;
    e[1] += e[4] * Math.sin(toRad(e[3])) * dt;
  }
  function drawPlayerBullet(e) {
    if (e[7] === 0) return;
    setColor(21, 0);
    drawLine(e[0], e[1], e[3], 12, 4);
  }
  function updateEnemyBullet(e, i) {
    if (t > e[5]) { enemyBullets.splice(i, 1); return; }
    if (t > e[6]) e[2] = 4;
    e[0] += e[4] * Math.cos(toRad(e[3])) * dt;
    e[1] += e[4] * Math.sin(toRad(e[3])) * dt;
  }
  function drawEnemyBullet(e) {
    setColor(22, 1);
    fillCircle(e[0], e[1], e[2]);
  }

  /* ---------------------------------------------------------------- */
  /* Enemies                                                            */
  /* 0 x, 1 y, 2 radius, 3 angle, 4 force x, 5 force y, 6 next shot,    */
  /* 7 acceleration, 8 (unused), 9 life                                 */
  /* ---------------------------------------------------------------- */
  function spawnEnemyWave() {
    play('alarm');
    callDialog(1);
    enemyWave[1] = 0;
    var dist = Math.max(800, Math.sqrt(W * W + H * H) / 2 + 96);
    for (var i = random(1, 5) - 1; i >= 0; --i) {
      var op = orbit(player, random(0, 360), random(dist, dist + 256));
      enemies.push([op[0], op[1], 24, 0, 0, 0, t + 3, 100, 1, 100]);
    }
  }

  function updateEnemy(e, j) {
    var maxVel = 64;
    e[3] = toDeg(angleTo(e, player));
    var d = distanceTo(e, player);
    var dir = d > 100 ? 1 : -1;
    if (Math.abs(e[4]) <= maxVel) e[4] += dir * e[7] * Math.cos(toRad(e[3])) * dt;
    if (Math.abs(e[5]) <= maxVel) e[5] += dir * e[7] * Math.sin(toRad(e[3])) * dt;
    e[4] = Math.max(-maxVel, Math.min(maxVel, e[4]));
    e[5] = Math.max(-maxVel, Math.min(maxVel, e[5]));
    e[0] += e[4] * dt;
    e[1] += e[5] * dt;

    if (d < 110 && e[6] < t && player[12] > 0) {
      play('enemyShot');
      e[6] = t + 1 + Math.random() * 6;
      var c = orbit(e, e[3], e[2] + 12);
      enemyBullets.push([c[0], c[1], 12, e[3] - 7 + Math.random() * 14, 80, t + 2.5, t + 0.05]);
    }

    for (var i = playerBullets.length - 1; i >= 0; --i) {
      var b = playerBullets[i];
      if (b[7] === 1 && touching(e, b)) {
        e[9] -= 25;
        for (var k = 8; k >= 0; --k) {
          spawnParticle([e[0], e[1], 2 + Math.random() * 2, Math.random() * 360, 7 + Math.random() * 18, t + 0.6 + Math.random() * 0.4, 1, [16], 2]);
        }
        b[7] = 0;
      }
    }
    if (e[9] <= 0) {
      score += 10;
      play('explosion');
      for (var p = 8; p >= 0; --p) {
        spawnParticle([e[0], e[1], e[2] / 2 + Math.random() * e[2] / 2, Math.random() * 360, 7 + Math.random() * 18, t + 0.6 + Math.random() * 0.4, 1, [14], 2]);
      }
      if (Math.random() * 10 > 8) itemsLife.push([e[0], e[1], 16, 0]);
      if (enemies.length === 1) createWaveEnemy();
      enemies.splice(j, 1);
    }
  }

  function drawEnemy(e) {
    setColor(14, 0);
    drawLine(e[0], e[1], e[3], 38, 6);
    setColor(14, 1);
    var op = orbit(e, e[3], e[2]);
    fillCircle(op[0], op[1], 8);
    fillCircle(e[0], e[1], e[2]);
    ctx.lineWidth = 1;
    setColor(17, 0);
    strokeCircle(e[0], e[1], e[2] - 2);
    strokeCircle(e[0], e[1], e[2] - 5);
    setColor(18, 1);
    fillRectangle(e[0] - 15, e[1] - 8, 30, 16);
    setColor(4, 1);
    fillRectangle(e[0] - 4, e[1], 8, 8);
    fillRectangle(e[0] - 4, e[1] - 4, 2, 4);
    fillRectangle(e[0] + 2, e[1] - 4, 2, 4);
    setColor(9, 1);
    fillRectangle(e[0] - 3, e[1] + 2, 3, 3);
    fillRectangle(e[0] + 3, e[1] + 2, 3, 3);
  }

  /* ---------------------------------------------------------------- */
  /* Player                                                             */
  /* ---------------------------------------------------------------- */
  function tryHyperJump() {
    if (paused || gameState !== STATE_PLAY || !player[13]) return;
    play('hyperspace');
    gameState = STATE_HYPER;
    hyperSpace = true;
    hyperSpaceEnd = t + 3.5;
    showDialog = false;
    destroyScene();
    player[0] = W / 2;
    player[1] = H / 2;
    player[4] = player[5] = 0;
    initMenuStars();
    needsFullClear = true;
  }

  function shoot() {
    play('shot');
    player[10] = t + player[11];
    for (var i = turrets.length - 1; i >= 0; --i) {
      if (turrets[i][3] === 1) {
        var op = orbit([turrets[i][2][0], turrets[i][2][1]], turrets[i][0], 18);
        spawnPlayerBullet([player[0] + op[0], player[1] + op[1], 12, turrets[i][0], 200, t + 1.5, t + 0.05, 1]);
      }
    }
  }

  function fireLaser() {
    if (player[14] > 5 && t > laserSoundAt) {
      play('shot');
      laserSoundAt = t + 0.08;
    }
    player[14] -= 20 * dt;
    var target = aimWorld();
    laserCount = 0;
    for (var i = turrets.length - 1; i >= 0; --i) {
      if (turrets[i][3] === 1) {
        var r = orbit([player[0] + turrets[i][2][0], player[1] + turrets[i][2][1]], turrets[i][0], 12);
        var beam = lasers[laserCount];
        var dx = target[0] - r[0], dy = target[1] - r[1];
        beam[0] = r[0];
        beam[1] = r[1];
        beam[2] = toDeg(angleTo(r, target));
        beam[3] = Math.sqrt(dx * dx + dy * dy);
        ++laserCount;
      }
    }
  }

  function drawLasers() {
    if (player[14] <= 0) return;
    for (var i = 0; i < laserCount; i++) {
      var b = lasers[i];
      setColor(b[5], 1);
      setColor(b[5], 0);
      drawLine(b[0], b[1], b[2], b[3], b[4] + 1);
    }
  }

  function steer() {
    var turn = 0, thrust = false;
    var rotSpeed = 64;
    if (keys.KeyA || keys.ArrowLeft) turn = -1;
    else if (keys.KeyD || keys.ArrowRight) turn = 1;
    if (keys.KeyW || keys.ArrowUp) thrust = true;
    if (stick.active) {
      var mag = Math.sqrt(stick.dx * stick.dx + stick.dy * stick.dy);
      if (mag > 0.3) {
        // rotate toward the stick direction, thrust when roughly aligned
        var target = toDeg(Math.atan2(stick.dy, stick.dx));
        var diff = ((target - player[3]) % 360 + 540) % 360 - 180;
        rotSpeed = 110;
        if (Math.abs(diff) > 2) turn = diff > 0 ? 1 : -1;
        if (Math.abs(diff) < rotSpeed * dt) { player[3] = target; turn = 0; }
        thrust = mag > 0.55 && Math.abs(diff) < 60;
      }
    }
    player[3] += turn * rotSpeed * dt;
    if (thrust) {
      var maxVel = 36;
      if (Math.abs(player[4]) <= maxVel) player[4] += player[7] * Math.cos(toRad(player[3])) * dt;
      if (Math.abs(player[5]) <= maxVel) player[5] += player[7] * Math.sin(toRad(player[3])) * dt;
      if (Math.floor(t * 60) % 10 === 0) {
        var pp = orbit(player, player[3] + 180, player[2] + 12);
        spawnParticle([pp[0], pp[1], 5 + Math.random() * 4, player[3] + 180 - 7 + Math.random() * 14, 12, t + 0.6 + Math.random() * 0.4, 0.8, [15, 16, 11, 12], 0]);
      }
      player[4] = Math.max(-maxVel, Math.min(maxVel, player[4]));
      player[5] = Math.max(-maxVel, Math.min(maxVel, player[5]));
    }
  }

  function gameOver() {
    gameState = STATE_OVER;
    gameOverAt = t;
    newRecord = score > bestScore;
    if (newRecord) {
      bestScore = score;
      storeSet('best', String(bestScore));
    }
    touchFirePointer = null;
    mouseFire = mouseLaser = false;
  }

  function updatePlayer() {
    if (player[12] <= 0) { gameOver(); return; }
    player[0] += player[4] * dt;
    player[1] += player[5] * dt;

    // Turrets facing the aim point become active and track it
    var rel = [aim[0] - W / 2, aim[1] - H / 2];
    var target = aimWorld();
    turrets[0][3] = rel[1] < 0 ? 1 : 0;
    turrets[1][3] = rel[1] > 0 ? 1 : 0;
    turrets[2][3] = rel[0] < 0 ? 1 : 0;
    turrets[3][3] = rel[0] > 0 ? 1 : 0;
    for (var l = turrets.length - 1; l >= 0; --l) {
      if (turrets[l][3] === 1) {
        turrets[l][0] = toDeg(angleTo([player[0] + turrets[l][2][0], player[1] + turrets[l][2][1]], target));
      }
    }

    laserCount = 0;
    if (gameState === STATE_PLAY) {
      if ((firing() || pendingShot) && t > player[10]) { shoot(); pendingShot = false; }
      if (lasering()) fireLaser();
    }
    if (!lasering() && player[14] <= 100) player[14] += 7 * dt;
    player[14] = Math.max(0, Math.min(100, player[14]));

    steer();
    if (gameState !== STATE_PLAY) return;

    // Asteroids: bounce back and take damage
    var hit = false;
    for (l = asteroids.length - 1; l >= 0; --l) {
      if (touching(player, asteroids[l])) { hit = true; break; }
    }
    if (hit) {
      play('hit');
      player[12] -= 5;
      player[4] = -player[4];
      player[5] = -player[5];
      player[0] = lastSafePosition[0];
      player[1] = lastSafePosition[1];
    } else {
      lastSafePosition[0] = player[0];
      lastSafePosition[1] = player[1];
    }

    // Passengers
    for (l = passengers.length - 1; l >= 0; --l) {
      if (touching(player, passengers[l])) {
        callDialog(passengers.length > 1 ? 2 : 5);
        ++rescued;
        score += 150;
        play('passenger');
        for (var c = 7; c >= 0; --c) {
          spawnParticle([passengers[l][0], passengers[l][1], 12 + Math.random() * 12, Math.random() * 360, 24, t + 0.6 + Math.random() * 0.4, 0.8, [4], 0]);
        }
        passengers.splice(l, 1);
      }
    }

    // Jump points
    for (l = jumpPoints.length - 1; l >= 0; --l) {
      if (collides(player, jumpPoints[l]) !== undefined) {
        if (passengers.length > 0) {
          player[13] = false;
          callDialog(3);
        } else {
          player[13] = true;
          callDialog(4);
        }
      }
    }

    // Enemy bullets
    for (l = enemyBullets.length - 1; l >= 0; --l) {
      if (touching(player, enemyBullets[l])) {
        play('hit');
        enemyBullets.splice(l, 1);
        player[12] = Math.max(0, player[12] - 5);
      }
    }

    // Repair kits
    for (l = itemsLife.length - 1; l >= 0; --l) {
      if (touching(player, itemsLife[l])) {
        play('life');
        player[12] = Math.min(100, player[12] + 10);
        itemsLife.splice(l, 1);
      }
    }
    // Bonus items
    for (l = itemsScore.length - 1; l >= 0; --l) {
      if (touching(player, itemsScore[l])) {
        play('life');
        score += 200;
        itemsScore.splice(l, 1);
      }
    }
  }

  function drawControl(x, y, a) {
    ctx.lineWidth = 2;
    setColor(9, 1);
    fillCircle(x, y, 6);
    setColor(16, 0);
    for (var i = 4; i >= 0; --i) drawLine(x, y, a + i * 90, 4, 2);
  }

  function drawPilot() {
    var b = Math.sin(t * 4), x = player[0], y = player[1] + 18;
    if (player[12] <= 0) b = 0;
    setColor(14, 1);
    fillCircle(x, y + b, 14);
    fillCircle(x - 14, y + b, 4);
    fillCircle(x + 14, y + b, 4);
    setColor(17, 1);
    fillCircle(x - 4, y + b, 6);
    fillCircle(x + 4, y + b, 6);
    setColor(26, 1);
    if (player[12] > 0) {
      if (Math.floor(t * 12) % 12 === 1) {
        fillRectangle(x - 3, y + b, 3, 2);
        fillRectangle(x + 3, y + b, 3, 2);
      } else {
        fillCircle(x - 3, y + b, 2);
        fillCircle(x + 3, y + b, 2);
      }
    } else {
      fillRectangle(x - 3, y + b, 6, 2);
      fillRectangle(x + 4, y + b, 6, 2);
    }
  }

  function drawMinimap() {
    var x = player[0], y = player[1] - 33, r = 22;
    setColor(10, 1);
    fillCircle(x, y, r);
    drawMiniArrows(x, y, r, enemies, 16);
    drawMiniArrows(x, y, r, passengers, 4);
    drawMiniArrows(x, y, r, jumpPoints, 6);
  }
  function drawMiniArrows(x, y, r, items, color) {
    for (var i = items.length - 1; i >= 0; --i) {
      var a = toDeg(angleTo([x, y], items[i]));
      var p = orbit([x, y], a, r);
      setColor(color, 1);
      setColor(color, 0);
      drawShape(p[0], p[1], a, arrowPts, 1);
    }
  }

  function drawPlayer() {
    var x = player[0], y = player[1], r = player[2];
    // propeller
    setColor(12, 0);
    setColor(12, 1);
    var op = orbit(player, player[3] + 180, r + 2);
    ctx.lineWidth = 2;
    drawShape(op[0], op[1], player[3] + 270, propellerPts, 5);
    // turrets
    for (var i = turrets.length - 1; i >= 0; --i) {
      var tx = x + turrets[i][2][0], ty = y + turrets[i][2][1];
      if (turrets[i][3] === 1) {
        setColor(17, 1);
        fillCircle(tx, ty, 10);
      }
      setColor(16, 1);
      setColor(16, 0);
      fillCircle(tx, ty, 8);
      drawLine(tx, ty, turrets[i][0], 12, 6);
    }
    // hull and cabin
    setColor(8, 1);
    fillCircle(x, y, r);
    setColor(20, 1);
    fillRectangle(x - 50, y - 8, 100, 38);
    drawPilot();
    // rudder
    setColor(10, 0);
    ctx.lineWidth = 2;
    strokeCircle(x - 12, y + 28, 8);
    for (i = 8; i >= 0; --i) drawLine(x - 12, y + 28, i * 45 + player[3] * 10, 12, 2);
    setColor(8, 1);
    fillCircle(x, y - 8, r, 0.8, 0.2);
    // hull integrity
    setColor(16, 1);
    fillRectangle(x - 35, y + 38, 70, 6);
    setColor(4, 1);
    fillRectangle(x - 35, y + 38, Math.max(0, player[12]) / 100 * 70, 6);
    // laser energy
    setColor(16, 1);
    fillRectangle(x - 35, y - 42, 3, 32);
    setColor(6, 1);
    fillRectangle(x - 35, y - 42, 3, player[14] / 100 * 32);
    // turret controls
    setColor(17, 1);
    var cx = [-42, -30, 30, 42];
    for (i = 0; i < 4; i++) if (turrets[i][3] === 1) fillCircle(x + cx[i], y, 7);
    for (i = 0; i < 4; i++) drawControl(x + cx[i], y, turrets[i][0]);
    // outer lines
    setColor(17, 0);
    ctx.lineWidth = 1;
    strokeCircle(x, y, r - 2);
    strokeCircle(x, y, r - 5);
    drawMinimap();
    drawLasers();
  }

  function drawCrosshair() {
    if (!aimVisible || (touchMode && touchFirePointer === null)) return;
    setColor(11, 0);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(aim[0], aim[1], 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* ---------------------------------------------------------------- */
  /* AI dialog box                                                      */
  /* ---------------------------------------------------------------- */
  function dialogAtTop() {
    return touchMode && W < 1100;
  }

  function drawDialog() {
    if (!showDialog || hyperSpace) return;
    var mx = W / 2 - 256;
    var my = dialogAtTop() ? 112 : H - 192;
    ctx.save();
    ctx.lineWidth = 1;
    setColor(6, 0);
    ctx.strokeRect(mx, my, 512, 128);
    ctx.globalAlpha = 0.1;
    setColor(5, 1);
    ctx.fillRect(mx, my, 512, 128);
    ctx.globalAlpha = 0.85;
    setColor(26, 1);
    ctx.fillRect(mx + 1, my + 1, 510, 126);
    ctx.globalAlpha = 1;
    // the AI's face: a red eye
    var b = Math.floor(t * 20) % 20;
    setColor(19, 1);
    ctx.fillRect(mx + 30, my + 14, 68, 104);
    setColor(26, 1);
    ctx.fillRect(mx + 32, my + 16, 64, 100);
    setColor(19, 1);
    ctx.beginPath();
    ctx.arc(mx + 64, my + 80, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(mx + 64, my + 80);
    var grd = ctx.createRadialGradient(0, 0, 12 * (b / 10), 0, 0, 26);
    grd.addColorStop(0, '#f00');
    grd.addColorStop(1, '#000');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    setColor(11, 1);
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    var d = dialogs[dialog];
    text(d[2][d[1]] || '', mx + 124, my + 59, 1, 1, 1.5);
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                                */
  /* ---------------------------------------------------------------- */
  function drawHud() {
    var right = W - 64, top = 52;
    text('SCORE: ' + score, right, top, 1.2, -1, 1.5);
    text('BEST: ' + Math.max(bestScore, score), right, top + 22, 1, -1, 1);
    text('SECTOR ' + sector, right, top + 42, 1, -1, 1, colors[1]);
  }

  /* ---------------------------------------------------------------- */
  /* Main update / draw                                                 */
  /* ---------------------------------------------------------------- */
  function update() {
    switch (gameState) {
      case STATE_MENU:
        backStarsMenu.forEach(updateMenuStar);
        camFocus([W / 2, H / 2]);
        break;
      case STATE_PLAY:
        camFocus(player);
        for (var i = asteroids.length - 1; i >= 0; --i) updateAsteroid(asteroids[i], i);
        backStars.forEach(updateBackStar);
        playerBullets.forEach(updatePlayerBullet);
        for (i = enemyBullets.length - 1; i >= 0; --i) updateEnemyBullet(enemyBullets[i], i);
        for (i = enemies.length - 1; i >= 0; --i) updateEnemy(enemies[i], i);
        passengers.forEach(updatePassenger);
        jumpPoints.forEach(updateJumpPoint);
        particles.forEach(updateParticle);
        itemsLife.forEach(updateItem);
        itemsScore.forEach(updateItem);
        updateDialog();
        updatePlayer();
        if (gameState === STATE_PLAY && t >= enemyWave[0] && enemyWave[1] === 1) spawnEnemyWave();
        camFocus(player);
        break;
      case STATE_HYPER:
        camFocus([W / 2, H / 2]);
        player[0] = W / 2;
        player[1] = H / 2;
        updatePlayer();
        backStarsMenu.forEach(updateMenuStar);
        particles.forEach(updateParticle);
        if (t >= hyperSpaceEnd) arriveInNewSector();
        break;
      case STATE_OVER:
        camFocus(player);
        particles.forEach(updateParticle);
        break;
    }
  }

  function arriveInNewSector() {
    hyperSpace = false;
    gameState = STATE_PLAY;
    player[0] = 0;
    player[1] = 0;
    player[13] = false;
    lastSafePosition = [0, 0];
    ++sector;
    createScene(Math.floor(random(2, 1000)));
    camFocus(player);
    resetBackStars();
    callDialog(6);
  }

  function clear(colorIndex) {
    setColor(colorIndex, 1);
    ctx.fillRect(0, 0, W, H);
  }

  function draw() {
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    switch (gameState) {
      case STATE_MENU:
        clear(0);
        backStarsMenu.forEach(drawMenuStar);
        drawMenu();
        break;
      case STATE_PLAY:
        clear(27);
        drawWorld();
        drawPlayer();
        drawCrosshair();
        drawDialog();
        drawHud();
        break;
      case STATE_HYPER:
        clear(needsFullClear ? 27 : 28);
        needsFullClear = false;
        backStarsMenu.forEach(drawMenuStar);
        drawPlayer();
        text('HYPERSPACE', W / 2, H / 2 - 150, 1.5, 0, 1.5, colors[1]);
        break;
      case STATE_OVER:
        clear(27);
        drawWorld();
        drawPlayer();
        drawGameOver();
        break;
    }
    drawPostProcessing();
  }

  function drawWorld() {
    backStars.forEach(drawBackStar);
    asteroids.forEach(drawAsteroid);
    enemies.forEach(drawEnemy);
    playerBullets.forEach(drawPlayerBullet);
    enemyBullets.forEach(drawEnemyBullet);
    passengers.forEach(drawPassenger);
    jumpPoints.forEach(drawJumpPoint);
    particles.forEach(drawParticle);
    itemsLife.forEach(function (e) { drawItem(e, 8, 'L'); });
    itemsScore.forEach(function (e) { drawItem(e, 5, 'S'); });
  }

  function cycleColor() {
    return colors[1 + Math.floor(t * 24) % 20];
  }

  function drawMenu() {
    var titleSize = Math.min(3.2, (W - 60) / (11 * 17));
    var cy = H / 2;
    text('STRANDED', W / 2, cy - 190, titleSize * 1.3, 0, 5, cycleColor());
    text('IN SPACE', W / 2, cy - 130, titleSize, 0, 4, cycleColor());
    if (Math.floor(t * 2) % 2 === 1) {
      text(touchMode ? 'TAP TO START' : 'CLICK OR PRESS ENTER TO START', W / 2, cy - 20, 1.3, 0, 1.5);
    }
    var lines = touchMode ? [
      'LEFT STICK: STEER AND THRUST',
      'HOLD THE SCREEN: AIM AND FIRE',
      'GUN / LASER BUTTON: SWITCH WEAPON',
      'JUMP: HYPERSPACE WHEN READY'
    ] : [
      'MOUSE: AIM     LEFT CLICK: FIRE',
      'RIGHT CLICK OR SHIFT+CLICK: LASER',
      'W A D OR ARROWS: FLY',
      'H OR SPACE: HYPERSPACE JUMP     P: PAUSE'
    ];
    for (var i = 0; i < lines.length; i++) {
      text(lines[i], W / 2, cy + 50 + i * 26, 1, 0, 1, colors[18]);
    }
    text('RESCUE THE PASSENGERS. AVOID ASTEROIDS AND ALIENS.', W / 2, cy + 170, 0.9, 0, 1, colors[1]);
    if (bestScore > 0) text('BEST SCORE: ' + bestScore, W / 2, cy + 200, 1, 0, 1, colors[11]);
    text('ORIGINAL GAME BY MARC GUINEA - JS13K 2017', W / 2, H - 56, 0.8, 0, 1, colors[19]);
  }

  function drawGameOver() {
    var cy = H / 2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    setColor(26, 1);
    ctx.fillRect(W / 2 - 300, cy - 200, 600, 130);
    ctx.fillRect(W / 2 - 300, cy + 90, 600, 60);
    ctx.restore();
    text('SHIP LOST', W / 2, cy - 190, 2, 0, 2, colors[15]);
    text('YOUR SCORE: ' + score, W / 2, cy - 150, 1.5, 0, 1.5);
    text('BEST SCORE: ' + bestScore + '     SECTOR ' + sector + '     RESCUED ' + rescued, W / 2, cy - 118, 1, 0, 1, colors[18]);
    if (newRecord) text('NEW RECORD!', W / 2, cy - 96, 1, 0, 1.5, cycleColor());
    if (t - gameOverAt > 0.8 && Math.floor(t * 2) % 2 === 0) {
      text(touchMode ? 'TAP TO TRY AGAIN' : 'CLICK OR PRESS R TO TRY AGAIN', W / 2, cy + 112, 1.2, 0, 1.5);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Game flow                                                          */
  /* ---------------------------------------------------------------- */
  function newGame() {
    t = 0;
    score = 0;
    sector = 1;
    rescued = 0;
    newRecord = false;
    hyperSpace = false;
    resetPlayer();
    destroyScene();
    playerBullets = [];
    initParticles();
    buildDialogs();
    if (!introPlayed) {
      callDialog(0);
      introPlayed = true;
    }
    createScene(1);
    camFocus(player);
    resetBackStars();
    aim = [W / 2, H / 2 - 100];
    gameState = STATE_PLAY;
  }

  function startGame() { newGame(); }
  function restartGame() { newGame(); }

  function updateUi() {
    var playing = gameState === STATE_PLAY || gameState === STATE_HYPER;
    root.classList.toggle('playing', playing);
    var canJump = gameState === STATE_PLAY && player[13] === true;
    jumpBtn.classList.toggle('ready', canJump);
  }

  function loop(now) {
    if (!lastTime) lastTime = now;
    dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    if (!paused) {
      t += dt;
      update();
      draw();
    }
    updateUi();
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                               */
  /* ---------------------------------------------------------------- */
  root.classList.toggle('touch', touchMode);
  resetPlayer();
  buildDialogs();
  initParticles();
  updateWeaponButton();
  updateMuteButton();
  resize();
  initMenuStars();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 150); });

  // Small hook for automated screenshots/tests (read-only helpers + state access)
  window.strandedDebug = {
    state: function () { return { state: gameState, t: t, score: score, player: player, sector: sector }; },
    world: function () { return { asteroids: asteroids, enemies: enemies, passengers: passengers, jumpPoints: jumpPoints }; },
    setAim: function (x, y) { aim = [x, y]; aimVisible = true; },
    view: function () { return { W: W, H: H }; },
    spawnWave: function () { enemyWave[0] = t; },
    skipIntro: function () { showDialog = false; dialogs[0][1] = 0; dialogs[0][3] = -1; },
    damage: function (n) { player[12] -= n; }
  };

  requestAnimationFrame(loop);
})();
