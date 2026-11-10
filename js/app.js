/* =========================================================================
 * PDF 页面整理工具  —  纯前端 / 本地处理
 * 依赖：vendor/pdf-lib.min.js (PDF 读写)  vendor/pdf.min.js (缩略图渲染)
 * ========================================================================= */
'use strict';
(function () {

const { PDFDocument, degrees, PDFName, PDFNumber } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ============================ 1. 基础工具 ============================ */

const PT_PER_MM = 72 / 25.4;
const mm = v => v * PT_PER_MM;
const pt2mm = v => v / PT_PER_MM;

const PAPERS = {
  A4:   [595.28, 841.89],
  A4L:  [841.89, 595.28],
  A3:   [841.89, 1190.55],
  A3L:  [1190.55, 841.89],
  A5:   [419.53, 595.28],
  letter: [612, 792],
};

const SRC_COLORS = ['#2f6bff', '#0f9d76', '#d9822b', '#8b5cf6', '#e0453f', '#0ea5e9', '#c026d3'];

let seq = 0;
const uid = () => 'k' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function toast(msg, kind) {
  const box = $('toasts');
  const d = document.createElement('div');
  d.className = 'toast' + (kind ? ' ' + kind : '');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => {
    d.style.transition = 'opacity .2s, transform .2s';
    d.style.opacity = '0';
    d.style.transform = 'translateY(6px)';
    setTimeout(() => d.remove(), 220);
  }, kind === 'err' ? 4200 : 2400);
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ============================ 2. 状态 ============================ */

const state = {
  sources: new Map(),   // id -> {id, name, bytes, lib, js, meta:[{w,h,rot,box,color,label}]}
  pages: [],            // 页面项
  selected: new Set(),
  history: [],
  future: [],
  zoom: 1,              // 0/1/2 -> TILE_SIZES
  anchorSel: null,      // shift 连选锚点
  dragId: null,
  dragEndedAt: 0,       // 刚完成拖拽的时间戳，用于吞掉拖拽后紧随的误点
};

const TILE_SIZES = [
  { w: 132, h: 186, label: '小' },
  { w: 176, h: 244, label: '中' },
  { w: 226, h: 312, label: '大' },
];

/* ============================ 3. 载入 PDF ============================ */

let loading = 0;

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { toast('请选择 PDF 文件'); return; }

  showBusy('正在读取文件…', 0);
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      await addOne(files[i], (i + 1) / files.length);
      ok++;
    } catch (err) {
      console.error(err);
      toast(err.message || ('「' + files[i].name + '」读取失败'), 'err');
    }
  }
  hideBusy();
  if (ok) {
    syncGrid();
    toast('已添加 ' + ok + ' 个文件', 'ok');
  }
  $('fileInput').value = '';
}

async function addOne(file, progress) {
  const buf = new Uint8Array(await file.arrayBuffer());

  let lib;
  try {
    lib = await PDFDocument.load(buf.slice(0), { updateMetadata: false });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/encrypt/i.test(msg)) throw new Error('「' + file.name + '」已加密，暂不支持');
    throw new Error('「' + file.name + '」不是有效的 PDF');
  }

  let jsDoc;
  try {
    jsDoc = await pdfjsLib.getDocument({
      data: buf.slice(0),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/password/i.test(msg)) throw new Error('「' + file.name + '」需要密码，暂不支持');
    throw new Error('「' + file.name + '」渲染失败');
  }

  const id = uid();
  const color = SRC_COLORS[state.sources.size % SRC_COLORS.length];
  const meta = lib.getPages().map(p => {
    const box = p.getCropBox();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    return { w: box.width, h: box.height, rot, box: { x: box.x, y: box.y } };
  });

  const src = {
    id, name: file.name, size: file.size, bytes: buf,
    lib, js: jsDoc, meta, color,
    label: file.name.replace(/\.pdf$/i, ''),
  };
  state.sources.set(id, src);
  renderSourceList();

  const newItems = meta.map((_, i) => makeItem(id, i));
  state.pages.push(...newItems);
  state.selected = new Set(newItems.map(p => p.id));
  state.history.length = 0;
  state.future.length = 0;

  if (typeof progress === 'function') progress();
}

function makeItem(srcId, index) {
  return { id: uid(), srcId, index, rotation: 0, crop: null, size: null };
}

function cloneItem(it) {
  return {
    id: it.id,
    srcId: it.srcId,
    index: it.index,
    rotation: it.rotation || 0,
    crop: it.crop ? { ...it.crop } : null,
    size: it.size ? { ...it.size } : null,
    blank: it.blank ? { ...it.blank } : null,
  };
}

/* ============================ 4. 几何计算 ============================ */

/*
 * 约定：
 *  rot      —— 实际显示角度（= 源页面 /Rotate + 用户额外旋转）
 *  crop     —— 按“显示方向”计量的四边裁切量（单位 pt）
 *  cw/ch    —— 裁切后、未旋转的内容尺寸
 *  sx/sy    —— 裁切框在源页面坐标系中的左下角
 *  dw/dh    —— 裁切后内容在显示方向上的尺寸
 */

function dispSize(rot, cw, ch) {
  return (rot % 180 === 90) ? { w: ch, h: cw } : { w: cw, h: ch };
}

/** 显示方向裁切量 -> 源页面坐标矩形（未旋转） */
function dispCropToSource(W, H, rot, crop) {
  const left = clamp(crop.left, -4000, 4000) || 0;
  const right = clamp(crop.right, -4000, 4000) || 0;
  const top = clamp(crop.top, -4000, 4000) || 0;
  const bottom = clamp(crop.bottom, -4000, 4000) || 0;
  const dW = rot % 180 === 90 ? H : W;   // 显示方向整页宽
  const dH = rot % 180 === 90 ? W : H;

  let w = dW - left - right;
  let h = dH - top - bottom;
  if (w < 8) w = 8;
  if (h < 8) h = 8;

  switch (rot) {
    case 90:  return { x: top,        y: left,         w: W - top - bottom, h: H - left - right };
    case 180: return { x: right,      y: top,          w: W - left - right, h: H - top - bottom };
    case 270: return { x: bottom,     y: right,        w: W - top - bottom, h: H - left - right };
    default:  return { x: left,       y: bottom,       w: W - left - right, h: H - top - bottom };
  }
}

function itemGeom(item) {
  if (item.blank) {
    return { rot: 0, cw: item.blank.w, ch: item.blank.h, sx: 0, sy: 0 };
  }
  const src = state.sources.get(item.srcId);
  const m = src.meta[item.index];
  const rot = ((m.rot + (item.rotation || 0)) % 360 + 360) % 360;
  const crop = item.crop || { left: 0, right: 0, top: 0, bottom: 0 };
  const r = dispCropToSource(m.w, m.h, rot, crop);
  // 防止裁切越界
  const x = clamp(r.x, -2000, m.w);
  const y = clamp(r.y, -2000, m.h);
  const cw = clamp(r.w, 8, m.w + 4000);
  const ch = clamp(r.h, 8, m.h + 4000);
  return { rot, cw, ch, sx: m.box.x + x, sy: m.box.y + y };
}

/** 九宫格对齐 -> 显示方向上的偏移 */
function alignOffset(dw, dh, W, H, align) {
  let x = (W - dw) / 2, y = (H - dh) / 2;
  if (align === 'left' || align === 'tl' || align === 'bl') x = 0;
  if (align === 'right' || align === 'tr' || align === 'br') x = W - dw;
  if (align === 'top' || align === 'tl' || align === 'tr') y = H - dh;
  if (align === 'bottom' || align === 'bl' || align === 'br') y = 0;
  return [x, y];
}

/** 显示方向偏移 -> 未旋转页坐标系中的偏移 */
function dispOffToUnrot(ox, oy, dw, dh, mw, mh, rot) {
  switch (rot) {
    case 90:  return [mw - oy - dw, ox];
    case 180: return [mw - ox - dw, mh - oy - dh];
    case 270: return [oy, mh - ox - dh];
    default:  return [ox, oy];
  }
}

/** drawPage 锚点：把内容画到显示方向矩形 (X,Y,dW,dH) 上 */
function rotAnchor(X, Y, dW, dH, rot) {
  switch (rot) {
    case 90:  return { x: X, y: Y + dH, w: dH, h: dW, rotate: 270 };
    case 180: return { x: X + dW, y: Y + dH, w: dW, h: dH, rotate: 180 };
    case 270: return { x: X + dW, y: Y, w: dH, h: dW, rotate: 90 };
    default:  return { x: X, y: Y, w: dW, h: dH, rotate: 0 };
  }
}

/* ============================ 5. 缩略图渲染 ============================ */

const tiles = new Map();      // itemId -> tile 对象
let observer = null;
const renderQueue = [];
let rendering = 0;

function tileSize() { return TILE_SIZES[state.zoom]; }

function createTile(item) {
  const node = document.createElement('div');
  node.className = 'tile';
  node.dataset.id = item.id;
  node.draggable = true;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const ph = document.createElement('div');
  ph.className = 'ph';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'none';

  const pno = document.createElement('span');
  pno.className = 'pno';

  const flags = document.createElement('div');
  flags.className = 'flags';

  const quick = document.createElement('div');
  quick.className = 'quick';
  quick.innerHTML =
    '<button data-q="rotL" title="左转 90°">↺</button>' +
    '<button data-q="rotR" title="右转 90°">↻</button>' +
    '<button data-q="dup" title="复制此页">⧉</button>' +
    '<button data-q="del" class="del" title="删除此页">✕</button>';

  thumb.append(ph, canvas, pno, flags, quick);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const nm = document.createElement('span');
  nm.className = 'nm';
  meta.append(nm);

  node.append(thumb, meta);

  const tile = { el: node, canvas, ph, pno, flags, meta: nm, key: '', task: null, visible: false };
  tiles.set(item.id, tile);

  node.addEventListener('click', e => onTileClick(e, item.id));
  quick.addEventListener('click', e => {
    e.stopPropagation();
    const q = e.target.dataset && e.target.dataset.q;
    if (!q) return;
    if (!state.selected.has(item.id)) selectOnly(item.id);
    if (q === 'del') cmdDelete();
    else if (q === 'dup') cmdDuplicate();
    else if (q === 'rotL') cmdRotate(-90);
    else if (q === 'rotR') cmdRotate(90);
  });

  node.addEventListener('dragstart', e => {
    state.dragId = item.id;
    node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', item.id); } catch (err) {}
  });
  node.addEventListener('dragend', () => {
    state.dragId = null;
    node.classList.remove('dragging');
    removeDropLine();
  });

  if (observer) observer.observe(node);
  return tile;
}

function updateTileChrome(tile, item, index) {
  tile.pno.textContent = 'P' + (index + 1);
  const g = itemGeom(item);
  const src = item.blank ? null : state.sources.get(item.srcId);
  tile.meta.textContent = item.blank ? '空白页' : src.label;
  tile.meta.title = item.blank ? '空白页' : src.name;

  const badges = [];
  if (item.rotation) badges.push((item.rotation % 360) + '°');
  if (item.crop) badges.push('裁剪');
  if (item.size) badges.push('改尺寸');
  if (item.blank) badges.push('空白');
  tile.flags.innerHTML = badges.map(b => '<span class="flag">' + b + '</span>').join('');

  tile.el.classList.toggle('sel', state.selected.has(item.id));
  tile.el.dataset.key = itemKey(item);
  if (g) { /* noop */ }
}

function itemKey(item) {
  const s = item.size ? (item.size.w | 0) + 'x' + (item.size.h | 0) + item.size.mode + item.size.align : '-';
  const c = item.crop ? [item.crop.left | 0, item.crop.right | 0, item.crop.top | 0, item.crop.bottom | 0].join(',') : '-';
  return [item.blank ? 'B' + (item.blank.w | 0) + 'x' + (item.blank.h | 0) : item.srcId + ':' + item.index,
    item.rotation | 0, c, s, tileSize().w].join('|');
}

function queueRender(tile) {
  if (!renderQueue.includes(tile)) renderQueue.push(tile);
  pump();
}

function pump() {
  const limit = 2;
  while (rendering < limit && renderQueue.length) {
    const tile = renderQueue.shift();
    if (!tile || !tile.el.isConnected) continue;
    const item = state.pages.find(p => p.id === tile.el.dataset.id);
    if (!item) continue;
    rendering++;
    renderTile(tile, item).catch(err => console.warn('render', err)).finally(() => {
      rendering--;
      pump();
    });
  }
}

async function renderTile(tile, item) {
  const key = itemKey(item);
  if (tile.key === key) return;
  tile.key = key;

  const box = tileSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const g = itemGeom(item);
  const disp = item.size ? { w: item.size.w, h: item.size.h } : dispSize(g.rot, g.cw, g.ch);

  const scale = Math.min(box.w / disp.w, box.h / disp.h);
  const cssW = Math.max(24, Math.round(disp.w * scale));
  const cssH = Math.max(24, Math.round(disp.h * scale));

  if (tile.task) { try { tile.task.cancel(); } catch (e) {} tile.task = null; }

  const canvas = tile.canvas;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cssW, cssH);

  // 目标尺寸框（虚线）
  if (item.size) {
    ctx.strokeStyle = '#c9d3e4';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
    ctx.setLineDash([]);
  }

  if (item.blank) {
    canvas.style.display = 'block';
    tile.ph.style.display = 'none';
    return;
  }

  const src = state.sources.get(item.srcId);
  const page = await src.js.getPage(item.index + 1);
  const rot = g.rot;
  const viewport = page.getViewport({ scale: 1, rotation: rot });
  const crop = item.crop || { left: 0, right: 0, top: 0, bottom: 0 };
  const cropL = clamp(crop.left, -2000, viewport.width);
  const cropT = clamp(crop.top, -2000, viewport.height);
  const cropR = clamp(crop.right, -2000, viewport.width);
  const cropB = clamp(crop.bottom, -2000, viewport.height);
  const cropW = Math.max(4, viewport.width - cropL - cropR);
  const cropH = Math.max(4, viewport.height - cropT - cropB);

  const dispCrop = { w: cropW, h: cropH };
  const contentScale = item.size
    ? fitScale(dispCrop.w, dispCrop.h, item.size)
    : 1;

  // 渲染分辨率：让最终显示的裁切内容达到 css 尺寸
  const targetPx = Math.min(cssW, dispCrop.w * 4);
  const renderScale = Math.max(0.2, Math.min(3, (targetPx / Math.max(1, dispCrop.w)) * dpr));

  const vp = page.getViewport({ scale: renderScale, rotation: rot });
  const full = document.createElement('canvas');
  full.width = Math.max(1, Math.ceil(vp.width));
  full.height = Math.max(1, Math.ceil(vp.height));
  const fctx = full.getContext('2d');
  fctx.fillStyle = '#fff';
  fctx.fillRect(0, 0, full.width, full.height);

  tile.task = page.render({ canvasContext: fctx, viewport: vp });
  try { await tile.task.promise; } catch (e) { return; }
  tile.task = null;

  // 裁切区域（像素）
  const sx = cropL * renderScale;
  const sy = cropT * renderScale;
  const sw = cropW * renderScale;
  const sh = cropH * renderScale;

  if (item.size) {
    const cw = dispCrop.w * contentScale.x;
    const ch = dispCrop.h * contentScale.y;
    const W = cssW, H = cssH;
    const [ox, oy] = alignOffset(cw, ch, W, H, item.size.align || 'center');
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.drawImage(full, sx, sy, sw, sh, ox, H - oy - ch, cw, ch);
    ctx.restore();
  } else {
    ctx.drawImage(full, sx, sy, sw, sh, 0, 0, cssW, cssH);
  }

  canvas.style.display = 'block';
  tile.ph.style.display = 'none';
}

/** 尺寸覆盖时的内容缩放（返回显示方向的 sx, sy） */
function fitScale(cw, ch, size) {
  const { w: W, h: H, mode } = size;
  if (mode === 'stretch') return { x: W / cw, y: H / ch };
  if (mode === 'actual') return { x: 1, y: 1 };
  const s = Math.min(W / cw, H / ch);
  return { x: s, y: s };
}

function markDirty(itemId) {
  const tile = tiles.get(itemId);
  if (tile) { tile.key = ''; if (isVisible(tile.el)) queueRender(tile); }
}

function isVisible(node) {
  const r = node.getBoundingClientRect();
  return r.bottom > -400 && r.top < window.innerHeight + 400;
}

function markAllDirty() {
  state.pages.forEach(p => {
    const t = tiles.get(p.id);
    if (t) t.key = '';
  });
  tiles.forEach(t => { if (isVisible(t.el)) queueRender(t); });
}

/* ============================ 6. 网格 / 选择 ============================ */

function syncGrid() {
  const grid = $('grid');
  const alive = new Set(state.pages.map(p => p.id));

  tiles.forEach((t, id) => {
    if (!alive.has(id)) { t.el.remove(); tiles.delete(id); }
  });

  const frag = document.createDocumentFragment();
  state.pages.forEach((item, i) => {
    let tile = tiles.get(item.id);
    if (!tile) tile = createTile(item);
    updateTileChrome(tile, item, i);
    frag.appendChild(tile.el);
  });
  grid.appendChild(frag);

  $('welcome').hidden = state.pages.length > 0;
  updateStatus();
  updateSourceList();
  pump();
}

function selectOnly(id) {
  state.selected = new Set([id]);
  state.anchorSel = id;
  refreshSelection();
}

function onTileClick(e, id) {
  // 拖拽结束后的极短时间内可能跟着一次 click，忽略它，避免误选；
  // 用时间窗而不是布尔标记，防止该标记一直留到用户的下一次真实点击。
  if (performance.now() - state.dragEndedAt < 300) return;
  const idx = state.pages.findIndex(p => p.id === id);
  if (e.shiftKey && state.anchorSel) {
    const a = state.pages.findIndex(p => p.id === state.anchorSel);
    if (a >= 0) {
      const [s, t] = a < idx ? [a, idx] : [idx, a];
      if (!e.ctrlKey && !e.metaKey) state.selected.clear();
      for (let i = s; i <= t; i++) state.selected.add(state.pages[i].id);
      refreshSelection();
      return;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else {
    state.selected = new Set([id]);
  }
  state.anchorSel = id;
  refreshSelection();
}

function refreshSelection() {
  tiles.forEach((t, id) => t.el.classList.toggle('sel', state.selected.has(id)));
  updateStatus();
}

function updateStatus() {
  $('stPages').textContent = state.pages.length + ' 页';
  const n = state.selected.size;
  $('stSel').textContent = n ? ('已选 ' + n + ' 页') : '未选中';
  let bytes = 0;
  let cnt = 0;
  const seen = new Set();
  state.pages.forEach(p => {
    if (p.srcId && !seen.has(p.srcId)) { seen.add(p.srcId); const s = state.sources.get(p.srcId); if (s) { bytes += s.size; cnt++; } }
  });
  $('stSize').textContent = cnt ? (cnt + ' 个源文件 · ' + fmtSize(bytes)) : '';
  $('btnUndo').disabled = !state.history.length;
  $('btnRedo').disabled = !state.future.length;
  $('btnExport').disabled = !state.pages.length;
  $('btnExtract').disabled = !state.selected.size;
}

function updateSourceList() {
  $('srcCount').textContent = state.sources.size;
  $('srcEmpty').style.display = state.sources.size ? 'none' : '';
  const list = $('srcList');
  list.innerHTML = '';
  state.sources.forEach(src => {
    const li = document.createElement('li');
    li.className = 'src-item';
    const used = state.pages.filter(p => p.srcId === src.id).length;
    li.innerHTML =
      '<span class="dotc" style="background:' + src.color + '"></span>' +
      '<span class="nm" title="' + esc(src.name) + '">' + esc(src.label) + '</span>' +
      '<span class="pg">' + used + '/' + src.meta.length + ' 页</span>' +
      '<button class="rm" title="移除该文件的所有页面">✕</button>';
    li.querySelector('.rm').addEventListener('click', () => removeSource(src.id));
    list.appendChild(li);
  });
}

function renderSourceList() { updateSourceList(); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function removeSource(id) {
  if (!state.pages.some(p => p.srcId === id)) { state.sources.delete(id); updateSourceList(); return; }
  if (!confirm('移除「' + state.sources.get(id).name + '」的所有页面？')) return;
  pushHistory();
  state.pages = state.pages.filter(p => p.srcId !== id);
  state.selected.forEach(sid => { if (!state.pages.some(p => p.id === sid)) state.selected.delete(sid); });
  syncGrid();
}

/* ============================ 7. 拖拽排序 ============================ */

let dropLine = null;

function removeDropLine() {
  if (dropLine) { dropLine.remove(); dropLine = null; }
}

function dropTargetIndex(clientX, clientY) {
  const list = Array.from($('grid').querySelectorAll('.tile'));
  if (!list.length) return 0;
  let best = { d: Infinity, i: list.length };
  list.forEach((node, i) => {
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (clientX - cx) * (clientX - cx) + (clientY - cy) * (clientY - cy) * 1.6;
    if (d < best.d) best = { d, i };
  });
  const node = list[best.i];
  if (!node) return list.length;
  const r = node.getBoundingClientRect();
  const before = clientY < r.top + r.height / 2;
  return before ? best.i : best.i + 1;
}

function showDropLine(idx) {
  const grid = $('grid');
  const list = Array.from(grid.querySelectorAll('.tile'));
  if (!dropLine) {
    dropLine = document.createElement('div');
    dropLine.className = 'insert-line';
  }
  const h = list[0] ? list[0].offsetHeight : 180;
  dropLine.style.height = h + 'px';
  const ref = list[idx] || null;
  if (ref) grid.insertBefore(dropLine, ref);
  else grid.appendChild(dropLine);
}

function setupGridDnD() {
  const grid = $('grid');

  grid.addEventListener('dragover', e => {
    if (!state.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropLine(dropTargetIndex(e.clientX, e.clientY));
  });

  grid.addEventListener('dragleave', e => {
    if (!grid.contains(e.relatedTarget)) removeDropLine();
  });

  grid.addEventListener('drop', e => {
    if (!state.dragId) return;
    e.preventDefault();
    const id = state.dragId;
    const from = state.pages.findIndex(p => p.id === id);
    let to = dropTargetIndex(e.clientX, e.clientY);
    removeDropLine();
    if (from < 0) return;
    if (to > from) to--;
    if (to === from) return;
    pushHistory();
    const [item] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, item);
    state.selected = new Set([item.id]);
    syncGrid();
    state.dragEndedAt = performance.now();
  });

  // 从资源管理器拖入
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (state.dragId) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++;
    $('dropHint').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').classList.remove('on');
  });
  window.addEventListener('dragover', e => {
    if (state.dragId) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', e => {
    if (state.dragId) return;
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').classList.remove('on');
    addFiles(e.dataTransfer.files);
  });
}

/* ============================ 8. 命令 / 历史 ============================ */

function snapshot() {
  return { pages: state.pages.map(cloneItem), selected: [...state.selected] };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
  state.future.length = 0;
}

function restore(s) {
  state.pages = s.pages.map(cloneItem);
  const ids = new Set(state.pages.map(p => p.id));
  state.selected = new Set(s.selected.filter(id => ids.has(id)));
  syncGrid();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  const s = state.history.pop();
  restore(s);
  toast('已撤销');
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
  toast('已重做');
}

function withHistory(fn) {
  pushHistory();
  fn();
  syncGrid();
}

function targetItems() {
  if (!state.selected.size) return state.pages.slice();
  return state.pages.filter(p => state.selected.has(p.id));
}

function cmdRotate(delta) {
  const items = targetItems();
  if (!items.length) return;
  withHistory(() => {
    items.forEach(it => {
      it.rotation = (((it.rotation || 0) + delta) % 360 + 360) % 360;
      markDirty(it.id);
    });
  });
}

function cmdDelete() {
  const items = targetItems();
  if (!items.length) { toast('请先选择页面'); return; }
  if (!state.selected.size) { toast('没有选中页面'); return; }
  withHistory(() => {
    const ids = new Set(state.selected);
    state.pages = state.pages.filter(p => !ids.has(p.id));
    state.selected.clear();
  });
  toast('已删除 ' + items.length + ' 页');
}

function cmdDuplicate() {
  if (!state.selected.size) { toast('请先选择页面'); return; }
  withHistory(() => {
    const next = [];
    const newSel = new Set();
    state.pages.forEach(p => {
      next.push(p);
      if (state.selected.has(p.id)) {
        const c = cloneItem(p);
        c.id = uid();
        next.push(c);
        newSel.add(c.id);
      }
    });
    state.pages = next;
    state.selected = newSel;
  });
}

function cmdInsertBlank() {
  const blank = blankSize();
  withHistory(() => {
    const idx = state.selected.size
      ? Math.max(...[...state.selected].map(id => state.pages.findIndex(p => p.id === id))) + 1
      : state.pages.length;
    const item = { id: uid(), blank: blank, rotation: 0, crop: null, size: null };
    state.pages.splice(idx, 0, item);
    state.selected = new Set([item.id]);
  });
}

function blankSize() {
  const last = state.pages[state.pages.length - 1];
  if (last) {
    const g = itemGeom(last);
    return { w: g.cw, h: g.ch };
  }
  return { w: PAPERS.A4[0], h: PAPERS.A4[1] };
}

function cmdKeepSelected() {
  if (!state.selected.size) { toast('请先选择要保留的页面'); return; }
  if (state.selected.size === state.pages.length) { toast('已选中全部页面'); return; }
  withHistory(() => {
    const ids = new Set(state.selected);
    state.pages = state.pages.filter(p => ids.has(p.id));
  });
  toast('已只保留选中页面');
}

function cmdApplySize() {
  const size = readSizeForm();
  if (!size) return;
  const items = targetItems();
  if (!items.length) return;
  withHistory(() => {
    items.forEach(it => { it.size = { ...size }; markDirty(it.id); });
  });
  toast('已应用尺寸到 ' + items.length + ' 页');
}

function cmdClearSize() {
  const items = targetItems();
  withHistory(() => {
    items.forEach(it => { it.size = null; markDirty(it.id); });
  });
}

function cmdApplyCrop() {
  const crop = {
    top: mm(+$('cropTop').value || 0),
    bottom: mm(+$('cropBottom').value || 0),
    left: mm(+$('cropLeft').value || 0),
    right: mm(+$('cropRight').value || 0),
  };
  if (!crop.top && !crop.bottom && !crop.left && !crop.right) { cmdClearCrop(); return; }
  const items = targetItems();
  withHistory(() => {
    items.forEach(it => { it.crop = { ...crop }; markDirty(it.id); });
  });
  toast('已裁剪 ' + items.length + ' 页');
}

function cmdClearCrop() {
  const items = targetItems();
  withHistory(() => {
    items.forEach(it => { it.crop = null; markDirty(it.id); });
  });
}

function readSizeForm() {
  const preset = $('sizePreset').value;
  let w, h;
  if (preset === 'custom') {
    w = mm(+$('sizeW').value);
    h = mm(+$('sizeH').value);
    if (!(w > 20 && h > 20)) { toast('请输入有效的自定义尺寸'); return null; }
  } else if (preset === 'keep') {
    return null;
  } else {
    [w, h] = PAPERS[preset];
  }
  return { w, h, mode: $('sizeMode').value, align: $('sizeAlign').value };
}

/* ============================ 9. 导出 ============================ */

function scopeItems() {
  if ($('expScope').value === 'selected') return state.pages.filter(p => state.selected.has(p.id));
  return state.pages.slice();
}

function readExportOptions() {
  const nup = parseInt($('expNup').value, 10) || 1;
  return {
    nup,
    paper: $('expPaper').value,
    gap: mm(parseFloat($('expGap').value) || 0),
    border: $('expBorder').checked,
    split: $('expSplit').value,
    eachN: Math.max(1, parseInt($('expEachN').value, 10) || 1),
    ranges: $('expRanges').value.trim(),
  };
}

/** 生成单个 PDF 的字节 */
async function buildPdf(items, opt, onProgress) {
  if (!items.length) throw new Error('没有可导出的页面');
  const out = await PDFDocument.create();
  out.setProducer('PDF 页面整理工具');
  out.setCreator('PDF 页面整理工具');

  if (opt.nup > 1) {
    await buildNup(out, items, opt, onProgress);
  } else {
    // 同一个源文件一次性批量复制，避免重复资源（图片/字体）导致体积膨胀
    const groups = new Map();
    const plan = [];
    for (const it of items) {
      if (it.blank) { plan.push({ item: it }); continue; }
      let g = groups.get(it.srcId);
      if (!g) {
        g = { src: state.sources.get(it.srcId).lib, indices: [], slots: [] };
        groups.set(it.srcId, g);
      }
      g.indices.push(it.index);
      plan.push({ item: it, group: g, slot: g.indices.length - 1 });
    }

    let done = 0;
    const total = groups.size + plan.length;
    for (const g of groups.values()) {
      g.copied = await out.copyPages(g.src, g.indices);
      done++;
      onProgress && onProgress(done / total);
    }

    const ordered = [];
    for (const p of plan) {
      let page;
      if (p.item.blank) {
        page = out.addPage([p.item.blank.w, p.item.blank.h]);
      } else {
        page = p.group.copied[p.slot];
        applyPageEdits(page, p.item);
      }
      ordered.push(page);
      done++;
      if (done % 8 === 0) onProgress && onProgress(done / total);
    }
    reorderPages(out, ordered);
    onProgress && onProgress(1);
  }

  return await out.save({ useObjectStreams: true });
}

function applyPageEdits(page, item) {
  const g = itemGeom(item);
  page.setRotation(degrees(g.rot));
  page.setCropBox(g.sx, g.sy, g.cw, g.ch);

  // 负裁剪（向外加白边）时，需同步扩大画布，否则阅读器会按 MediaBox 截掉白边
  if (!item.size) {
    const mb = page.getMediaBox();
    const x0 = Math.min(mb.x, g.sx);
    const y0 = Math.min(mb.y, g.sy);
    const x1 = Math.max(mb.x + mb.width, g.sx + g.cw);
    const y1 = Math.max(mb.y + mb.height, g.sy + g.ch);
    if (x0 !== mb.x || y0 !== mb.y || x1 !== mb.x + mb.width || y1 !== mb.y + mb.height) {
      page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    }
  }

  if (item.size) {
    const { w: W, h: H, mode, align } = item.size;
    const rot = g.rot;
    const swap = rot % 180 === 90;
    const mw = swap ? H : W;
    const mh = swap ? W : H;

    const dw0 = swap ? g.ch : g.cw;
    const dh0 = swap ? g.cw : g.ch;

    let sx, sy;
    if (mode === 'stretch') {
      // 让显示方向的宽高正好填满
      if (swap) { sx = H / g.cw; sy = W / g.ch; }
      else { sx = W / g.cw; sy = H / g.ch; }
    } else if (mode === 'actual') {
      sx = 1; sy = 1;
    } else {
      const s = Math.min(W / dw0, H / dh0);
      sx = s; sy = s;
    }

    const dw = g.cw * sx;
    const dh = g.ch * sy;
    const dWc = swap ? dh : dw;
    const dHc = swap ? dw : dh;

    const [ox, oy] = alignOffset(dWc, dHc, W, H, align || 'center');
    const [ux, uy] = dispOffToUnrot(ox, oy, dw, dh, mw, mh, rot);

    page.scaleContent(sx, sy);
    page.translateContent(ux - sx * g.sx, uy - sy * g.sy);
    page.setMediaBox(0, 0, mw, mh);
    page.setCropBox(0, 0, mw, mh);
  }
}

/** 按给定顺序重排页面（不复制对象，避免资源重复） */
function reorderPages(doc, ordered) {
  const count = doc.getPageCount();
  for (let i = count - 1; i >= 0; i--) doc.removePage(i);
  ordered.forEach((page, i) => doc.insertPage(i, page));
}

function nupLayout(n, paper) {
  if (n === 2) return paper === 'A4L' || paper === 'A3L' ? [2, 1] : [1, 2];
  if (n === 4) return [2, 2];
  if (n === 6) return [2, 3];
  return [3, 3];
}

function sheetSize(paper, items) {
  if (paper === 'auto') {
    const first = items.find(p => !p.blank) || items[0];
    if (first) {
      const g = itemGeom(first);
      const d = dispSize(g.rot, g.cw, g.ch);
      return { w: d.w, h: d.h };
    }
    return { w: PAPERS.A4[0], h: PAPERS.A4[1] };
  }
  const p = PAPERS[paper] || PAPERS.A4;
  return { w: p[0], h: p[1] };
}

async function buildNup(out, items, opt, onProgress) {
  const n = opt.nup;
  const sheet = sheetSize(opt.paper, items);
  const [cols, rows] = nupLayout(n, opt.paper);
  const gap = opt.gap;
  const slotW = (sheet.w - gap * (cols + 1)) / cols;
  const slotH = (sheet.h - gap * (rows + 1)) / rows;

  const sheets = Math.ceil(items.length / n);
  for (let s = 0; s < sheets; s++) {
    const page = out.addPage([sheet.w, sheet.h]);
    const chunk = items.slice(s * n, s * n + n);

    for (let k = 0; k < chunk.length; k++) {
      const it = chunk[k];
      const col = k % cols;
      const row = Math.floor(k / cols);
      const X0 = gap + col * (slotW + gap);
      const Y0 = sheet.h - gap - (row + 1) * slotH - row * gap;

      if (opt.border) {
        page.drawRectangle({
          x: X0, y: Y0, width: slotW, height: slotH,
          borderColor: PDFLib.rgb(0.82, 0.85, 0.89), borderWidth: 0.6,
        });
      }
      if (it.blank) continue;

      const g = itemGeom(it);
      const src = state.sources.get(it.srcId);
      const srcPage = src.lib.getPage(it.index);
      const emb = await out.embedPage(srcPage, {
        left: g.sx, bottom: g.sy, right: g.sx + g.cw, top: g.sy + g.ch,
      });

      const d = dispSize(g.rot, g.cw, g.ch);
      const sc = Math.min(slotW / d.w, slotH / d.h);
      const dW = d.w * sc, dH = d.h * sc;
      const X = X0 + (slotW - dW) / 2;
      const Y = Y0 + (slotH - dH) / 2;

      const a = rotAnchor(X, Y, dW, dH, g.rot);
      page.drawPage(emb, {
        x: a.x, y: a.y, width: a.w, height: a.h,
        rotate: degrees(a.rotate),
      });
    }
    onProgress && onProgress((s + 1) / sheets);
  }
}

/* ---------- 拆分逻辑 ---------- */

function parseRanges(text, total) {
  // "1-3,5,8-" -> [[0,2],[4,4],[7,total-1]]
  const parts = String(text).split(/[,，;；\s]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)?\s*[-~到]\s*(\d+)?$/);
    if (m) {
      let a = m[1] ? parseInt(m[1], 10) : 1;
      let b = m[2] ? parseInt(m[2], 10) : total;
      a = clamp(a, 1, total); b = clamp(b, 1, total);
      if (b < a) [a, b] = [b, a];
      out.push([a - 1, b - 1]);
    } else if (/^\d+$/.test(p)) {
      const v = clamp(parseInt(p, 10), 1, total);
      out.push([v - 1, v - 1]);
    }
  }
  return out;
}

function splitGroups(items, opt, baseName) {
  if (opt.split === 'none') return [{ name: baseName + '.pdf', items }];
  const groups = [];
  if (opt.split === 'each') {
    const n = opt.eachN;
    for (let i = 0, k = 1; i < items.length; i += n, k++) {
      groups.push({
        name: baseName + '_' + k + '.pdf',
        items: items.slice(i, i + n),
      });
    }
  } else {
    const ranges = parseRanges(opt.ranges, items.length);
    if (!ranges.length) throw new Error('页码范围格式不正确，例如 1-3,4-6');
    ranges.forEach(([a, b], i) => {
      groups.push({
        name: baseName + '_' + (i + 1) + '.pdf',
        items: items.slice(a, b + 1),
      });
    });
  }
  return groups;
}

async function doExport(onlySelected) {
  let items;
  if (onlySelected) {
    items = state.pages.filter(p => state.selected.has(p.id));
    if (!items.length) { toast('没有选中的页面'); return; }
  } else {
    items = scopeItems();
  }
  if (!items.length) { toast('没有可导出的页面'); return; }

  const opt = readExportOptions();
  const baseName = ($('expName').value || '整理结果').replace(/\.pdf$/i, '') || '整理结果';

  closeExportDialog();
  showBusy('正在生成 PDF…', 0);

  try {
    const groups = splitGroups(items, opt, baseName);
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      setBusyText('正在生成 ' + (groups.length > 1 ? '(' + (i + 1) + '/' + groups.length + ') ' : '') + '…');
      const bytes = await buildPdf(g.items, opt, p => setProgress((i + p) / groups.length));
      files.push({ name: g.name, bytes });
    }

    if (files.length === 1) {
      download(files[0].bytes, files[0].name);
      toast('已导出 ' + files[0].name + '（' + fmtSize(files[0].bytes.length) + '）', 'ok');
    } else {
      const zip = makeZip(files);
      download(zip, baseName + '.zip');
      toast('已导出 ' + files.length + ' 个文件（ZIP）', 'ok');
    }
  } catch (err) {
    console.error(err);
    toast(err.message || '导出失败', 'err');
  } finally {
    hideBusy();
  }
}

/* ---------- 极简 ZIP（store 模式，无压缩） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);         // version
    dv.setUint16(6, 0x0800, true);     // UTF-8 flag
    dv.setUint16(8, 0, true);          // store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  });

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach(c => { out.set(c, p); p += c.length; });
  central.forEach(c => { out.set(c, p); p += c.length; });
  out.set(end, p);
  return out;
}

/* ============================ 10. UI 绑定 ============================ */

function showBusy(text, p) {
  $('busyOverlay').hidden = false;
  setBusyText(text || '正在处理…');
  setProgress(p || 0);
}
function hideBusy() { $('busyOverlay').hidden = true; }
function setBusyText(t) { $('busyText').textContent = t; }
function setProgress(p) { $('busyBar').style.width = clamp(p * 100, 0, 100) + '%'; }

function openExportDialog() {
  if (!state.pages.length) { toast('还没有页面'); return; }
  const first = state.pages.find(p => !p.blank);
  const base = first ? state.sources.get(first.srcId).label : '整理结果';
  const sel = state.selected.size;
  $('expName').value = base + '-整理';
  $('expScope').value = sel ? 'selected' : 'all';
  $('expInfo').textContent = '共 ' + state.pages.length + ' 页，已选 ' + sel + ' 页';
  $('exportOverlay').hidden = false;
  setTimeout(() => $('expName').focus(), 30);
}

function closeExportDialog() { $('exportOverlay').hidden = true; }

function syncExportUI() {
  const nup = parseInt($('expNup').value, 10) || 1;
  $('nupOpts').hidden = nup <= 1;
  const sp = $('expSplit').value;
  $('splitEachRow').hidden = sp !== 'each';
  $('splitRangeRow').hidden = sp !== 'range';
  $('splitHint').hidden = sp === 'none';
}

function setupUI() {
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('btnOpen2').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);

  $('btnZoomIn').addEventListener('click', () => {
    state.zoom = Math.min(TILE_SIZES.length - 1, state.zoom + 1);
    markAllDirty();
    tiles.forEach(t => { t.key = ''; if (isVisible(t.el)) queueRender(t); });
  });
  $('btnZoomOut').addEventListener('click', () => {
    state.zoom = Math.max(0, state.zoom - 1);
    markAllDirty();
    tiles.forEach(t => { t.key = ''; if (isVisible(t.el)) queueRender(t); });
  });

  $('btnExport').addEventListener('click', openExportDialog);
  $('btnExtract').addEventListener('click', () => {
    const items = state.pages.filter(p => state.selected.has(p.id));
    if (!items.length) { toast('没有选中的页面'); return; }
    showBusy('正在生成…', 0);
    buildPdf(items, { nup: 1, paper: 'A4', gap: 0, border: false })
      .then(bytes => {
        const first = items.find(p => !p.blank);
        const base = first ? state.sources.get(first.srcId).label : '页面';
        download(bytes, base + '-选中页.pdf');
        toast('已导出 ' + items.length + ' 页', 'ok');
      })
      .catch(e => { console.error(e); toast(e.message || '导出失败', 'err'); })
      .finally(hideBusy);
  });

  // 页面操作按钮
  document.querySelector('.ops').addEventListener('click', e => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const op = btn.dataset.op;
    if (op === 'rotL') cmdRotate(-90);
    else if (op === 'rotR') cmdRotate(90);
    else if (op === 'del') cmdDelete();
    else if (op === 'dup') cmdDuplicate();
    else if (op === 'blank') cmdInsertBlank();
    else if (op === 'keep') cmdKeepSelected();
  });

  // 折叠卡片
  document.querySelectorAll('.collapsible .card-head').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  // 尺寸
  $('sizePreset').addEventListener('change', e => {
    $('sizeCustomRow').hidden = e.target.value !== 'custom';
  });
  $('btnApplySize').addEventListener('click', cmdApplySize);
  $('btnClearSize').addEventListener('click', cmdClearSize);

  // 裁剪
  $('btnApplyCrop').addEventListener('click', cmdApplyCrop);
  $('btnClearCrop').addEventListener('click', cmdClearCrop);
  document.querySelectorAll('.chip[data-crop]').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.crop;
      ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(id => { $(id).value = v; });
    });
  });

  // 导出对话框
  $('btnCloseExport').addEventListener('click', closeExportDialog);
  $('btnCancelExport').addEventListener('click', closeExportDialog);
  $('btnDoExport').addEventListener('click', () => doExport(false));
  $('expNup').addEventListener('change', syncExportUI);
  $('expSplit').addEventListener('change', syncExportUI);
  $('exportOverlay').addEventListener('mousedown', e => {
    if (e.target === $('exportOverlay')) closeExportDialog();
  });

  // 键盘
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      if (!$('exportOverlay').hidden) { closeExportDialog(); return; }
    }
    if (typing) return;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.selected = new Set(state.pages.map(p => p.id));
      refreshSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cmdDuplicate(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cmdDelete(); return; }
    if (e.key === '[') { cmdRotate(-90); return; }
    if (e.key === ']') { cmdRotate(90); return; }
  });
}

/* ============================ 11. 启动 ============================ */

function setupObserver() {
  const main = $('main');
  observer = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const item = state.pages.find(p => p.id === en.target.dataset.id);
      if (!item) return;
      const tile = tiles.get(item.id);
      if (tile) queueRender(tile);
    });
  }, { root: main, rootMargin: '400px 0px' });
}

function init() {
  if (location.protocol === 'file:') {
    const bar = document.createElement('div');
    bar.className = 'filebar';
    bar.innerHTML = '<b>提示：</b>当前是用浏览器直接打开的本地文件，缩略图渲染可能被浏览器安全策略拦截。请改用目录里的「启动PDF工具.bat」启动。';
    document.body.insertBefore(bar, document.body.firstChild.nextSibling);
  }
  setupObserver();
  setupGridDnD();
  setupUI();
  syncGrid();
  // 供调试/测试
  window.__app = { state, buildPdf, itemGeom, applyPageEdits, syncGrid, addFiles, makeZip, PDFLib };
}

document.addEventListener('DOMContentLoaded', init);

})();
