 

// =============================================================================
// GRAPHICS PIPELINE OVERVIEW
// =============================================================================
// The Canvas 2D API maps onto a simplified software graphics pipeline:
//
//  ┌─────────────────────┐
//  │  APPLICATION STAGE  │  CPU — game logic, physics, AI, input, world state
//  ├─────────────────────┤
//  │   GEOMETRY STAGE    │  CPU → GPU — define shapes as paths/vertices,
//  │                     │  apply transforms, clip to viewport
//  ├─────────────────────┤
//  │ RASTERIZATION STAGE │  GPU — convert vector paths to pixels,
//  │                     │  fill/stroke with color, apply effects (shadow, blend)
//  └─────────────────────┘
//
// Each function below is annotated with which stage(s) it belongs to.
// =============================================================================


// =============================================================================
// SETUP — shared by all stages (constants live in APPLICATION, canvas context
// is the bridge from GEOMETRY to RASTERIZATION)
// =============================================================================

const canvas = document.getElementById('rink');
const ctx = canvas.getContext('2d');   // ctx is the API surface bridging GEOMETRY → RASTERIZATION
const W = canvas.width, H = canvas.height;
const msg = document.getElementById('msg');

// Game constants — pure APPLICATION-stage configuration
const PADDLE_R   = 28;
const PUCK_R     = 14;
const GOAL_W     = 140;
const GOAL_OFFSET = (W - GOAL_W) / 2;
const MAX_SCORE  = 7;
const AI_SPEED   = 4.2;

// =============================================================================
// APPLICATION STAGE — world-state objects
// These are the logical positions and velocities that drive everything.
// No pixels are touched here; this is pure simulation data.
// =============================================================================
let score       = [0, 0];
let gameActive  = true;
let resetting   = false;

// Object positions in world/canvas 2D space (x,y in pixels, r = radius)
const puck = { x: W/2, y: H/2, vx: 0, vy: 0, r: PUCK_R };
const p1   = { x: W/2, y: H - 80, r: PADDLE_R };   // player paddle
const p2   = { x: W/2, y: 80,     r: PADDLE_R };   // CPU paddle

// Raw mouse input — read in APPLICATION stage, used to drive p1 position
let mouseX = W/2, mouseY = H - 80;
let lastMX = W/2, lastMY = H - 80;  // previous frame position for velocity estimation


// =============================================================================
// APPLICATION STAGE — Input handling
// Converts browser events into world-space coordinates used by the simulation.
// This runs outside the render loop and is purely CPU / game-logic work.
// =============================================================================
canvas.addEventListener('mousemove', e => {
  // Map DOM pixel coordinates to canvas-local coordinates
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const t = e.touches[0];
  mouseX = t.clientX - rect.left;
  mouseY = t.clientY - rect.top;
}, { passive: false });


// =============================================================================
// APPLICATION STAGE — resetPuck()
// Resets all world-state positions and assigns a new random launch velocity
// to the puck. Pure simulation data manipulation — no drawing occurs here.
// =============================================================================
function resetPuck(scorer) {
  resetting = true;
  msg.textContent = scorer === 0 ? '🔵 You scored!' : '🔴 CPU scored!';

  // Reset world positions
  puck.x = W/2;  puck.y = H/2;
  puck.vx = 0;   puck.vy = 0;
  p1.x = W/2;    p1.y = H - 80;
  p2.x = W/2;    p2.y = 80;
  mouseX = W/2;  mouseY = H - 80;

  setTimeout(() => {
    if (!gameActive) return;
    // Compute a random launch angle and direction (APPLICATION: velocity assignment)
    const angle = (Math.random() * Math.PI / 2) + Math.PI / 4;
    const dir   = scorer === 0 ? 1 : -1;
    puck.vx = 4 * Math.cos(angle) * (Math.random() > 0.5 ? 1 : -1);
    puck.vy = 4 * Math.sin(angle) * dir;
    resetting = false;
    msg.textContent = 'Move your mouse to play!';
  }, 1000);
}


// =============================================================================
// APPLICATION STAGE — circleCollide()
// Broad-phase + narrow-phase collision detection using circle overlap math.
// Operates entirely on world-space object data (x, y, r). No rendering.
// =============================================================================
function circleCollide(a, b) {
  const dx   = b.x - a.x;
  const dy   = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);  // Euclidean distance between centres
  // Return collision info if circles overlap; null otherwise
  return dist < a.r + b.r ? { dist, dx, dy } : null;
}


// =============================================================================
// APPLICATION STAGE — resolveCollision()
// Collision response: separates overlapping circles, reflects puck velocity
// along the collision normal, and transfers paddle momentum to the puck.
// All arithmetic is on world-space floats — no pixels written.
// =============================================================================
function resolveCollision(paddle, puck, pvx, pvy) {
  const col = circleCollide(paddle, puck);
  if (!col) return;

  const { dist, dx, dy } = col;

  // --- Geometry sub-step: compute collision normal (unit vector) ---
  const nx      = dx / dist;
  const ny      = dy / dist;
  const overlap = paddle.r + puck.r - dist;

  // Positional correction — push puck out of paddle along the normal
  puck.x += nx * overlap;
  puck.y += ny * overlap;

  // Relative velocity of puck vs paddle surface
  const relVx = puck.vx - pvx;
  const relVy = puck.vy - pvy;
  const dot   = relVx * nx + relVy * ny;  // project onto normal

  if (dot < 0) {  // objects approaching each other — resolve
    const factor = 1.12;  // slight energy boost for snappy feel
    // Reflect puck velocity component along the normal
    puck.vx -= factor * dot * nx;
    puck.vy -= factor * dot * ny;
    // Transfer a fraction of paddle velocity to simulate a "hit"
    puck.vx += pvx * 0.3;
    puck.vy += pvy * 0.3;
    // Speed cap to prevent runaway velocities
    const spd    = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
    const maxSpd = 14;
    if (spd > maxSpd) { puck.vx *= maxSpd / spd; puck.vy *= maxSpd / spd; }
  }
}


// =============================================================================
// APPLICATION STAGE — update()
// The main simulation tick: advances all world-state by one frame.
// Runs every frame before any drawing. Covers:
//   • Player paddle tracking (input → position)
//   • AI paddle movement
//   • Puck physics (integration, wall bouncing, friction)
//   • Goal detection and score management
//   • Collision detection & response
// Nothing here writes pixels.
// =============================================================================
function update() {
  if (!gameActive || resetting) return;

  // --- Player paddle: follow mouse with smoothing (APPLICATION: input integration) ---
  const pvx1 = (mouseX - p1.x) * 0.5;  // proportional approach velocity
  const pvy1 = (mouseY - p1.y) * 0.5;
  p1.x += pvx1;
  p1.y += pvy1;
  // Clamp player paddle to bottom half of rink (world-space boundary)
  p1.x = Math.max(p1.r, Math.min(W - p1.r, p1.x));
  p1.y = Math.max(H / 2 + p1.r, Math.min(H - p1.r, p1.y));

  // --- AI paddle: simple tracking behaviour (APPLICATION: game AI) ---
  // Chase the puck when it's in the AI's half; otherwise return to centre
  const targetX = puck.y < H / 2 ? puck.x : W / 2;
  const dx2 = targetX - p2.x;
  const dy2 = (puck.y - 40) - p2.y;
  const d2  = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  if (d2 > 1) {
    const s    = Math.min(AI_SPEED, d2);
    p2.x += (dx2 / d2) * s;
    p2.y += (dy2 / d2) * s;
    // Clamp AI paddle to top half of rink
    p2.x = Math.max(p2.r, Math.min(W - p2.r, p2.x));
    p2.y = Math.max(p2.r, Math.min(H / 2 - p2.r, p2.y));
  }

  // --- Puck integration (APPLICATION: Euler integration of position) ---
  puck.x += puck.vx;
  puck.y += puck.vy;

  // --- Side wall collisions — reflect horizontal velocity (APPLICATION: boundary response) ---
  if (puck.x - puck.r < 0) { puck.x = puck.r;      puck.vx =  Math.abs(puck.vx) * 0.98; }
  if (puck.x + puck.r > W) { puck.x = W - puck.r;  puck.vx = -Math.abs(puck.vx) * 0.98; }

  // --- Top wall / goal detection (APPLICATION: scoring logic) ---
  if (puck.y - puck.r < 0) {
    if (puck.x > GOAL_OFFSET && puck.x < GOAL_OFFSET + GOAL_W) {
      // Puck entered the CPU's goal — player scores
      score[0]++;
      document.getElementById('s1').textContent = score[0];
      if (score[0] >= MAX_SCORE) { gameActive = false; msg.textContent = '🎉 You win! Refresh to play again.'; return; }
      resetPuck(0); return;
    }
    // Bounced off the top wall (outside the goal posts)
    puck.y = puck.r; puck.vy = Math.abs(puck.vy) * 0.98;
  }

  // --- Bottom wall / goal detection (APPLICATION: scoring logic) ---
  if (puck.y + puck.r > H) {
    if (puck.x > GOAL_OFFSET && puck.x < GOAL_OFFSET + GOAL_W) {
      // Puck entered the player's goal — CPU scores
      score[1]++;
      document.getElementById('s2').textContent = score[1];
      if (score[1] >= MAX_SCORE) { gameActive = false; msg.textContent = '😅 CPU wins! Refresh to play again.'; return; }
      resetPuck(1); return;
    }
    // Bounced off the bottom wall (outside the goal posts)
    puck.y = H - puck.r; puck.vy = -Math.abs(puck.vy) * 0.98;
  }

  // --- Friction (APPLICATION: energy dissipation) ---
  puck.vx *= 0.999;
  puck.vy *= 0.999;

  // --- Paddle–puck collision detection & response (APPLICATION) ---
  // Estimate player paddle velocity from position delta between frames
  const pvx1f = p1.x - lastMX;
  const pvy1f = p1.y - lastMY;
  resolveCollision(p1, puck, pvx1f * 0.5, pvy1f * 0.5);
  resolveCollision(p2, puck, 0, 0);  // AI paddle velocity treated as 0 for simplicity

  // Store last frame's paddle position for next-frame velocity calculation
  lastMX = p1.x;
  lastMY = p1.y;
}


// =============================================================================
// GEOMETRY + RASTERIZATION STAGES — drawRink()
//
// GEOMETRY:   ctx.beginPath(), ctx.moveTo(), ctx.lineTo(), ctx.arc(),
//             ctx.roundRect() — these define vector paths (vertices, curves)
//             in 2D canvas space. No pixels are committed yet.
//
// RASTERIZATION: ctx.fill(), ctx.stroke() — these resolve the vector paths
//             into actual pixels on the canvas bitmap, sampling fill/stroke
//             styles and applying the shadow filter.
// =============================================================================
function drawRink() {

  // GEOMETRY: define a rounded rectangle path for the rink background
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 16);
  // RASTERIZATION: fill that path with a solid dark colour → pixels written
  ctx.fillStyle = '#050514';
  ctx.fill();

  // GEOMETRY: define 3 vertical lane-guide line paths
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * W / 4, 0);   // start vertex
    ctx.lineTo(i * W / 4, H);   // end vertex
    // RASTERIZATION: stroke each line → faint white pixels
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.stroke();
  }

  // GEOMETRY: centre dividing line path
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  // RASTERIZATION: stroke → purple semi-transparent pixels
  ctx.strokeStyle = 'rgba(120, 80, 255, 0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // GEOMETRY: centre circle arc path (full 360°)
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 60, 0, Math.PI * 2);
  // RASTERIZATION: stroke → faint purple ring pixels
  ctx.strokeStyle = 'rgba(120, 80, 255, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // GEOMETRY: small centre dot path
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2);
  // RASTERIZATION: fill → purple dot pixels
  ctx.fillStyle = 'rgba(120, 80, 255, 0.4)';
  ctx.fill();

  // --- Player goal (top of screen, blue) ---
  // GEOMETRY: three line segments forming the goal bracket
  ctx.beginPath();
  ctx.moveTo(GOAL_OFFSET, 0);
  ctx.lineTo(GOAL_OFFSET, 8);
  ctx.moveTo(GOAL_OFFSET + GOAL_W, 0);
  ctx.lineTo(GOAL_OFFSET + GOAL_W, 8);
  ctx.moveTo(GOAL_OFFSET, 0);
  ctx.lineTo(GOAL_OFFSET + GOAL_W, 0);
  ctx.strokeStyle = '#00cfff';
  ctx.lineWidth   = 3;
  // RASTERIZATION: shadow filter applied, then pixels stroked in cyan
  ctx.shadowColor = '#00cfff';
  ctx.shadowBlur  = 12;
  ctx.stroke();
  ctx.shadowBlur  = 0;  // reset shadow so it doesn't bleed onto next draw calls

  // --- CPU goal (bottom of screen, red) ---
  // GEOMETRY: three line segments forming the goal bracket
  ctx.beginPath();
  ctx.moveTo(GOAL_OFFSET, H);
  ctx.lineTo(GOAL_OFFSET, H - 8);
  ctx.moveTo(GOAL_OFFSET + GOAL_W, H);
  ctx.lineTo(GOAL_OFFSET + GOAL_W, H - 8);
  ctx.moveTo(GOAL_OFFSET, H);
  ctx.lineTo(GOAL_OFFSET + GOAL_W, H);
  ctx.strokeStyle = '#ff4466';
  ctx.lineWidth   = 3;
  // RASTERIZATION: shadow filter + red stroke pixels
  ctx.shadowColor = '#ff4466';
  ctx.shadowBlur  = 12;
  ctx.stroke();
  ctx.shadowBlur  = 0;
}


// =============================================================================
// GEOMETRY + RASTERIZATION STAGES — drawPaddle()
//
// GEOMETRY:   Three concentric ctx.arc() paths define the outer ring,
//             inner ring, and centre dot of the paddle at world position (x,y).
//
// RASTERIZATION: Each fill()/stroke() call converts those circular paths
//             into pixels. The glow effect is a rasterization-time shadow
//             filter applied by the Canvas compositing engine.
// =============================================================================
function drawPaddle(x, y, color) {

  // RASTERIZATION state: enable glow shadow before drawing
  ctx.shadowColor = color;
  ctx.shadowBlur  = 20;

  // GEOMETRY: outer paddle ring path
  ctx.beginPath();
  ctx.arc(x, y, PADDLE_R, 0, Math.PI * 2);
  // RASTERIZATION: semi-transparent fill + solid stroke → outer ring pixels + glow
  ctx.fillStyle   = color + '22';  // very transparent fill
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 3;
  ctx.stroke();

  // GEOMETRY: inner concentric ring path (55% of outer radius)
  ctx.beginPath();
  ctx.arc(x, y, PADDLE_R * 0.55, 0, Math.PI * 2);
  // RASTERIZATION: dimmer fill + semi-transparent stroke
  ctx.fillStyle   = color + '44';
  ctx.fill();
  ctx.strokeStyle = color + 'aa';
  ctx.lineWidth   = 2;
  ctx.stroke();

  // GEOMETRY: centre dot path
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  // RASTERIZATION: solid fill → bright centre dot pixels
  ctx.fillStyle = color;
  ctx.fill();

  ctx.shadowBlur = 0;  // reset shadow
}


// =============================================================================
// GEOMETRY + RASTERIZATION STAGES — drawPuck()
//
// GEOMETRY:   Computes a motion-trail line path from the puck's velocity
//             vector, then defines two arc paths for the puck body and
//             specular highlight.
//
// RASTERIZATION: The trail is stroked using a linear gradient texture
//             (rasterization resolves gradient colours per pixel).
//             The main puck arc is filled + stroked with shadow blur.
//             The specular highlight arc is filled with a transparent white.
// =============================================================================
function drawPuck() {
  const speed    = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
  const trailLen = Math.min(speed * 2.5, 30);  // APPLICATION: scale trail to speed

  if (trailLen > 2) {
    // APPLICATION: compute unit vector opposite to velocity (trail points backward)
    const nx = -puck.vx / speed;
    const ny = -puck.vy / speed;

    // GEOMETRY (RASTERIZATION setup): create a linear gradient along the trail axis
    // This defines colour stops in canvas space — resolved to pixels during stroke
    const grad = ctx.createLinearGradient(
      puck.x + nx * trailLen, puck.y + ny * trailLen,   // tail (transparent)
      puck.x, puck.y                                      // head (semi-white)
    );
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.15)');

    // GEOMETRY: trail line path from tail to just behind puck centre
    ctx.beginPath();
    ctx.moveTo(puck.x + nx * trailLen, puck.y + ny * trailLen);
    ctx.lineTo(puck.x + puck.r * 0.3,  puck.y + puck.r * 0.3);
    ctx.strokeStyle = grad;
    ctx.lineWidth   = PUCK_R * 1.8;
    ctx.lineCap     = 'round';
    // RASTERIZATION: wide rounded stroke resolves gradient → fading trail pixels
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // GEOMETRY: main puck body — full circle arc path
  ctx.beginPath();
  ctx.arc(puck.x, puck.y, PUCK_R, 0, Math.PI * 2);
  // RASTERIZATION: white glow shadow + light-grey fill + semi-transparent stroke
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur  = 20;
  ctx.fillStyle   = '#e8e8ee';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.shadowBlur  = 0;

  // GEOMETRY: specular highlight — small offset arc (simulates light source)
  ctx.beginPath();
  ctx.arc(puck.x - 4, puck.y - 4, PUCK_R * 0.35, 0, Math.PI * 2);
  // RASTERIZATION: transparent white fill → subtle glint pixels on top of puck
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fill();
}


// =============================================================================
// RASTERIZATION STAGE — draw()
// Orchestrates one complete frame's worth of rendering.
//
// ctx.clearRect() is a RASTERIZATION operation — it writes transparent pixels
// to the entire canvas bitmap, discarding the previous frame.
// Each subsequent drawX() call issues GEOMETRY commands (paths) that are
// immediately RASTERIZED (fill/stroke) before the next object is drawn,
// so painter's algorithm order (back to front) matters here.
// =============================================================================
function draw() {
  // RASTERIZATION: clear all pixels to transparent (start of new frame)
  ctx.clearRect(0, 0, W, H);

  drawRink();                          // background + markings (drawn first / furthest back)
  drawPaddle(p2.x, p2.y, '#ff4466'); // CPU paddle (mid layer)
  drawPaddle(p1.x, p1.y, '#00cfff'); // player paddle (mid layer)
  drawPuck();                          // puck + trail (drawn last / closest to viewer)
}


// =============================================================================
// APPLICATION STAGE — loop()
// The main game loop. requestAnimationFrame() is an APPLICATION-level
// scheduler: it asks the browser to call loop() before the next screen repaint,
// synchronising the simulation tick (update) and render (draw) to the display
// refresh rate (~60 fps). The pipeline runs in full every frame:
//   APPLICATION (update) → GEOMETRY + RASTERIZATION (draw)
// =============================================================================
function loop() {
  update();  // APPLICATION STAGE:   advance simulation by one tick
  draw();    // GEOMETRY + RASTER:   render updated world state to pixels
  requestAnimationFrame(loop);  // schedule next frame
}

// Kick off the game — reset puck as if CPU scored, then start the loop
resetPuck(1);
loop();
