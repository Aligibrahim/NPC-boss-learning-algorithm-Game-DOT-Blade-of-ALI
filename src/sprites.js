// Sprite loader + cleanup pipeline.
// Gemini exports sprites with the transparency-preview checkerboard baked into
// the actual pixels, so we have to flood-fill from the corners to remove it,
// then crop to the figure's bounding box. The result: a clean canvas the
// renderer can drawImage() at any size without showing a grey grid.

const SPRITE_MANIFEST = {
  player_idle: '/sprites/player_walk.png',
  player_walk: '/sprites/player_walk.png',
  boss_idle:   '/sprites/boss_idle.png',
};

const ARENA_URL = '/sprites/arena.png';

export function loadSprites() {
  const sprites = {};
  const tasks = Object.entries(SPRITE_MANIFEST).map(([key, url]) =>
    loadImage(url).then((img) => {
      sprites[key] = img ? cleanCharacterSprite(img) : null;
    })
  );
  tasks.push(
    loadImage(ARENA_URL).then((img) => {
      sprites.arena = img ? prepareArena(img) : null;
    })
  );
  return Promise.all(tasks).then(() => sprites);
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// --- Character sprite pipeline ---
// 1. Flood-fill from the four corners with a "looks like checkerboard" predicate
//    and zero out alpha for matched pixels.
// 2. Crop to the alpha bounding box so the figure fills the result.
function cleanCharacterSprite(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  removeCheckerboard(imgData);
  ctx.putImageData(imgData, 0, 0);
  return cropToContent(c);
}

// Flood-fill from each corner. The corner pixel defines that corner's
// "background color" — flood-fill kills any pixel within tolerance of it.
// This handles white bg (player), black bg (boss), grey checker, etc.
function removeCheckerboard(imgData) {
  const { width: w, height: h, data } = imgData;
  const visited = new Uint8Array(w * h);
  const stack = [];
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];

  // Tolerance in each channel. Larger for soft-edged AI sprites since the
  // background often fades into the figure (anti-aliased halos).
  const TOL = 28;

  // Sample each corner color and seed the fill from that corner with its color.
  for (const [x, y] of corners) {
    const i = (y * w + x) * 4;
    stack.push(x, y, data[i], data[i + 1], data[i + 2]);
  }

  function near(r1, g1, b1, r2, g2, b2) {
    return Math.abs(r1 - r2) <= TOL &&
           Math.abs(g1 - g2) <= TOL &&
           Math.abs(b1 - b2) <= TOL;
  }

  while (stack.length) {
    const tb = stack.pop();
    const tg = stack.pop();
    const tr = stack.pop();
    const y  = stack.pop();
    const x  = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const idx = y * w + x;
    if (visited[idx]) continue;
    visited[idx] = 1;
    const i = idx * 4;
    const a = data[i + 3];
    if (a < 8) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (!near(r, g, b, tr, tg, tb)) continue;
    data[i + 3] = 0;
    stack.push(x + 1, y, tr, tg, tb);
    stack.push(x - 1, y, tr, tg, tb);
    stack.push(x, y + 1, tr, tg, tb);
    stack.push(x, y - 1, tr, tg, tb);
  }
}

function cropToContent(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

// --- Arena pipeline ---
// If the image is mostly empty grey (Gemini failed to fill the canvas),
// reject it so the game can fall back to the procedural background.
// Reject arena PNGs that are mostly empty (uniform single-color regions),
// which is Gemini's failure mode. Sample the image's dominant color and count
// how many pixels match; >55% match = unpainted, fall back to procedural.
function prepareArena(img) {
  const sample = document.createElement('canvas');
  sample.width = 96;
  sample.height = 54;
  const sctx = sample.getContext('2d');
  sctx.drawImage(img, 0, 0, 96, 54);
  const data = sctx.getImageData(0, 0, 96, 54).data;
  // Treat the bottom-right corner pixel as "the dead-fill color" probe.
  const probeI = (53 * 96 + 95) * 4;
  const pr = data[probeI], pg = data[probeI + 1], pb = data[probeI + 2];
  let match = 0;
  const total = 96 * 54;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - pr) < 10 &&
        Math.abs(data[i + 1] - pg) < 10 &&
        Math.abs(data[i + 2] - pb) < 10) match++;
  }
  if (match / total > 0.55) return null;
  return img;
}
