// Does the real smoothLine() from panel/app.js actually remove hand wobble, and does it leave the ends alone?
// Reads the function out of the file (no copy) so what is measured is what ships.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'panel', 'app.js'), 'utf8');
const start = src.indexOf('const SMOOTH_REACH');
const end = src.indexOf('// The live line of a 走向');
if (start < 0 || end < 0) throw new Error('抓不到 smoothLine');
const body = src.slice(start, end).replace(/function smoothLine/, 'const smoothLine = function');
const smoothLine = new Function(`${body}\nreturn smoothLine;`)();

// A hand-drawn line: mostly straight, with jitter (slow sine = the arm, fast noise = the hand).
function shakyLine(n = 400, amp = 3.0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = 40 + t * 260;
    const y = 200 + Math.sin(t * 5.5) * amp + Math.sin(t * 41) * amp * 0.5 + (Math.random() - 0.5) * amp;
    pts.push({ x, y });
  }
  return pts;
}

function deviation(pts) {
  // max distance from the straight line through the two ends: the wobble a 走向 line should not carry
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  let mx = 0, sum = 0;
  for (const p of pts) {
    const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
    mx = Math.max(mx, d); sum += d;
  }
  return { max: mx, mean: sum / pts.length };
}

function steps(pts) {
  // mean absolute turn per point: the "jaggedness" of the polyline
  let s = 0, n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    s += d; n++;
  }
  return (s / n) * 180 / Math.PI;
}

const line = shakyLine();
console.log('amount |  max dev (px) | mean dev | jaggedness (°/pt) | ends kept');
for (const amount of [0, 25, 50, 75, 100]) {
  const out = smoothLine(line, amount);
  const d = deviation(out);
  const ends = Math.hypot(out[0].x - line[0].x, out[0].y - line[0].y) +
               Math.hypot(out.at(-1).x - line.at(-1).x, out.at(-1).y - line.at(-1).y);
  console.log(`${String(amount).padStart(6)} | ${d.max.toFixed(2).padStart(13)} | ${d.mean.toFixed(2).padStart(8)} | ${steps(out).toFixed(2).padStart(17)} | ${ends === 0 ? 'yes' : 'moved ' + ends.toFixed(2)}`);
}
console.log('raw    |', deviation(line).max.toFixed(2), '|', deviation(line).mean.toFixed(2), '|', steps(line).toFixed(2));

// no-op at 0, and short lines untouched
console.log('\n平滑 0 逐点相同:', JSON.stringify(smoothLine(line, 0)) === JSON.stringify(line));
console.log('两个点不动:', JSON.stringify(smoothLine([{ x: 0, y: 0 }, { x: 10, y: 10 }], 100)));

// a corner: smoothing rounds it, ends stay put
const corner = [];
for (let i = 0; i <= 100; i++) corner.push({ x: 100 + i, y: 100 });
for (let i = 1; i <= 100; i++) corner.push({ x: 200, y: 100 + i });
const c = smoothLine(corner, 100);
console.log('拐角: 原始', corner[100], '→ 平滑后', c[100].x.toFixed(1), c[100].y.toFixed(1),
            '| 端点', JSON.stringify(c[0]), JSON.stringify(c.at(-1)));

// cost of one rebuild at the sizes a 走向 line really has
const long = shakyLine(3000, 2);
for (const n of [500, 1500, 3000]) {
  const P = long.slice(0, n);
  const t = performance.now();
  for (let k = 0; k < 10; k++) smoothLine(P, 100);
  console.log(`重建 ${n} 点 x10: ${(performance.now() - t).toFixed(1)} ms`);
}
