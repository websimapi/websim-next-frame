// Minimal in-browser GIF builder using gif.js and its worker

let gifWorkerBlob = null;

// Fetch the worker script once (required by gif.js)
(async function preloadWorker() {
  const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
  gifWorkerBlob = await resp.blob();
})();

const el = (id) => document.getElementById(id);
const drawCanvas = document.getElementById('drawCanvas');
const dctx = drawCanvas ? drawCanvas.getContext('2d') : null;
const btn = el('generateGif');
const statusEl = document.getElementById('status');
const resultImg = el('resultImg');
const downloadLink = el('downloadLink');
let frames = [];
let currentFrame = 0;
let drawing = false, lastX = 0, lastY = 0;
const aiBtn = document.getElementById('aiGenerate');
const aiRegenBtn = document.getElementById('aiRegenerateFrame');
const uploadInput = document.getElementById('uploadImage');
const aiNextBtn = document.getElementById('aiNextFrame');

// Replace everything with multiplayer consensus demo
// State: append-only daily columns (366), hash-chained entries, consensus via simple majority across tabs (demo)

const imgEl = document.getElementById('consensusFrame');
const badgeEl = document.getElementById('confirmBadge');
const prevBtn = document.getElementById('prevConsensus');
const nextBtn = document.getElementById('nextConsensus');
const promptInput = document.getElementById('animPrompt');
const genNextBtn = document.getElementById('genNext');
const confirmBtn = document.getElementById('confirmBtn');

// Multiplayer DB setup
const room = new WebsimSocket();
let currentUserId = null;
let unsubscribeDay = null;
let currentEntry = null; // head entry from DB (top by votes then newest)
let currentVotes = 0;
let userHasVoted = false;

// Utility
function dayOfYear(d=new Date()){
  const start=new Date(Date.UTC(d.getUTCFullYear(),0,1));
  const diff=d - start;
  return Math.floor(diff/86400000);
}
const DAYS = 366; let dayIndex = dayOfYear(); const YEAR_KEY = new Date().getUTCFullYear();
const bc = window.BroadcastChannel ? new BroadcastChannel('nf-sync') : { postMessage() {}, onmessage: null };
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const sha = async (str)=> {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
};

// Local storage helpers (demo "db")
function keyForDay(y, d){ return `nf:${y}:${d}`; }
// entry: { ts, author, prev, dataUrl, comment, hash, confirmations: number, status: 'pending'|'confirmed' }
function readColumn(y, d){ try{ return JSON.parse(localStorage.getItem(keyForDay(y,d))||'[]'); }catch{return [];} }
function writeColumn(y, d, arr){ localStorage.setItem(keyForDay(y,d), JSON.stringify(arr)); }

// Consensus: pick most recent confirmed entry; if none, most recent pending
function pickConsensus(arr){
  const confirmed = [...arr].filter(e=>e.status==='confirmed').sort((a,b)=>b.ts-a.ts);
  if (confirmed.length) return confirmed[0];
  const pending = [...arr].sort((a,b)=>b.ts-a.ts);
  return pending[0] || null;
}

function getHead(arr){ return arr.length ? arr[arr.length-1] : null; }

function renderDbHead() {
  if (!currentEntry) {
    imgEl.removeAttribute('src');
    badgeEl.hidden = true;
    statusEl.textContent = 'No frames yet. Add a Next Frame.';
    confirmBtn.disabled = true;
    return;
  }
  imgEl.src = currentEntry.url;
  const needed = 2;
  badgeEl.hidden = currentVotes >= needed;
  badgeEl.textContent = currentVotes >= needed ? '' : `Confirming… ${currentVotes}/${needed}`;
  statusEl.textContent = currentVotes >= needed ? 'Consensus frame' : 'Awaiting confirmations';
  confirmBtn.disabled = userHasVoted || (currentEntry.user_id === currentUserId);
}

async function subscribeToDay(di) {
  if (unsubscribeDay) { unsubscribeDay(); unsubscribeDay = null; }
  // votes per entry
  const q = room.query(
    `select e.id, e.url, e.comment, e.prev_hash, e.created_at, e.user_id,
            coalesce(vc.votes,0) as votes
     from public.nf_entry e
     left join (
       select v.entry_id, count(distinct v.user_id) as votes
       from public.nf_vote v
       group by v.entry_id
     ) vc on vc.entry_id = e.id
     where e.day = $1
     order by coalesce(vc.votes,0) desc, e.created_at desc`, [di]
  );
  unsubscribeDay = q.subscribe(async (rows) => {
    currentEntry = rows?.[0] || null;
    currentVotes = currentEntry ? currentEntry.votes : 0;
    // did current user vote?
    if (currentEntry && currentUserId) {
      const myVote = await room.collection('nf_vote')
        .filter({ entry_id: currentEntry.id, user_id: currentUserId }).getList();
      userHasVoted = (myVote && myVote.length > 0);
    } else {
      userHasVoted = false;
    }
    renderDbHead();
  });
}

function render() {
  const col = readColumn(YEAR_KEY, dayIndex);
  const head = pickConsensus(col);
  if (!head) {
    imgEl.removeAttribute('src');
    badgeEl.hidden = true;
    statusEl.textContent = 'No frames yet. Add a Next Frame.';
    return;
  }
  imgEl.src = head.dataUrl;
  badgeEl.hidden = head.status === 'confirmed' ? true : false;
  badgeEl.textContent = head.status === 'confirmed' ? '' : 'Confirming…';
  statusEl.textContent = head.status === 'confirmed' ? 'Consensus frame' : 'Awaiting confirmations';
}

// Simple cross-tab consensus: require 2 confirmations (including author) for demo
function maybeConfirm(y, d){
  const col = readColumn(y,d);
  const head = pickConsensus(col);
  if (!head) return;
  if (head.status === 'confirmed') return;
  head.confirmations = (head.confirmations||0)+1;
  if (head.confirmations >= 2) head.status = 'confirmed';
  writeColumn(y,d,col);
  render();
}

bc.onmessage = (ev)=>{
  const { type, year, day } = ev.data || {};
  if (type === 'sync' && year===YEAR_KEY && day===dayIndex) {
    // Re-render on updates
    render();
  }
  if (type === 'confirm' && year===YEAR_KEY && day===dayIndex) {
    render();
  }
};

// AI helper with gentle rate limiting/backoff
let lastReq = 0;
async function rateGate(minGap=1200){
  const wait = Math.max(0, lastReq + minGap - Date.now());
  if (wait>0) await sleep(wait);
  lastReq = Date.now();
}
async function generateNextFrame(prevDataUrl, prompt){
  await rateGate();
  const res = await websim.imageGen({
    prompt: `Create the next animation frame with a subtle incremental change. ${prompt||''}`.trim(),
    image_inputs: prevDataUrl ? [{ url: prevDataUrl }] : undefined,
    width: 512, height: 512
  }).catch(async (e)=>{
    // basic retry on rate limit
    const msg = (e&&e.message)||'';
    if (/429|rate|limit/i.test(msg)) { await sleep(1800); return websim.imageGen({ prompt, image_inputs: prevDataUrl ? [{ url: prevDataUrl }] : undefined, width:512, height:512 }); }
    throw e;
  });
  return res.url;
}

async function appendEntry(url, comment){
  const colPrev = currentEntry; // current top for the day
  const prev = colPrev?.id || null;
  const now = Date.now();
  const hash = await sha(`${now}|${currentUserId}|${prev||''}|${comment||''}|${url}`);
  // create entry (creator can write their own record)
  const entry = await room.collection('nf_entry').upsert({
    day: dayIndex,
    url,
    comment: comment||'',
    prev_hash: prev || '',
    hash
  });
  // auto self-confirm as a vote
  const voteId = `${currentUserId}-${entry.id}`;
  await room.collection('nf_vote').upsert({ id: voteId, entry_id: entry.id });
}

document.getElementById('prevConsensus')?.addEventListener('click', ()=>{
  dayIndex = (dayIndex - 1 + DAYS) % DAYS;
  subscribeToDay(dayIndex);
});
document.getElementById('nextConsensus')?.addEventListener('click', ()=>{
  dayIndex = (dayIndex + 1) % DAYS;
  subscribeToDay(dayIndex);
});

document.getElementById('genNext')?.addEventListener('click', async ()=>{
  genNextBtn.disabled = true; statusEl.textContent = 'Generating next frame…';
  try {
    const prevUrl = currentEntry?.url || null;
    const prompt = promptInput.value.trim();
    const url = await generateNextFrame(prevUrl, prompt || 'Subtle motion, preserve subject and composition.');
    await appendEntry(url, prompt);
    statusEl.textContent = 'Proposed next frame. Awaiting confirmations.';
  } catch(e){
    statusEl.textContent = `Failed: ${e.message||e}`;
  } finally {
    genNextBtn.disabled = false;
  }
});

confirmBtn?.addEventListener('click', async ()=>{
  if (!currentEntry || !currentUserId) return;
  try {
    const voteId = `${currentUserId}-${currentEntry.id}`;
    await room.collection('nf_vote').upsert({ id: voteId, entry_id: currentEntry.id });
    statusEl.textContent = 'Confirmation recorded.';
  } catch(e){ statusEl.textContent = `Confirm failed: ${e.message||e}`; }
});

window.addEventListener('load', async ()=>{
  try {
    currentUserId = (await window.websim.getCurrentUser()).id;
  } catch { /* ignore */ }
  subscribeToDay(dayIndex);
});

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
  const c = frames && frames[currentFrame];
  if (!c || !drawCanvas || !dctx) return;
  const cctx = c.getContext('2d');
  cctx.clearRect(0,0,c.width,c.height);
  cctx.drawImage(drawCanvas, 0, 0);
}

function loadImage(url) {
  return new Promise((resolve, reject) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
}

drawCanvas && drawCanvas.addEventListener('mousedown', e => { const p = getPos(e); startDraw(p.x,p.y); });
drawCanvas && drawCanvas.addEventListener('mousemove', e => { const p = getPos(e); lineTo(p.x,p.y); });
window.addEventListener('mouseup', endDraw);
drawCanvas && drawCanvas.addEventListener('touchstart', e => { e.preventDefault(); const p = getPos(e); startDraw(p.x,p.y); }, {passive:false});
drawCanvas && drawCanvas.addEventListener('touchmove', e => { e.preventDefault(); const p = getPos(e); lineTo(p.x,p.y); }, {passive:false});
drawCanvas && drawCanvas.addEventListener('touchend', e => { e.preventDefault(); endDraw(); }, {passive:false});

document.getElementById('addFrame')?.addEventListener('click', () => {
  const w = frames[0]?.width || drawCanvas.width;
  const h = frames[0]?.height || drawCanvas.height;
  frames.splice(currentFrame + 1, 0, makeBlankCanvas(w, h));
  currentFrame++; renderCurrentFrame(); updateFrameInfo();
});

document.getElementById('deleteFrame')?.addEventListener('click', () => {
  if (frames.length <= 1) return;
  frames.splice(currentFrame, 1);
  currentFrame = Math.max(0, currentFrame - 1);
  renderCurrentFrame(); updateFrameInfo();
});

document.getElementById('prevFrame')?.addEventListener('click', () => {
  if (currentFrame > 0) { currentFrame--; renderCurrentFrame(); updateFrameInfo(); }
});
document.getElementById('nextFrame')?.addEventListener('click', () => {
  if (currentFrame < frames.length - 1) { currentFrame++; renderCurrentFrame(); updateFrameInfo(); }
});

document.getElementById('clearFrame')?.addEventListener('click', () => {
  dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
  commitCanvasToFrame();
});

document.getElementById('gifWidth')?.addEventListener('change', onSizeChange);
document.getElementById('gifHeight')?.addEventListener('change', onSizeChange);
function onSizeChange() {
  const w = clampInt(parseInt(document.getElementById('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(document.getElementById('gifHeight').value,10),16,2048);
  // Rescale all frames to new size
  frames = frames.map(src => {
    const n = makeBlankCanvas(w,h); n.getContext('2d').drawImage(src,0,0,w,h); return n;
  });
  syncCanvasSize(w,h); renderCurrentFrame();
}

uploadInput && uploadInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    dctx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
    dctx.drawImage(bmp, 0, 0, drawCanvas.width, drawCanvas.height);
    commitCanvasToFrame(); statusEl.textContent = 'Image loaded into frame.';
  } catch(err){ statusEl.textContent = 'Failed to load image.'; }
});

aiBtn?.addEventListener('click', async () => {
  const base = el('aiBasePrompt').value.trim();
  const anim = el('aiAnimPrompt').value.trim();
  const total = clampInt(parseInt(el('aiFrames').value,10), 2, 30);
  if (!base) { statusEl.textContent = 'Enter a base image prompt.'; return; }
  const w = clampInt(parseInt(el('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(el('gifHeight').value,10),16,2048);
  if (aiBtn) aiBtn.disabled = true;
  if (btn) btn.disabled = true;
  downloadLink.style.display='none'; statusEl.textContent = 'Generating base frame...';
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
    if (aiBtn) aiBtn.disabled = false;
    if (btn) btn.disabled = false;
  }
});

aiRegenBtn?.addEventListener('click', async () => {
  if (!frames.length) { statusEl.textContent = 'No frames to regenerate.'; return; }
  const w = clampInt(parseInt(el('gifWidth').value,10),16,2048);
  const h = clampInt(parseInt(el('gifHeight').value,10),16,2048);
  const anim = el('aiAnimPrompt').value.trim();
  const prompt = `Regenerate this in-between animation frame using the surrounding frames as guidance. Maintain subject identity, palette, and composition. Ensure smooth motion continuity${anim ? ` toward: "${anim}"` : ''}. Keep changes minimal.`;
  const inputs = [];
  if (frames[currentFrame-1]) inputs.push({ url: frames[currentFrame-1].toDataURL() });
  inputs.push({ url: frames[currentFrame].toDataURL() });
  if (frames[currentFrame+1]) inputs.push({ url: frames[currentFrame+1].toDataURL() });
  if (aiRegenBtn) aiRegenBtn.disabled = true;
  if (btn) btn.disabled = true;
  statusEl.textContent = 'Regenerating current frame...';
  try {
    const res = await generateImageSafe(prompt, { width: w, height: h, image_inputs: inputs }, 'Regenerating frame');
    const img = await loadImage(res.url);
    const ctx = frames[currentFrame].getContext('2d');
    ctx.clearRect(0,0,w,h); ctx.drawImage(img,0,0,w,h);
    renderCurrentFrame(); statusEl.textContent = 'Frame regenerated.';
  } catch(e) {
    console.error(e); statusEl.textContent = `Regeneration failed: ${e.message || e}`;
  } finally {
    if (aiRegenBtn) aiRegenBtn.disabled = false;
    if (btn) btn.disabled = false;
  }
});

aiNextBtn?.addEventListener('click', async () => {
  if (!frames.length) { statusEl.textContent = 'No base frame. Draw or generate one first.'; return; }
  const w = frames[0].width, h = frames[0].height;
  const anim = el('aiAnimPrompt').value.trim();
  const prev = frames[frames.length - 1];
  const prompt = `Generate the next animation frame continuing subtle motion${anim ? ` toward: "${anim}"` : ''}. Preserve subject identity and composition; minimal change for smooth animation.`;
  if (aiNextBtn) aiNextBtn.disabled = true;
  if (btn) btn.disabled = true;
  statusEl.textContent = 'Generating next frame...';
  try {
    const res = await generateImageSafe(prompt, { width: w, height: h, image_inputs: [{ url: prev.toDataURL() }] }, 'Next frame');
    const img = await loadImage(res.url);
    const c = makeBlankCanvas(w,h); c.getContext('2d').drawImage(img,0,0,w,h);
    frames.push(c); currentFrame = frames.length - 1; renderCurrentFrame(); updateFrameInfo();
    statusEl.textContent = 'Next frame added.';
  } catch(e){ statusEl.textContent = `Next frame failed: ${e.message || e}`; }
  finally {
    if (aiNextBtn) aiNextBtn.disabled = false;
    if (btn) btn.disabled = false;
  }
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