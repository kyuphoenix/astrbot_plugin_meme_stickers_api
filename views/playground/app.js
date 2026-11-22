// Meme Stickers Playground JS (API Edition)
// High-performance 60FPS Frontend Canvas 2D + Bundled/Cached Font Loading

const PLUGIN_NAME = "astrbot_plugin_meme_stickers_api";

class BridgeClient {
  constructor() {
    this.bridge = window.$astrbot || window.parent?.$astrbot || null;
  }

  async apiGet(endpoint, params = {}) {
    if (this.bridge && typeof this.bridge.apiGet === "function") {
      return await this.bridge.apiGet(endpoint, params);
    }
    const cleanEp = endpoint.replace(/^\/+/, "");
    const q = new URLSearchParams(params).toString();
    const url = `/api/plug/${PLUGIN_NAME}/${cleanEp}${q ? "?" + q : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      let errDetail = res.statusText;
      try {
        const j = await res.json();
        errDetail = j.message || j.error || j.detail || JSON.stringify(j);
      } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${errDetail}`);
    }
    const json = await res.json();
    return json.data !== undefined ? json.data : json;
  }

  async apiPost(endpoint, body = {}) {
    if (this.bridge && typeof this.bridge.apiPost === "function") {
      return await this.bridge.apiPost(endpoint, body);
    }
    const cleanEp = endpoint.replace(/^\/+/, "");
    const url = `/api/plug/${PLUGIN_NAME}/${cleanEp}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errDetail = res.statusText;
      try {
        const j = await res.json();
        errDetail = j.message || j.error || j.detail || JSON.stringify(j);
      } catch (_) {
        try {
          errDetail = await res.text();
        } catch (_) {}
      }
      throw new Error(`HTTP ${res.status}: ${errDetail}`);
    }
    const json = await res.json();
    return json.data !== undefined ? json.data : json;
  }
}

const client = new BridgeClient();

// State
let globalPacksTree = {};
let currentSelectedSticker = null;
let currentBaseImage = null;
let currentGeneratedImageUri = null;
let fontLoaded = false;
let renderScheduled = false;

// Image and Canvas Caches
const clientImageCache = new Map();
let offscreenCanvas = null;
let offscreenCtx = null;
function getOffscreenCanvas(w, h) {
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
  } else {
    offscreenCtx.clearRect(0, 0, w, h);
  }
  return { offscreenCanvas, offCtx: offscreenCtx };
}

// DOM Elements
const elements = {
  backendStatusBadge: document.getElementById("backend-status-badge"),
  packSelect: document.getElementById("pack-select"),
  categorySelect: document.getElementById("category-select"),
  stickerSelect: document.getElementById("sticker-select"),
  textInput: document.getElementById("text-input"),
  fontSizeRange: document.getElementById("font-size-range"),
  fontSizeVal: document.getElementById("font-size-val"),
  textAlignSelect: document.getElementById("text-align-select"),
  textColorPicker: document.getElementById("text-color-picker"),
  textColorHex: document.getElementById("text-color-hex"),
  strokeColorPicker: document.getElementById("stroke-color-picker"),
  strokeColorHex: document.getElementById("stroke-color-hex"),
  textXInput: document.getElementById("text-x-input"),
  textYInput: document.getElementById("text-y-input"),
  rotateRange: document.getElementById("rotate-range"),
  rotateVal: document.getElementById("rotate-val"),
  strokeWidthRange: document.getElementById("stroke-width-range"),
  strokeWidthVal: document.getElementById("stroke-width-val"),
  fontStyleSelect: document.getElementById("font-style-select"),
  imageFormatSelect: document.getElementById("image-format-select"),
  autoResizeCheck: document.getElementById("auto-resize-check"),
  livePreviewCheck: document.getElementById("live-preview-check"),
  btnGenerateApi: document.getElementById("btn-generate-api"),
  btnDownload: document.getElementById("btn-download"),
  btnCopy: document.getElementById("btn-copy"),
  previewContainer: document.getElementById("preview-container"),
  previewImage: document.getElementById("preview-image"),
  previewCanvas: document.getElementById("preview-canvas"),
  previewPlaceholder: document.getElementById("preview-placeholder"),
  previewLoading: document.getElementById("preview-loading"),
  badgeEngine: document.getElementById("badge-engine"),
  badgeDuration: document.getElementById("badge-duration"),
  metaTagsBox: document.getElementById("meta-tags-box"),
  badgePack: document.getElementById("badge-pack"),
  badgeSize: document.getElementById("badge-size"),
  badgeFilesize: document.getElementById("badge-filesize"),
};

// Color helpers
function rgbaToHex(rgba) {
  if (typeof rgba === "string") return rgba;
  if (!Array.isArray(rgba)) return "#000000";
  const [r, g, b] = rgba;
  return "#" + [r, g, b].map(x => Math.round(x || 0).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function hexToRgba(hex) {
  let c = hex.replace("#", "").trim();
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  const num = parseInt(c.slice(0, 6), 16);
  const a = c.length >= 8 ? parseInt(c.slice(6, 8), 16) : 255;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255, a];
}

function calcRotatedAABB(box, origin, deg) {
  const rad = (deg * Math.PI) / 180;
  const [bx, by, bw, bh] = box;
  const corners = [
    { x: bx, y: by },
    { x: bx + bw, y: by },
    { x: bx + bw, y: by + bh },
    { x: bx, y: by + bh },
  ];
  const rotated = corners.map(pt => {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = pt.x - origin.x;
    const dy = pt.y - origin.y;
    return {
      x: origin.x + dx * cos - dy * sin,
      y: origin.y + dx * sin + dy * cos,
    };
  });
  const xs = rotated.map(p => p.x);
  const ys = rotated.map(p => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

// -------------------------------------------------------------
// Font Loading: CacheStorage + Local Plugin File + CDN Fallback
// -------------------------------------------------------------
const FONT_NAME = "YurukaFangTang";

async function initWebFont() {
  if (document.fonts && document.fonts.check(`16px "${FONT_NAME}"`)) {
    fontLoaded = true;
    return;
  }

  const CACHE_NAME = "meme-stickers-fonts-v1";
  const CACHE_KEY = "/fonts/YurukaFangTang.ttf";
  let fontBuffer = null;

  // 1. Check browser CacheStorage (0ms instant across sessions)
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(CACHE_NAME);
      const cachedResp = await cache.match(CACHE_KEY);
      if (cachedResp && cachedResp.ok) {
        fontBuffer = await cachedResp.arrayBuffer();
        console.log(`[Font] Loaded ${FONT_NAME}.ttf from CacheStorage (0ms)`);
      }
    }
  } catch (err) {
    console.warn("[Font] CacheStorage check error:", err);
  }

  // 2. Fetch directly from AstrBot plugin local font endpoint (bundled in plugin, 100% reliable)
  if (!fontBuffer) {
    const localUrls = [
      `/api/plug/${PLUGIN_NAME}/font/file`,
      `/api/plug/${PLUGIN_NAME}/font/primary`,
    ];
    for (const url of localUrls) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          if (url.endsWith("/primary")) {
            const j = await resp.json();
            const b64 = (j.data?.data_uri || j.data_uri || "").split(",")[1];
            if (b64) {
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              fontBuffer = bytes.buffer;
              break;
            }
          } else {
            const buf = await resp.arrayBuffer();
            if (buf && buf.byteLength > 100000) {
              fontBuffer = buf;
              break;
            }
          }
        }
      } catch (e) {
        console.warn(`[Font] Failed to fetch local font from ${url}:`, e);
      }
    }
  }

  // 3. Fallback: jsDelivr CDN and GitHub mirrors
  if (!fontBuffer) {
    const cdnUrls = [
      "https://cdn.jsdelivr.net/gh/kyuphoenix/pjsk-stickers-server@main/fonts/YurukaFangTang.ttf",
      "https://ghfast.top/https://raw.githubusercontent.com/kyuphoenix/pjsk-stickers-server/main/fonts/YurukaFangTang.ttf",
      "https://raw.githubusercontent.com/kyuphoenix/pjsk-stickers-server/main/fonts/YurukaFangTang.ttf",
    ];
    for (const url of cdnUrls) {
      try {
        const resp = await fetch(url, { mode: "cors" });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          if (buf && buf.byteLength > 100000) {
            fontBuffer = buf;
            break;
          }
        }
      } catch (e) {}
    }
  }

  // 4. Register FontFace with browser
  if (fontBuffer) {
    try {
      const fontFace = new FontFace(FONT_NAME, fontBuffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      fontLoaded = true;
      console.log(`[Font] "${FONT_NAME}" successfully registered!`);

      // Save to CacheStorage for next visit
      if (typeof caches !== "undefined") {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(CACHE_KEY, new Response(fontBuffer.slice(0), {
            headers: { "Content-Type": "font/ttf" }
          }));
        } catch (_) {}
      }

      requestRender();
    } catch (err) {
      console.error("[Font] FontFace load error:", err);
    }
  }
}

// -------------------------------------------------------------
// Image Preloader: CDN + Cache + Local API Fallback
// -------------------------------------------------------------
async function loadClientImage(cdnUrl, packSlug, baseImageRel) {
  const cacheKey = cdnUrl || `${packSlug}/${baseImageRel}`;
  if (!cacheKey) return null;
  if (clientImageCache.has(cacheKey)) {
    return clientImageCache.get(cacheKey);
  }

  const urlsToTry = [];
  if (cdnUrl) {
    urlsToTry.push(cdnUrl);
    if (cdnUrl.includes("raw.githubusercontent.com")) {
      urlsToTry.push(cdnUrl.replace("raw.githubusercontent.com/lgc-NB2Dev/meme-stickers-hub/main", "cdn.jsdelivr.net/gh/lgc-NB2Dev/meme-stickers-hub@main"));
      urlsToTry.push(`https://ghfast.top/${cdnUrl}`);
    } else if (cdnUrl.includes("cdn.jsdelivr.net")) {
      urlsToTry.push(cdnUrl.replace("cdn.jsdelivr.net/gh/lgc-NB2Dev/meme-stickers-hub@main", "raw.githubusercontent.com/lgc-NB2Dev/meme-stickers-hub/main"));
      urlsToTry.push(`https://ghfast.top/https://raw.githubusercontent.com/lgc-NB2Dev/meme-stickers-hub/main/${packSlug}/${baseImageRel}`);
    }
  }
  if (packSlug && baseImageRel) {
    urlsToTry.push(`/api/plug/${PLUGIN_NAME}/sticker_image?pack=${encodeURIComponent(packSlug)}&file=${encodeURIComponent(baseImageRel)}`);
  }

  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= urlsToTry.length) {
        resolve(null);
        return;
      }
      const url = urlsToTry[index++];
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        clientImageCache.set(cacheKey, img);
        resolve(img);
      };
      img.onerror = () => tryNext();
      img.src = url;
    };
    tryNext();
  });
}

// -------------------------------------------------------------
// Pure Frontend 60FPS Canvas 2D Renderer
// -------------------------------------------------------------
function fillInnerCounters(ctx, w, h, strokeRgba) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qHead = 0, qTail = 0;

  for (let x = 0; x < w; x++) {
    if (data[x * 4 + 3] === 0) {
      visited[x] = 1;
      queue[qTail++] = x;
    }
    const b = (h - 1) * w + x;
    if (data[b * 4 + 3] === 0 && !visited[b]) {
      visited[b] = 1;
      queue[qTail++] = b;
    }
  }
  for (let y = 0; y < h; y++) {
    const l = y * w;
    if (data[l * 4 + 3] === 0 && !visited[l]) {
      visited[l] = 1;
      queue[qTail++] = l;
    }
    const r = y * w + (w - 1);
    if (data[r * 4 + 3] === 0 && !visited[r]) {
      visited[r] = 1;
      queue[qTail++] = r;
    }
  }

  while (qHead < qTail) {
    const curr = queue[qHead++];
    const cx = curr % w;
    const cy = (curr / w) | 0;

    if (cx > 0) {
      const idx = curr - 1;
      if (!visited[idx] && data[idx * 4 + 3] === 0) {
        visited[idx] = 1;
        queue[qTail++] = idx;
      }
    }
    if (cx < w - 1) {
      const idx = curr + 1;
      if (!visited[idx] && data[idx * 4 + 3] === 0) {
        visited[idx] = 1;
        queue[qTail++] = idx;
      }
    }
    if (cy > 0) {
      const idx = curr - w;
      if (!visited[idx] && data[idx * 4 + 3] === 0) {
        visited[idx] = 1;
        queue[qTail++] = idx;
      }
    }
    if (cy < h - 1) {
      const idx = curr + w;
      if (!visited[idx] && data[idx * 4 + 3] === 0) {
        visited[idx] = 1;
        queue[qTail++] = idx;
      }
    }
  }

  const [sr, sg, sb, sa = 255] = strokeRgba;
  for (let i = 0; i < w * h; i++) {
    if (!visited[i]) {
      const alpha = data[i * 4 + 3];
      if (alpha < 255) {
        const topAlpha = alpha / 255;
        const botAlpha = (sa / 255) * (1 - topAlpha);
        const outAlpha = topAlpha + botAlpha;
        if (outAlpha > 0) {
          data[i * 4] = Math.round((data[i * 4] * topAlpha + sr * botAlpha) / outAlpha);
          data[i * 4 + 1] = Math.round((data[i * 4 + 1] * topAlpha + sg * botAlpha) / outAlpha);
          data[i * 4 + 2] = Math.round((data[i * 4 + 2] * topAlpha + sb * botAlpha) / outAlpha);
          data[i * 4 + 3] = Math.round(outAlpha * 255);
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function renderCanvas() {
  renderScheduled = false;
  if (!currentBaseImage) return;

  const t0 = performance.now();
  const width = currentSelectedSticker?.width || 296;
  const height = currentSelectedSticker?.height || 256;

  elements.previewCanvas.style.display = "block";
  elements.previewImage.style.display = "none";
  elements.previewPlaceholder.style.display = "none";

  const canvas = elements.previewCanvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.clearRect(0, 0, width, height);

  // 1. Draw character base image (Contain)
  const iw = currentBaseImage.naturalWidth || currentBaseImage.width;
  const ih = currentBaseImage.naturalHeight || currentBaseImage.height;
  const ratio = Math.min(width / iw, height / ih);
  const rw = iw * ratio;
  const rh = ih * ratio;
  const ox = (width - rw) / 2;
  const oy = (height - rh) / 2;
  ctx.drawImage(currentBaseImage, ox, oy, rw, rh);

  const text = elements.textInput.value;
  if (!text) {
    const t1 = performance.now();
    updatePreviewMeta(width, height, (t1 - t0).toFixed(1), "前端 Canvas 2D (0ms)");
    return;
  }

  // 2. Measure & layout
  let curFontSize = parseFloat(elements.fontSizeRange.value) || 48;
  const strokeWidthFactor = parseFloat(elements.strokeWidthRange.value) || 0.22;
  const rotateDeg = parseFloat(elements.rotateRange.value) || 0;
  const textAlign = elements.textAlignSelect.value || "center";
  const autoResize = elements.autoResizeCheck.checked;

  let lines = text.split("\n");
  const fontFamilies = `"${FONT_NAME}", "Segoe UI Emoji", "Noto Color Emoji", -apple-system, sans-serif`;

  if (autoResize) {
    for (let iter = 0; iter < 15 && curFontSize > 12; iter++) {
      ctx.font = `${curFontSize}px ${fontFamilies}`;
      const lineMetrics = lines.map(line => {
        const m = ctx.measureText(line);
        const ascent = m.actualBoundingBoxAscent || curFontSize * 0.8;
        const descent = m.actualBoundingBoxDescent || curFontSize * 0.2;
        return { w: m.width, h: ascent + descent, ascent, descent };
      });
      const maxLineW = Math.max(...lineMetrics.map(m => m.w), 1);
      const totalH = lineMetrics.reduce((acc, m) => acc + m.h, 0);

      const strokeW = curFontSize * strokeWidthFactor;
      const pad = strokeW * 2 + 10;
      const offW = Math.ceil(maxLineW + pad * 2);
      const offH = Math.ceil(totalH + pad * 2);
      const cx = offW / 2;
      const cy = offH / 2;

      let drawOffsetX = -cx;
      if (textAlign === "left") drawOffsetX = -pad;
      else if (textAlign === "right") drawOffsetX = -offW + pad;

      const curX = elements.textXInput.value !== "" ? parseFloat(elements.textXInput.value) : (currentSelectedSticker?.text_x ?? 148);
      const curY = elements.textYInput.value !== "" ? parseFloat(elements.textYInput.value) : (currentSelectedSticker?.text_y ?? 58);

      const aabb = calcRotatedAABB(
        [curX + drawOffsetX, curY - cy, offW, offH],
        { x: curX, y: curY },
        rotateDeg
      );

      const overflowX = aabb.minX < 0 || aabb.maxX > width;
      const overflowY = aabb.minY < 0 || aabb.maxY > height;
      if (overflowX || overflowY) {
        curFontSize = Math.floor(curFontSize * 0.92);
      } else {
        break;
      }
    }
  }

  // 3. Render onto offscreen canvas
  ctx.font = `${curFontSize}px ${fontFamilies}`;
  const strokeW = curFontSize * strokeWidthFactor;
  const lineMetrics = lines.map(line => {
    const m = ctx.measureText(line);
    const ascent = m.actualBoundingBoxAscent || curFontSize * 0.8;
    const descent = m.actualBoundingBoxDescent || curFontSize * 0.2;
    return { w: m.width, h: ascent + descent, ascent, descent };
  });
  const maxLineW = Math.max(...lineMetrics.map(m => m.w), 1);
  const totalH = lineMetrics.reduce((acc, m) => acc + m.h, 0);

  const pad = strokeW * 2 + 16;
  const offW = Math.ceil(maxLineW + pad * 2);
  const offH = Math.ceil(totalH + pad * 2);
  const cx = offW / 2;
  const cy = offH / 2;

  const { offCtx } = getOffscreenCanvas(offW, offH);
  offCtx.font = `${curFontSize}px ${fontFamilies}`;
  offCtx.textBaseline = "middle";
  offCtx.textAlign = "center";

  let startY = cy - totalH / 2;
  const textColorHex = elements.textColorHex.value || "#1a1a1a";
  const strokeColorHex = elements.strokeColorHex.value || "#ffffff";

  // Stroke pass
  if (strokeW > 0) {
    offCtx.strokeStyle = strokeColorHex;
    offCtx.lineWidth = strokeW * 2;
    offCtx.lineJoin = "round";
    offCtx.lineCap = "round";
    let curY = startY;
    for (let i = 0; i < lines.length; i++) {
      const lineH = lineMetrics[i].h;
      offCtx.strokeText(lines[i], cx, curY + lineH / 2);
      curY += lineH;
    }
    // Fill interior holes
    fillInnerCounters(offCtx, offW, offH, hexToRgba(strokeColorHex));
  }

  // Fill pass
  offCtx.fillStyle = textColorHex;
  let curY = startY;
  for (let i = 0; i < lines.length; i++) {
    const lineH = lineMetrics[i].h;
    offCtx.fillText(lines[i], cx, curY + lineH / 2);
    curY += lineH;
  }

  // 4. Composite offscreen text layer onto main canvas
  ctx.save();
  const curX = elements.textXInput.value !== "" ? parseFloat(elements.textXInput.value) : (currentSelectedSticker?.text_x ?? 148);
  const textY = elements.textYInput.value !== "" ? parseFloat(elements.textYInput.value) : (currentSelectedSticker?.text_y ?? 58);

  ctx.translate(curX, textY);
  if (Math.abs(rotateDeg) > 0.01) {
    ctx.rotate((rotateDeg * Math.PI) / 180);
  }

  let drawOffsetX = -cx;
  if (textAlign === "left") drawOffsetX = -pad;
  else if (textAlign === "right") drawOffsetX = -offW + pad;

  ctx.drawImage(offscreenCanvas, drawOffsetX, -cy);
  ctx.restore();

  const t1 = performance.now();
  updatePreviewMeta(width, height, (t1 - t0).toFixed(1), "前端 Canvas 2D (0ms)");
}

function requestRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => renderCanvas());
}

function updatePreviewMeta(width, height, durationMs, engineText) {
  elements.badgeEngine.innerHTML = `<span style="color: #38bdf8; font-weight: 600;">${engineText}</span>`;
  elements.badgeDuration.textContent = `${durationMs}ms`;

  elements.metaTagsBox.style.display = "flex";
  elements.badgePack.textContent = elements.packSelect.selectedOptions[0]?.textContent || "";
  elements.badgeSize.textContent = `${width} × ${height}`;
  elements.badgeFilesize.textContent = currentSelectedSticker?.name || "";

  elements.btnCopy.disabled = false;
  elements.btnDownload.disabled = false;
}

// -------------------------------------------------------------
// UI Event Bindings
// -------------------------------------------------------------
// Color Pickers
elements.textColorPicker.addEventListener("input", (e) => {
  elements.textColorHex.value = e.target.value;
  requestRender();
});
elements.textColorHex.addEventListener("input", (e) => {
  elements.textColorPicker.value = e.target.value;
  requestRender();
});
elements.strokeColorPicker.addEventListener("input", (e) => {
  elements.strokeColorHex.value = e.target.value;
  requestRender();
});
elements.strokeColorHex.addEventListener("input", (e) => {
  elements.strokeColorPicker.value = e.target.value;
  requestRender();
});

// Range Inputs
elements.fontSizeRange.addEventListener("input", (e) => {
  elements.fontSizeVal.textContent = `${e.target.value}px`;
  requestRender();
});
elements.strokeWidthRange.addEventListener("input", (e) => {
  elements.strokeWidthVal.textContent = e.target.value;
  requestRender();
});
elements.rotateRange.addEventListener("input", (e) => {
  elements.rotateVal.textContent = `${e.target.value}°`;
  requestRender();
});

elements.textXInput.addEventListener("input", () => requestRender());
elements.textYInput.addEventListener("input", () => requestRender());
elements.textAlignSelect.addEventListener("change", () => requestRender());
elements.autoResizeCheck.addEventListener("change", () => requestRender());
elements.livePreviewCheck.addEventListener("change", () => requestRender());

// Text input
elements.textInput.addEventListener("input", () => {
  if (elements.livePreviewCheck.checked) {
    requestRender();
  }
});
elements.textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    elements.btnGenerateApi.click();
  }
});

// Pack Select
elements.packSelect.addEventListener("change", () => {
  const slug = elements.packSelect.value;
  if (!slug || !globalPacksTree[slug]) return;

  const pack = globalPacksTree[slug];
  const categories = Object.keys(pack.categories || {});

  elements.categorySelect.innerHTML = "";
  elements.categorySelect.disabled = categories.length === 0;

  categories.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = `${cat} (${pack.categories[cat].length})`;
    elements.categorySelect.appendChild(opt);
  });

  elements.categorySelect.dispatchEvent(new Event("change"));
});

// Category Select
elements.categorySelect.addEventListener("change", () => {
  const slug = elements.packSelect.value;
  const cat = elements.categorySelect.value;
  if (!slug || !cat || !globalPacksTree[slug]) return;

  const stickers = globalPacksTree[slug].categories[cat] || [];
  elements.stickerSelect.innerHTML = "";
  elements.stickerSelect.disabled = stickers.length === 0;

  stickers.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    elements.stickerSelect.appendChild(opt);
  });

  elements.stickerSelect.dispatchEvent(new Event("change"));
});

// Sticker Select
elements.stickerSelect.addEventListener("change", async () => {
  const slug = elements.packSelect.value;
  const cat = elements.categorySelect.value;
  const name = elements.stickerSelect.value;
  if (!slug || !cat || !name || !globalPacksTree[slug]) return;

  const stickers = globalPacksTree[slug].categories[cat] || [];
  const sticker = stickers.find(s => s.name === name);
  if (!sticker) return;

  currentSelectedSticker = sticker;

  // Apply default parameters
  elements.textInput.value = sticker.text || "";
  elements.fontSizeRange.value = sticker.font_size || 42;
  elements.fontSizeVal.textContent = `${sticker.font_size || 42}px`;
  elements.strokeWidthRange.value = sticker.stroke_width_factor || 0.22;
  elements.strokeWidthVal.textContent = sticker.stroke_width_factor || 0.22;
  elements.rotateRange.value = sticker.text_rotate_degrees || 0;
  elements.rotateVal.textContent = `${sticker.text_rotate_degrees || 0}°`;
  elements.textXInput.value = sticker.text_x !== undefined ? sticker.text_x : "";
  elements.textYInput.value = sticker.text_y !== undefined ? sticker.text_y : "";
  elements.textAlignSelect.value = sticker.text_align || "center";

  const fgHex = rgbaToHex(sticker.text_color || [0, 0, 0, 255]);
  const bgHex = rgbaToHex(sticker.stroke_color || [255, 255, 255, 255]);
  elements.textColorPicker.value = fgHex.slice(0, 7);
  elements.textColorHex.value = fgHex;
  elements.strokeColorPicker.value = bgHex.slice(0, 7);
  elements.strokeColorHex.value = bgHex;

  // Preload base image
  currentBaseImage = await loadClientImage(sticker.cdn_url, slug, sticker.base_image);
  requestRender();
});

// Call Server API Generate
elements.btnGenerateApi.addEventListener("click", async () => {
  if (!currentSelectedSticker) return;

  elements.previewLoading.style.display = "flex";
  elements.btnGenerateApi.disabled = true;

  const payload = {
    pack_slug: elements.packSelect.value,
    sticker_name: currentSelectedSticker.name,
    text: elements.textInput.value,
    font_size: parseFloat(elements.fontSizeRange.value),
    stroke_width_factor: parseFloat(elements.strokeWidthRange.value),
    text_rotate_degrees: parseFloat(elements.rotateRange.value),
    text_align: elements.textAlignSelect.value,
    text_color: hexToRgba(elements.textColorHex.value),
    stroke_color: hexToRgba(elements.strokeColorHex.value),
    image_format: elements.imageFormatSelect.value,
    auto_resize: elements.autoResizeCheck.checked,
  };
  if (elements.textXInput.value !== "") payload.text_x = parseFloat(elements.textXInput.value);
  if (elements.textYInput.value !== "") payload.text_y = parseFloat(elements.textYInput.value);

  const t0 = performance.now();
  try {
    const res = await client.apiPost("generate", payload);
    const t1 = performance.now();

    if (res && res.data_uri) {
      currentGeneratedImageUri = res.data_uri;
      elements.previewImage.src = res.data_uri;
      elements.previewImage.style.display = "block";
      elements.previewCanvas.style.display = "none";
      updatePreviewMeta(res.width || 296, res.height || 256, (t1 - t0).toFixed(0), "渲染服务 API");
    }
  } catch (err) {
    alert(`生成失败: ${err.message}`);
  } finally {
    elements.previewLoading.style.display = "none";
    elements.btnGenerateApi.disabled = false;
  }
});

// Download
elements.btnDownload.addEventListener("click", () => {
  const isCanvas = elements.previewCanvas.style.display !== "none";
  const format = elements.imageFormatSelect.value || "png";
  const filename = `meme_${currentSelectedSticker?.name || "sticker"}_${Date.now()}.${format}`;
  const a = document.createElement("a");
  a.download = filename;

  if (isCanvas) {
    a.href = elements.previewCanvas.toDataURL(`image/${format}`);
    a.click();
  } else if (elements.previewImage.src) {
    a.href = elements.previewImage.src;
    a.click();
  }
});

// Copy to Clipboard
elements.btnCopy.addEventListener("click", async () => {
  const isCanvas = elements.previewCanvas.style.display !== "none";
  try {
    let blob = null;
    if (isCanvas) {
      blob = await new Promise(resolve => elements.previewCanvas.toBlob(resolve, "image/png"));
    } else if (elements.previewImage.src) {
      const resp = await fetch(elements.previewImage.src);
      blob = await resp.blob();
    }
    if (blob) {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      const prev = elements.btnCopy.innerHTML;
      elements.btnCopy.innerHTML = "<span>✅ 已复制到剪贴板</span>";
      setTimeout(() => { elements.btnCopy.innerHTML = prev; }, 1800);
    }
  } catch (err) {
    alert(`复制失败: ${err.message}`);
  }
});

// Load Packs Tree
async function loadPacksDetail() {
  try {
    const data = await client.apiGet("packs");
    globalPacksTree = data || {};

    const slugs = Object.keys(globalPacksTree);
    elements.packSelect.innerHTML = "";

    if (slugs.length === 0) {
      elements.packSelect.innerHTML = '<option value="">暂无可用贴纸包，请检查服务端连接</option>';
      return;
    }

    slugs.forEach((slug) => {
      const p = globalPacksTree[slug];
      const opt = document.createElement("option");
      opt.value = slug;
      opt.textContent = `${p.name || slug} (${slug})`;
      elements.packSelect.appendChild(opt);
    });

    elements.packSelect.dispatchEvent(new Event("change"));
  } catch (err) {
    console.error("加载贴纸包失败:", err);
  }
}

// Load Server Status
async function loadStatus() {
  try {
    const res = await client.apiGet("status");
    if (res.backend_online) {
      elements.backendStatusBadge.className = "badge badge-success";
      elements.backendStatusBadge.textContent = `🟢 渲染服务在线 (${res.backend_latency_ms || 0}ms)`;
    } else {
      elements.backendStatusBadge.className = "badge badge-warning";
      elements.backendStatusBadge.textContent = `🔴 渲染服务未连接 (${res.server_url || ""})`;
    }
  } catch (err) {
    elements.backendStatusBadge.className = "badge badge-warning";
    elements.backendStatusBadge.textContent = "🔴 渲染服务异常";
  }
}

// Init
async function init() {
  await loadStatus();
  await loadPacksDetail();
  initWebFont();
}

window.addEventListener("DOMContentLoaded", init);
