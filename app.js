// Minimal in-browser GIF builder using gif.js and its worker

let gifWorkerBlob = null;

// Fetch the worker script once (required by gif.js)
(async function preloadWorker() {
  const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
  gifWorkerBlob = await resp.blob();
})();

const el = (id) => document.getElementById(id);
const drawCanvas = document.getElementById('drawCanvas');
const dctx = drawCanvas.getContext('2d');
const btn = el('generateGif');
const statusEl = el('status');
const resultImg = el('resultImg');
const downloadLink = el('downloadLink');
let frames = [];
let currentFrame = 0;
let drawing = false, lastX = 0, lastY = 0;
const aiBtn = document.getElementById('aiGenerate');
const aiRegenBtn = document.getElementById('aiRegenerateFrame');
const uploadInput = document.getElementById('uploadImage');
const aiNextBtn = document.getElementById('aiNextFrame');

btn.addEventListener('click', async () => {
  if (!frames.length) { statusEl.textContent = 'Add at least one frame.'; return; }
  const width = clampInt(parseInt(el('gifWidth').value, 10), 16, 2048);
  const height = clampInt(parseInt(el('gifHeight').value, 10), 16, 2048);
  const fps = clampInt(parseInt(el('fps').value, 10), 1, 60);
  const quality = clampInt(parseInt(el('quality').value, 10), 1, 30);
  const delay = Math.round(1000 / fps);

  if (!gifWorkerBlob) {
    statusEl.textContent = 'Loading worker...';
    await waitFor(() => !!gifWorkerBlob);
  }

  btn.disabled = true;
  statusEl.textContent = 'Building GIF...';

  const workerUrl = URL.createObjectURL(gifWorkerBlob);
  const gif = new GIF({
    workers: 2,
    quality,
    width,
    height,
    workerScript: workerUrl,
    transparent: 0x00000000
  });

  // Add frames
  for (const frame of frames) { gif.addFrame(frame, { delay, copy: true }); }

  gif.on('finished', (blob) => {
    URL.revokeObjectURL(workerUrl);
    const url = URL.createObjectURL(blob);
    resultImg.src = url;
    downloadLink.href = url;
    downloadLink.style.display = 'inline-block';
    statusEl.textContent = 'Done.';
    btn.disabled = false;
  });

  gif.on('progress', (p) => {
    statusEl.textContent = `Building GIF… ${(p * 100).toFixed(0)}%`;
  });

  gif.render();
});

function clampInt(v, min, max) {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function waitFor(fn, interval = 50, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t);
        resolve();
      } else if (performance.now() - start > timeout) {
        clearInterval(t);
        reject(new Error('Timeout waiting for condition'));
      }
    }, interval);
  });
}

// simple sleep utility
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// rate limit gate + exponential backoff retry
let lastAIRequestTime = 0;
async function rateLimitedCall(fn){
  const minGap = 1200; // ms between AI calls
  const now = Date.now();
  const wait = Math.max(0, lastAIRequestTime + minGap - now);
  if (wait > 0) await sleep(wait);
  lastAIRequestTime = Date.now();
  return fn();
}

// retry wrapper specifically for 429/rate-limit responses
async function withRetry(doCall, label){
  let delay = 1500; // start backoff
  for (let attempt = 1; attempt <= 5; attempt++){
    try { return await doCall(); }
    catch(e){
      const msg = (e && e.message) || '';
      if (!(e?.status === 429 || /rate|limit|too many|429/i.test(msg))) throw e;
      const jitter = Math.random() * 300;
      statusEl.textContent = `${label} — rate limited. Retrying in ${((delay+jitter)/1000).toFixed(1)}s (attempt ${attempt}/5)`;
      await sleep(delay + jitter);
      delay = Math.min(delay * 1.8, 10000);
    }
  }
  throw new Error('Exceeded retry attempts');
}

async function generateImageSafe(prompt, opts, label){
  return withRetry(() => rateLimitedCall(() => websim.imageGen({ prompt, ...opts })), label);
}

function initFrames(w = 256, h = 256) {
  frames = [makeBlankCanvas(w, h)];
  currentFrame = 0;
  syncCanvasSize(w, h);
  renderCurrentFrame();
  updateFrameInfo();
}

function makeBlankCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');
  cctx.fillStyle = '#ffffff00'; cctx.fillRect(0,0,w,h);
  return c;
}

function syncCanvasSize(w, h) {
  drawCanvas.width = w;
  drawCanvas.height = h;
}

function renderCurrentFrame() {
  const src = frames[currentFrame];
  dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
  dctx.drawImage(src, 0, 0, drawCanvas.width, drawCanvas.height);
}

function updateFrameInfo() {
  const info = document.getElementById('frameInfo');
  info.textContent = `Frame ${currentFrame + 1}/${frames.length}`;
}

function startDraw(x, y) { drawing = true; lastX = x; lastY = y; }
function lineTo(x, y) {
  if (!drawing) return;
  dctx.lineCap = 'round'; dctx.lineJoin = 'round';
  dctx.strokeStyle = document.getElementById('brushColor').value;
  dctx.lineWidth = clampInt(parseInt(document.getElementById('brushSize').value,10),1,120);
  dctx.beginPath(); dctx.moveTo(lastX, lastY); dctx.lineTo(x, y); dctx.stroke();
  lastX = x; lastY = y;
}
function endDraw() { drawing = false; commitCanvasToFrame(); }

function getPos(evt) {
  const rect = drawCanvas.getBoundingClientRect();
  const isTouch = evt.touches && evt.touches[0];
  const cx = isTouch ? evt.touches[0].clientX : evt.clientX;
  const cy = isTouch ? evt.touches[0].clientY : evt.clientY;
  return { x: (cx - rect.left) * (drawCanvas.width / rect.width),
           y: (cy - rect.top) * (drawCanvas.height / rect.height) };
}

function commitCanvasToFrame() {
  const c = frames[currentFrame];
  const cctx = c.getContext('2d');
  cctx.clearRect(0,0,c.width,c.height);
  cctx.drawImage(drawCanvas, 0, 0);
}

function loadImage(url) {
  return new Promise((resolve, reject) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
}

drawCanvas.addEventListener('mousedown', e => { const p = getPos(e); startDraw(p.x,p.y); });
drawCanvas.addEventListener('mousemove', e => { const p = getPos(e); lineTo(p.x,p.y); });
window.addEventListener('mouseup', endDraw);
drawCanvas.addEventListener('touchstart', e => { e.preventDefault(); const p = getPos(e); startDraw(p.x,p.y); }, {passive:false});
drawCanvas.addEventListener('touchmove', e => { e.preventDefault(); const p = getPos(e); lineTo(p.x,p.y); }, {passive:false});
drawCanvas.addEventListener('touchend', e => { e.preventDefault(); endDraw(); }, {passive:false});

document.getElementById('addFrame').addEventListener('click', () => {
  const w = frames[0]?.width || drawCanvas.width;
  const h = frames[0]?.height || drawCanvas.height;
  frames.splice(currentFrame + 1, 0, makeBlankCanvas(w, h));
  currentFrame++; renderCurrentFrame(); updateFrameInfo();
});

document.getElementById('deleteFrame').addEventListener('click', () => {
  if (frames.length <= 1) return;
  frames.splice(currentFrame, 1);
  currentFrame = Math.max(0, currentFrame - 1);
  renderCurrentFrame(); updateFrameInfo();
});

document.getElementById('prevFrame').addEventListener('click', () => {
  if (currentFrame > 0) { currentFrame--; renderCurrentFrame(); updateFrameInfo(); }
});
document.getElementById('nextFrame').addEventListener('click', () => {
  if (currentFrame < frames.length - 1) { currentFrame++; renderCurrentFrame(); updateFrameInfo(); }
});

document.getElementById('clearFrame').addEventListener('click', () => {
  dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
  commitCanvasToFrame();
});

document.getElementById('gifWidth').addEventListener('change', onSizeChange);
document.getElementById('gifHeight').addEventListener('change', onSizeChange);
function onSizeChange() {
  const w = clampInt(parseInt(document.getElementById('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(document.getElementById('gifHeight').value,10),16,2048);
  // Rescale all frames to new size
  frames = frames.map(src => {
    const n = makeBlankCanvas(w,h); n.getContext('2d').drawImage(src,0,0,w,h); return n;
  });
  syncCanvasSize(w,h); renderCurrentFrame();
}

uploadInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
    dctx.drawImage(bmp, 0, 0, drawCanvas.width, drawCanvas.height);
    commitCanvasToFrame(); statusEl.textContent = 'Image loaded into frame.';
  } catch(err){ statusEl.textContent = 'Failed to load image.'; }
});

aiBtn.addEventListener('click', async () => {
  const base = el('aiBasePrompt').value.trim();
  const anim = el('aiAnimPrompt').value.trim();
  const total = clampInt(parseInt(el('aiFrames').value,10), 2, 30);
  if (!base) { statusEl.textContent = 'Enter a base image prompt.'; return; }
  const w = clampInt(parseInt(el('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(el('gifHeight').value,10),16,2048);
  aiBtn.disabled = true; btn.disabled = true; downloadLink.style.display='none'; statusEl.textContent = 'Generating base frame...';
  try {
    // base frame with rate-limit handling
    const baseRes = await generateImageSafe(base, { width: w, height: h }, 'Generating base frame');
    const baseImg = await loadImage(baseRes.url);
    const first = makeBlankCanvas(w,h); first.getContext('2d').drawImage(baseImg,0,0,w,h);
    frames = [first]; currentFrame = 0; renderCurrentFrame(); updateFrameInfo();
    let prev = first;
    for (let i = 1; i < total; i++) {
      statusEl.textContent = `Generating frame ${i+1}/${total}...`;
      const remaining = total - i;
      const stepPrompt = `Create the next animation frame from the previous image with a subtle, smooth change toward: "${anim}". Preserve subject identity, palette, and composition; keep differences minimal. ${remaining} frame(s) remain.`;
      // step frames with rate-limit handling
      const res = await generateImageSafe(stepPrompt, { width: w, height: h, image_inputs: [{ url: prev.toDataURL() }] }, `Frame ${i+1}/${total}`);
      const img = await loadImage(res.url);
      const c = makeBlankCanvas(w,h); c.getContext('2d').drawImage(img,0,0,w,h);
      frames.push(c); prev = c; updateFrameInfo();
    }
    currentFrame = 0; renderCurrentFrame(); updateFrameInfo();
    statusEl.textContent = 'AI sequence ready. You can draw/edit or Generate GIF.';
  } catch (e) {
    console.error(e); statusEl.textContent = `AI generation failed: ${e.message || e}`;
  } finally {
    aiBtn.disabled = false; btn.disabled = false;
  }
});

aiRegenBtn.addEventListener('click', async () => {
  if (!frames.length) { statusEl.textContent = 'No frames to regenerate.'; return; }
  const w = clampInt(parseInt(el('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(el('gifHeight').value,10),16,2048);
  const anim = el('aiAnimPrompt').value.trim();
  const prompt = `Regenerate this in-between animation frame using the surrounding frames as guidance. Maintain subject identity, palette, and composition. Ensure smooth motion continuity${anim ? ` toward: "${anim}"` : ''}. Keep changes minimal.`;
  const inputs = [];
  if (frames[currentFrame-1]) inputs.push({ url: frames[currentFrame-1].toDataURL() });
  inputs.push({ url: frames[currentFrame].toDataURL() });
  if (frames[currentFrame+1]) inputs.push({ url: frames[currentFrame+1].toDataURL() });
  aiRegenBtn.disabled = true; btn.disabled = true; statusEl.textContent = 'Regenerating current frame...';
  try {
    const res = await generateImageSafe(prompt, { width: w, height: h, image_inputs: inputs }, 'Regenerating frame');
    const img = await loadImage(res.url);
    const ctx = frames[currentFrame].getContext('2d');
    ctx.clearRect(0,0,w,h); ctx.drawImage(img,0,0,w,h);
    renderCurrentFrame(); statusEl.textContent = 'Frame regenerated.';
  } catch(e) {
    console.error(e); statusEl.textContent = `Regeneration failed: ${e.message || e}`;
  } finally {
    aiRegenBtn.disabled = false; btn.disabled = false;
  }
});

aiNextBtn.addEventListener('click', async () => {
  if (!frames.length) { statusEl.textContent = 'No base frame. Draw or generate one first.'; return; }
  const w = frames[0].width, h = frames[0].height;
  const anim = el('aiAnimPrompt').value.trim();
  const prev = frames[frames.length - 1];
  const prompt = `Generate the next animation frame continuing subtle motion${anim ? ` toward: "${anim}"` : ''}. Preserve subject identity and composition; minimal change for smooth animation.`;
  aiNextBtn.disabled = true; btn.disabled = true; statusEl.textContent = 'Generating next frame...';
  try {
    const res = await generateImageSafe(prompt, { width: w, height: h, image_inputs: [{ url: prev.toDataURL() }] }, 'Next frame');
    const img = await loadImage(res.url);
    const c = makeBlankCanvas(w,h); c.getContext('2d').drawImage(img,0,0,w,h);
    frames.push(c); currentFrame = frames.length - 1; renderCurrentFrame(); updateFrameInfo();
    statusEl.textContent = 'Next frame added.';
  } catch(e){ statusEl.textContent = `Next frame failed: ${e.message || e}`; }
  finally { aiNextBtn.disabled = false; btn.disabled = false; }
});

window.addEventListener('load', () => {
  initFrames(parseInt(document.getElementById('gifWidth').value,10),
             parseInt(document.getElementById('gifHeight').value,10));
});