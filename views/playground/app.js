// Arc/PJSK Meme Stickers Playground (API Edition)
// Replicating Server-Side Frontend UI + AstrBot Bridge Adapter + 60FPS Canvas 2D Rendering

const PLUGIN_NAME = "astrbot_plugin_meme_stickers_api";

// -------------------------------------------------------------
// AstrBot View Bridge Adapter
// -------------------------------------------------------------
class BridgeClient {
  constructor() {
    this.bridge = window.AstrBotPluginView || window.AstrBotPluginPage || window.parent?.AstrBotPluginView || window.parent?.AstrBotPluginPage || null;
  }

  async init() {
    if (this.bridge && typeof this.bridge.ready === "function") {
      try {
        await this.bridge.ready();
        console.log("[Bridge] AstrBot Bridge initialized successfully.");
      } catch (err) {
        console.warn("[Bridge] Bridge ready warning:", err);
      }
    }
  }

  async apiGet(endpoint, params = {}) {
    if (this.bridge && typeof this.bridge.apiGet === "function") {
      const res = await this.bridge.apiGet(endpoint, params);
      return (res && res.data !== undefined) ? res.data : res;
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
    return (json && json.data !== undefined) ? json.data : json;
  }

  async apiPost(endpoint, body = {}) {
    if (this.bridge && typeof this.bridge.apiPost === "function") {
      const res = await this.bridge.apiPost(endpoint, body);
      return (res && res.data !== undefined) ? res.data : res;
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
        try { errDetail = await res.text(); } catch (_) {}
      }
      throw new Error(`HTTP ${res.status}: ${errDetail}`);
    }
    const json = await res.json();
    return (json && json.data !== undefined) ? json.data : json;
  }
}

const client = new BridgeClient();

// -------------------------------------------------------------
// Global State
// -------------------------------------------------------------
let globalPacks = {};
let currentSelectedSticker = null;
let currentBaseImage = null;
let rafId = null;
let serverDebounceTimer = null;
let reqSeq = 0;
let fontLoaded = false;
let serverUrl = "http://localhost:3000";
const clientImageCache = new Map();

// Reusable offscreen canvas to avoid GC pauses during 60FPS slider dragging
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
  return { offscreenCanvas, offCtx: offscreenCtx, offscreenCtx };
}

// -------------------------------------------------------------
// DOM References
// -------------------------------------------------------------
const dom = {
  packSelect: document.getElementById("pack-select"),
  categorySelect: document.getElementById("category-select"),
  stickerSelect: document.getElementById("sticker-select"),
  textInput: document.getElementById("text-input"),
  fontSize: document.getElementById("font-size"),
  fontSizeVal: document.getElementById("font-size-val"),
  rotateDeg: document.getElementById("rotate-deg"),
  rotateDegVal: document.getElementById("rotate-deg-val"),
  strokeWidth: document.getElementById("stroke-width"),
  strokeWidthVal: document.getElementById("stroke-width-val"),
  textAlign: document.getElementById("text-align"),
  textColor: document.getElementById("text-color"),
  textColorHex: document.getElementById("text-color-hex"),
  strokeColor: document.getElementById("stroke-color"),
  strokeColorHex: document.getElementById("stroke-color-hex"),
  textX: document.getElementById("text-x"),
  textY: document.getElementById("text-y"),
  imageFormat: document.getElementById("image-format"),
  autoResize: document.getElementById("auto-resize"),
  clientRenderToggle: document.getElementById("client-render-toggle"),
  livePreviewToggle: document.getElementById("live-preview-toggle"),
  previewCanvas: document.getElementById("preview-canvas"),
  previewImg: document.getElementById("preview-img"),
  previewMeta: document.getElementById("preview-meta"),
  loadingSpinner: document.getElementById("loading-spinner"),
  btnCopy: document.getElementById("btn-copy"),
  btnDownload: document.getElementById("btn-download"),
  btnTestApi: document.getElementById("btn-test-api"),
  btnResetParams: document.getElementById("btn-reset-params"),
  btnCopyUrl: document.getElementById("btn-copy-url"),
  apiGetUrl: document.getElementById("api-get-url"),
  apiMdCode: document.getElementById("api-md-code"),
  apiPostCurl: document.getElementById("api-post-curl"),
  backendStatusBadge: document.getElementById("backend-status-badge"),
};

// -------------------------------------------------------------
// Navigation Tabs
// -------------------------------------------------------------
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    const tabId = btn.dataset.tab;
    const target = document.getElementById(`tab-${tabId}`);
    if (target) target.classList.add("active");
  });
});

// Copy helper
window.copyText = function(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  let text = el.innerText.trim();
  if (elementId === "api-get-url") {
    text = text.replace(/^GET\s+/i, "");
  }
  navigator.clipboard.writeText(text).then(() => {
    alert("已复制到剪贴板！");
  }).catch(() => {
    if (typeof prompt !== "undefined") {
      prompt("请手动复制：", text);
    } else {
      alert("复制失败，请手动选中文本复制。");
    }
  });
};

// -------------------------------------------------------------
// Geometry and Color Helpers
// -------------------------------------------------------------
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

function rotatePoint(px, py, ox, oy, rad) {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - ox;
  const dy = py - oy;
  return {
    x: ox + dx * cos - dy * sin,
    y: oy + dx * sin + dy * cos,
  };
}

function calcRotatedAABB(box, origin, deg) {
  const rad = (deg * Math.PI) / 180;
  const [bx, by, bw, bh] = box;
  const corners = [
    rotatePoint(bx, by, origin.x, origin.y, rad),
    rotatePoint(bx + bw, by, origin.x, origin.y, rad),
    rotatePoint(bx + bw, by + bh, origin.x, origin.y, rad),
    rotatePoint(bx, by + bh, origin.x, origin.y, rad),
  ];
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function getResizeContain(srcW, srcH, dstW, dstH) {
  const ratio = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * ratio;
  const h = srcH * ratio;
  const x = (dstW - w) / 2;
  const y = (dstH - h) / 2;
  return { ratio, w, h, x, y };
}

// Fill enclosed inner loops/counters (e.g. inside 'o', 'g', 'e', 'a') to prevent background leakage
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
      const a = data[i * 4 + 3];
      if (a === 0) {
        data[i * 4] = sr;
        data[i * 4 + 1] = sg;
        data[i * 4 + 2] = sb;
        data[i * 4 + 3] = sa;
      } else if (a < 255) {
        const topAlpha = a / 255;
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

// -------------------------------------------------------------
// Client Image Loader with Cache and Fallback
// -------------------------------------------------------------
async function loadClientImage(cdnUrl, packSlug, baseImageRel) {
  const cacheKey = cdnUrl || `${packSlug}:${baseImageRel}`;
  if (!cacheKey) return null;
  if (clientImageCache.has(cacheKey)) {
    return clientImageCache.get(cacheKey);
  }

  const urlsToTry = [];
  if (cdnUrl) urlsToTry.push(cdnUrl);
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
      const u = urlsToTry[index++];
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        clientImageCache.set(cacheKey, img);
        resolve(img);
      };
      img.onerror = () => tryNext();
      img.src = u;
    };
    tryNext();
  });
}

// -------------------------------------------------------------
// Web Font Loader (CacheStorage -> CDN Prioritized -> Server Fallback)
// -------------------------------------------------------------
const FONT_NAME = "YurukaFangTang";

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

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
        console.log(`[Font] Loaded ${FONT_NAME}.ttf from browser CacheStorage (0ms)`);
      }
    }
  } catch (err) {
    console.warn("[Font] CacheStorage check error:", err);
  }

  // 2. Fetch from CDN prioritized (saves host/server bandwidth)
  if (!fontBuffer) {
    const cdnUrls = [
      "https://cdn.jsdelivr.net/gh/kyuphoenix/astrbot_plugin_meme_stickers_api@main/fonts/YurukaFangTang.ttf",
      "https://cdn.jsdelivr.net/gh/kyuphoenix/pjsk-stickers-server@main/fonts/YurukaFangTang.ttf",
      "https://raw.githubusercontent.com/kyuphoenix/astrbot_plugin_meme_stickers_api/main/fonts/YurukaFangTang.ttf",
      "https://raw.githubusercontent.com/kyuphoenix/pjsk-stickers-server/main/fonts/YurukaFangTang.ttf",
    ];
    for (const url of cdnUrls) {
      try {
        console.log(`[Font] 优先尝试 CDN 加载字体: ${url}`);
        const resp = await fetchWithTimeout(url, { mode: "cors" }, 4500);
        if (resp && resp.ok) {
          const buf = await resp.arrayBuffer();
          if (buf && buf.byteLength > 100000) {
            fontBuffer = buf;
            console.log(`[Font] CDN 字体加载成功! 大小: ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
            break;
          }
        }
      } catch (e) {
        console.warn(`[Font] CDN 拉取失败 (${e.message || e}), 尝试下一源...`);
      }
    }
  }

  // 3. Fallback: Fetch from server (AstrBot local plugin or backend server) if CDN fails
  if (!fontBuffer) {
    console.log("[Font] 所有 CDN 加载失败或超时，回退从服务器拉取字体...");
    const serverUrls = [
      `/api/plug/${PLUGIN_NAME}/font/file`,
      ...(serverUrl ? [`${serverUrl}/fonts/YurukaFangTang.ttf`] : []),
      `/api/plug/${PLUGIN_NAME}/font/primary`,
    ];
    for (const url of serverUrls) {
      try {
        console.log(`[Font] 尝试从服务器拉取: ${url}`);
        const resp = await fetchWithTimeout(url, {}, 8000);
        if (resp && resp.ok) {
          if (url.endsWith("/primary")) {
            const j = await resp.json();
            const b64 = (j.data?.data_uri || j.data_uri || "").split(",")[1];
            if (b64) {
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              fontBuffer = bytes.buffer;
              console.log("[Font] 服务器 Base64 字体加载成功!");
              break;
            }
          } else {
            const buf = await resp.arrayBuffer();
            if (buf && buf.byteLength > 100000) {
              fontBuffer = buf;
              console.log(`[Font] 服务器二进制字体拉取成功! 大小: ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
              break;
            }
          }
        }
      } catch (e) {
        console.warn(`[Font] 从服务器拉取失败 (${url}):`, e);
      }
    }
  }

  // 4. Register FontFace with browser & save to CacheStorage
  if (fontBuffer) {
    try {
      const fontFace = new FontFace(FONT_NAME, fontBuffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      fontLoaded = true;
      console.log(`[Font] "${FONT_NAME}" 成功注册到浏览器字体库!`);

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
      console.error("[Font] FontFace 注册失败:", err);
    }
  }
}

// -------------------------------------------------------------
// Load Packs & Status
// -------------------------------------------------------------
async function initPacks() {
  try {
    const data = await client.apiGet("packs");
    globalPacks = (data && typeof data === "object") ? (data.data || data) : {};

    const slugs = Object.keys(globalPacks).filter(k => k !== "status" && k !== "data");
    dom.packSelect.innerHTML = "";

    if (slugs.length === 0) {
      dom.packSelect.innerHTML = '<option value="">暂无可用贴纸包，请检查服务端连接</option>';
      return;
    }

    for (const slug of slugs) {
      const pack = globalPacks[slug];
      const opt = document.createElement("option");
      opt.value = slug;
      opt.textContent = pack.name || slug;
      dom.packSelect.appendChild(opt);
    }

    onPackChanged();
  } catch (err) {
    console.error("加载贴纸包失败:", err);
    dom.packSelect.innerHTML = `<option value="">加载失败: ${err.message || err}</option>`;
  }
}

function onPackChanged() {
  const slug = dom.packSelect.value;
  const pack = globalPacks[slug];
  if (!pack || !pack.categories) {
    dom.categorySelect.innerHTML = '<option value="">无可用分类</option>';
    dom.categorySelect.disabled = true;
    dom.stickerSelect.innerHTML = '<option value="">无可用贴纸</option>';
    dom.stickerSelect.disabled = true;
    return;
  }

  dom.categorySelect.innerHTML = "";
  dom.categorySelect.disabled = false;
  for (const cat of Object.keys(pack.categories)) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    dom.categorySelect.appendChild(opt);
  }

  onCategoryChanged();
}

function onCategoryChanged() {
  const slug = dom.packSelect.value;
  const cat = dom.categorySelect.value;
  const pack = globalPacks[slug];
  const stickers = pack?.categories?.[cat] || [];

  dom.stickerSelect.innerHTML = "";
  dom.stickerSelect.disabled = stickers.length === 0;
  for (const s of stickers) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    dom.stickerSelect.appendChild(opt);
  }

  onStickerChanged();
}

async function onStickerChanged() {
  const slug = dom.packSelect.value;
  const cat = dom.categorySelect.value;
  const sName = dom.stickerSelect.value;
  const pack = globalPacks[slug];
  const stickers = pack?.categories?.[cat] || [];
  const sticker = stickers.find(s => s.name === sName);

  if (!sticker) return;
  currentSelectedSticker = sticker;

  // Apply defaults
  dom.fontSize.value = sticker.font_size || 42;
  dom.fontSizeVal.textContent = `${dom.fontSize.value}px`;
  dom.rotateDeg.value = Math.round(sticker.text_rotate_degrees || 0);
  dom.rotateDegVal.textContent = `${dom.rotateDeg.value}°`;
  dom.strokeWidth.value = sticker.stroke_width_factor || 0.22;
  dom.strokeWidthVal.textContent = dom.strokeWidth.value;
  dom.textAlign.value = sticker.text_align || "center";
  dom.textX.value = sticker.text_x || 148;
  dom.textY.value = sticker.text_y || 58;

  const textHex = rgbaToHex(sticker.text_color);
  dom.textColor.value = textHex;
  dom.textColorHex.value = textHex;

  const strokeHex = rgbaToHex(sticker.stroke_color);
  dom.strokeColor.value = strokeHex;
  dom.strokeColorHex.value = strokeHex;

  updateApiDocs();
  requestRender();

  // Load and cache base image
  const imgUrl = sticker.cdn_url || sticker.base_image;
  loadClientImage(imgUrl, slug, sticker.base_image).then(img => {
    currentBaseImage = img;
    requestRender();
  });
}

// -------------------------------------------------------------
// Server Status Check
// -------------------------------------------------------------
async function loadStatus() {
  try {
    const res = await client.apiGet("status");
    if (res && res.server_url) {
      serverUrl = res.server_url;
    }
    if (res && res.backend_online) {
      dom.backendStatusBadge.className = "badge badge-success";
      dom.backendStatusBadge.textContent = `🟢 渲染服务在线 (${res.backend_latency_ms || 0}ms)`;
    } else {
      dom.backendStatusBadge.className = "badge badge-warning";
      dom.backendStatusBadge.textContent = `🔴 渲染服务未连接 (${res?.server_url || "离线"})`;
    }
  } catch (err) {
    console.error("检测服务状态失败:", err);
    dom.backendStatusBadge.className = "badge badge-warning";
    dom.backendStatusBadge.textContent = `🔴 服务状态异常 (${err.message || "请求失败"})`;
  }
}

// -------------------------------------------------------------
// API Docs Generator
// -------------------------------------------------------------
let currentApiGetUrl = "";

function updateApiDocs() {
  const host = serverUrl || window.location.origin;
  const pack = dom.packSelect.value;
  const sticker = dom.stickerSelect.value;
  const text = dom.textInput.value || "something";
  const stickerObj = currentSelectedSticker;

  const params = new URLSearchParams();
  params.set("pack", pack);
  params.set("sticker", sticker);
  params.set("text", text);

  const curColorHex = (dom.textColorHex.value || dom.textColor.value || "").trim();
  const defaultColorHex = stickerObj ? rgbaToHex(stickerObj.text_color) : "";
  if (curColorHex && defaultColorHex && curColorHex.toUpperCase() !== defaultColorHex.toUpperCase()) {
    params.set("color", curColorHex);
  }

  const curStrokeHex = (dom.strokeColorHex.value || dom.strokeColor.value || "").trim();
  const defaultStrokeHex = stickerObj ? rgbaToHex(stickerObj.stroke_color) : "#FFFFFF";
  if (curStrokeHex && defaultStrokeHex && curStrokeHex.toUpperCase() !== defaultStrokeHex.toUpperCase()) {
    params.set("stroke", curStrokeHex);
  }

  const curFontSize = Number(dom.fontSize.value);
  const defaultFontSize = Number(stickerObj?.font_size ?? 42);
  if (curFontSize && curFontSize !== defaultFontSize) {
    params.set("size", curFontSize);
  }

  const curRotate = Number(dom.rotateDeg.value);
  const defaultRotate = Math.round(Number(stickerObj?.text_rotate_degrees ?? 0));
  if (curRotate !== defaultRotate) {
    params.set("rotate", curRotate);
  }

  const curStrokeWidth = Number(dom.strokeWidth.value);
  const defaultStrokeWidth = Number(stickerObj?.stroke_width_factor ?? 0.22);
  if (curStrokeWidth && Math.abs(curStrokeWidth - defaultStrokeWidth) > 0.005) {
    params.set("stroke_width", curStrokeWidth);
  }

  const curAlign = dom.textAlign.value || "center";
  const defaultAlign = stickerObj?.text_align || "center";
  if (curAlign !== defaultAlign) {
    params.set("align", curAlign);
  }

  const curX = Number(dom.textX.value);
  const defaultX = Number(stickerObj?.text_x ?? 148);
  if (curX && curX !== defaultX) {
    params.set("x", curX);
  }

  const curY = Number(dom.textY.value);
  const defaultY = Number(stickerObj?.text_y ?? 58);
  if (curY && curY !== defaultY) {
    params.set("y", curY);
  }

  if (!dom.autoResize.checked) {
    params.set("auto_resize", "false");
  }

  const curFormat = dom.imageFormat.value || "png";
  if (curFormat !== "png") {
    params.set("format", curFormat);
  }

  currentApiGetUrl = `${host}/api/generate?${params.toString()}`;
  if (dom.apiGetUrl) dom.apiGetUrl.textContent = `GET ${currentApiGetUrl}`;
  if (dom.apiMdCode) dom.apiMdCode.textContent = `![${sticker}](${currentApiGetUrl})`;

  if (dom.apiPostCurl) {
    dom.apiPostCurl.textContent = `curl -X POST ${host}/api/generate \\
  -H "Content-Type: application/json" \\
  -d '{
    "pack_slug": "${pack}",
    "sticker_name": "${sticker}",
    "text": "${text.replace(/'/g, "\\'")}",
    "font_size": ${curFontSize},
    "text_x": ${curX},
    "text_y": ${curY},
    "text_rotate_degrees": ${curRotate},
    "text_color": [${hexToRgba(curColorHex).join(", ")}],
    "stroke_color": [${hexToRgba(curStrokeHex).join(", ")}],
    "stroke_width_factor": ${curStrokeWidth},
    "auto_resize": ${dom.autoResize.checked},
    "image_format": "${curFormat}"
  }'`;
  }
}

// -------------------------------------------------------------
// 60FPS Real-Time Rendering & Server API Testing
// -------------------------------------------------------------
function requestRender() {
  if (!dom.livePreviewToggle.checked) return;

  if (dom.clientRenderToggle.checked) {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      renderClientCanvasSync();
    });
  } else {
    clearTimeout(serverDebounceTimer);
    serverDebounceTimer = setTimeout(doServerRender, 150);
  }
}

// 1. Pure Frontend Canvas 2D Synchronous Rendering (0ms)
function renderClientCanvasSync() {
  const t0 = performance.now();
  dom.previewCanvas.style.display = "block";
  dom.previewImg.style.display = "none";

  const canvas = dom.previewCanvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const width = currentSelectedSticker?.width || 296;
  const height = currentSelectedSticker?.height || 256;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.clearRect(0, 0, width, height);

  // 1. Draw base image
  if (currentBaseImage) {
    const fit = getResizeContain(currentBaseImage.width, currentBaseImage.height, width, height);
    ctx.drawImage(currentBaseImage, fit.x, fit.y, fit.w, fit.h);
  } else {
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, width, height);
  }

  const text = dom.textInput.value;
  if (!text) {
    const t1 = performance.now();
    updatePreviewMeta(width, height, (t1 - t0).toFixed(1), "前端 Canvas 2D (0ms 实时)");
    return;
  }

  // 2. Measure & layout
  let curFontSize = Number(dom.fontSize.value) || 42;
  const strokeWidthFactor = Number(dom.strokeWidth.value) || 0.22;
  const rotateDeg = Number(dom.rotateDeg.value) || 0;
  const textAlign = dom.textAlign.value || "center";
  const famStr = 'YurukaFangTang, "Noto Color Emoji", sans-serif';

  let curX = Number(dom.textX.value) || 148;
  let curY = Number(dom.textY.value) || 58;

  const getMetrics = (sz) => {
    ctx.font = `${Math.round(sz)}px ${famStr}`;
    ctx.textAlign = textAlign;
    ctx.textBaseline = "middle";
    const m = ctx.measureText(text);
    const tw = m.width;
    const th = (m.actualBoundingBoxAscent || sz * 0.8) + (m.actualBoundingBoxDescent || sz * 0.2);
    const strokeW = sz * strokeWidthFactor;
    const boxW = tw + strokeW * 2;
    const boxH = th + strokeW * 2;
    let boxX = curX - tw / 2 - strokeW;
    if (textAlign === "left") boxX = curX - strokeW;
    else if (textAlign === "right") boxX = curX - tw - strokeW;
    const boxY = curY - th / 2 - strokeW;
    return { tw, th, strokeW, box: [boxX, boxY, boxW, boxH] };
  };

  let metrics = getMetrics(curFontSize);

  // 3. Auto resize if needed
  if (dom.autoResize.checked) {
    let aabb = calcRotatedAABB(metrics.box, { x: curX, y: curY }, rotateDeg);
    if (aabb.width > width || aabb.height > height) {
      const ratio = Math.min(width / aabb.width, height / aabb.height);
      curFontSize = Math.max(12, Math.floor(curFontSize * ratio * 0.95));
      metrics = getMetrics(curFontSize);
      aabb = calcRotatedAABB(metrics.box, { x: curX, y: curY }, rotateDeg);
    }

    if (aabb.minX < 0) curX += -aabb.minX + 4;
    else if (aabb.maxX > width) curX -= (aabb.maxX - width + 4);
    if (aabb.minY < 0) curY += -aabb.minY + 4;
    else if (aabb.maxY > height) curY -= (aabb.maxY - height + 4);
  }

  // 4. Render text onto reusable offscreen canvas with counter fill
  const strokeW = metrics.strokeW;
  const pad = Math.ceil(strokeW * 2 + 30);
  const offW = Math.ceil(metrics.tw + pad * 2);
  const offH = Math.ceil(metrics.th + pad * 2);

  const { offCtx } = getOffscreenCanvas(offW, offH);

  offCtx.font = `${Math.round(curFontSize)}px ${famStr}`;
  offCtx.textAlign = "center";
  offCtx.textBaseline = "middle";

  const cx = offW / 2;
  const cy = offH / 2;

  // Stroke pass
  if (strokeW > 0) {
    offCtx.strokeStyle = dom.strokeColor.value || dom.strokeColorHex.value || "#FFFFFF";
    offCtx.lineWidth = strokeW * 2;
    offCtx.lineJoin = "round";
    offCtx.lineCap = "round";
    offCtx.strokeText(text, cx, cy);
  }

  // Fill pass
  offCtx.fillStyle = dom.textColor.value || dom.textColorHex.value || "#000000";
  offCtx.fillText(text, cx, cy);

  // Fill inner counter loops (o, g, e, a, etc.)
  if (strokeW > 0) {
    try {
      const strokeRgba = hexToRgba(dom.strokeColor.value || dom.strokeColorHex.value || "#FFFFFF");
      fillInnerCounters(offCtx, offW, offH, strokeRgba);
    } catch (e) {
      console.warn("Counter fill non-critical notice:", e);
    }
  }

  // Draw rotated onto main target canvas
  ctx.save();
  ctx.translate(curX, curY);
  ctx.rotate((rotateDeg * Math.PI) / 180);

  let drawOffsetX = -cx;
  if (textAlign === "left") drawOffsetX = -pad;
  else if (textAlign === "right") drawOffsetX = -offW + pad;

  ctx.drawImage(offscreenCanvas, drawOffsetX, -cy);
  ctx.restore();

  const t1 = performance.now();
  updatePreviewMeta(width, height, (t1 - t0).toFixed(1), "前端 Canvas 2D (0ms 实时)");
}

// 2. Server API Rendering (for testing Node.js backend)
async function doServerRender() {
  const thisSeq = ++reqSeq;
  dom.loadingSpinner.classList.remove("hidden");
  const t0 = performance.now();

  const payload = {
    pack_slug: dom.packSelect.value,
    sticker_name: dom.stickerSelect.value,
    base_image_url: currentSelectedSticker?.cdn_url || currentSelectedSticker?.base_image || null,
    text: dom.textInput.value,
    font_size: Number(dom.fontSize.value),
    text_x: Number(dom.textX.value),
    text_y: Number(dom.textY.value),
    text_rotate_degrees: Number(dom.rotateDeg.value),
    stroke_width_factor: Number(dom.strokeWidth.value),
    text_align: dom.textAlign.value,
    text_color: hexToRgba(dom.textColorHex.value),
    stroke_color: hexToRgba(dom.strokeColorHex.value),
    auto_resize: dom.autoResize.checked,
    image_format: dom.imageFormat.value,
  };

  try {
    const res = await client.apiPost("generate", payload);
    if (thisSeq !== reqSeq) return;

    const dataUri = res?.data_uri || res?.data?.data_uri;
    if (dataUri) {
      dom.previewCanvas.style.display = "none";
      dom.previewImg.style.display = "block";
      dom.previewImg.src = dataUri;

      const t1 = performance.now();
      updatePreviewMeta(res.width || 296, res.height || 256, (t1 - t0).toFixed(0), "Node.js API");
    }
  } catch (err) {
    console.error("Server render error:", err);
    alert(`后端生成失败: ${err.message}`);
  } finally {
    if (thisSeq === reqSeq) {
      dom.loadingSpinner.classList.add("hidden");
    }
  }
}

function updatePreviewMeta(w, h, timeMs, engine) {
  dom.previewMeta.textContent = `尺寸: ${w} × ${h} px · 引擎: ${engine} · 耗时: ${timeMs}ms · 格式: ${dom.imageFormat.value.toUpperCase()}`;
}

// Get Image Blob on Demand
function getCurrentImageBlob() {
  return new Promise((resolve) => {
    if (dom.previewCanvas.style.display !== "none") {
      dom.previewCanvas.toBlob(resolve, "image/png");
    } else if (dom.previewImg.src) {
      fetch(dom.previewImg.src).then(r => r.blob()).then(resolve).catch(() => resolve(null));
    } else {
      resolve(null);
    }
  });
}

// -------------------------------------------------------------
// Event Bindings
// -------------------------------------------------------------
dom.packSelect.addEventListener("change", onPackChanged);
dom.categorySelect.addEventListener("change", onCategoryChanged);
dom.stickerSelect.addEventListener("change", onStickerChanged);

dom.fontSize.addEventListener("input", e => {
  dom.fontSizeVal.textContent = `${e.target.value}px`;
  requestRender();
  updateApiDocs();
});
dom.fontSize.addEventListener("change", updateApiDocs);

dom.rotateDeg.addEventListener("input", e => {
  dom.rotateDegVal.textContent = `${e.target.value}°`;
  requestRender();
  updateApiDocs();
});
dom.rotateDeg.addEventListener("change", updateApiDocs);

dom.strokeWidth.addEventListener("input", e => {
  dom.strokeWidthVal.textContent = e.target.value;
  requestRender();
  updateApiDocs();
});
dom.strokeWidth.addEventListener("change", updateApiDocs);

dom.textInput.addEventListener("input", () => {
  updateApiDocs();
  requestRender();
});

dom.textAlign.addEventListener("change", () => {
  updateApiDocs();
  requestRender();
});

dom.textX.addEventListener("input", () => {
  requestRender();
  updateApiDocs();
});
dom.textX.addEventListener("change", updateApiDocs);

dom.textY.addEventListener("input", () => {
  requestRender();
  updateApiDocs();
});
dom.textY.addEventListener("change", updateApiDocs);

dom.autoResize.addEventListener("change", () => {
  updateApiDocs();
  requestRender();
});

dom.imageFormat.addEventListener("change", () => {
  updateApiDocs();
  requestRender();
});

dom.textColor.addEventListener("input", e => {
  dom.textColorHex.value = e.target.value;
  requestRender();
  updateApiDocs();
});
dom.textColor.addEventListener("change", updateApiDocs);

dom.textColorHex.addEventListener("input", e => {
  dom.textColor.value = e.target.value;
  requestRender();
  updateApiDocs();
});
dom.textColorHex.addEventListener("change", updateApiDocs);

dom.strokeColor.addEventListener("input", e => {
  dom.strokeColorHex.value = e.target.value;
  requestRender();
  updateApiDocs();
});
dom.strokeColor.addEventListener("change", updateApiDocs);

dom.strokeColorHex.addEventListener("input", e => {
  dom.strokeColor.value = e.target.value;
  requestRender();
  updateApiDocs();
});
dom.strokeColorHex.addEventListener("change", updateApiDocs);

dom.clientRenderToggle.addEventListener("change", () => {
  requestRender();
});

// Test API Button
dom.btnTestApi.addEventListener("click", () => {
  doServerRender();
});

// Copy Image Button
dom.btnCopy.addEventListener("click", async () => {
  dom.btnCopy.disabled = true;
  try {
    const blob = await getCurrentImageBlob();
    if (!blob) {
      alert("暂无可用图片");
      return;
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    const prev = dom.btnCopy.textContent;
    dom.btnCopy.textContent = "✅ 已复制到剪贴板！";
    setTimeout(() => { dom.btnCopy.textContent = prev; }, 2000);
  } catch (err) {
    console.warn("Clipboard write error:", err);
    alert("浏览器剪贴板权限受限或非HTTPS环境，请右键图片直接复制。");
  } finally {
    dom.btnCopy.disabled = false;
  }
});

// Download Image Button
dom.btnDownload.addEventListener("click", async () => {
  const isCanvas = dom.previewCanvas.style.display !== "none";
  if (isCanvas) {
    const url = dom.previewCanvas.toDataURL(`image/${dom.imageFormat.value}`);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sticker_${dom.stickerSelect.value || "meme"}.${dom.imageFormat.value}`;
    a.click();
  } else if (dom.previewImg.src) {
    const a = document.createElement("a");
    a.href = dom.previewImg.src;
    a.download = `sticker_${dom.stickerSelect.value || "meme"}.${dom.imageFormat.value}`;
    a.click();
  }
});

// Copy Direct API URL
dom.btnCopyUrl.addEventListener("click", async () => {
  if (!currentApiGetUrl) {
    updateApiDocs();
  }
  const cleanUrl = currentApiGetUrl || dom.apiGetUrl.innerText.replace(/^GET\s+/i, "").trim();
  try {
    await navigator.clipboard.writeText(cleanUrl);
    const prev = dom.btnCopyUrl.textContent;
    dom.btnCopyUrl.textContent = "✅ 已复制直链 URL！";
    setTimeout(() => { dom.btnCopyUrl.textContent = prev; }, 2000);
  } catch (err) {
    if (typeof prompt !== "undefined") {
      prompt("请手动复制直链 URL：", cleanUrl);
    }
  }
});

// Reset parameters button
if (dom.btnResetParams) {
  dom.btnResetParams.addEventListener("click", () => {
    if (!currentSelectedSticker) return;
    const sticker = currentSelectedSticker;

    dom.fontSize.value = sticker.font_size || 42;
    dom.fontSizeVal.textContent = `${dom.fontSize.value}px`;
    dom.rotateDeg.value = Math.round(sticker.text_rotate_degrees || 0);
    dom.rotateDegVal.textContent = `${dom.rotateDeg.value}°`;
    dom.strokeWidth.value = sticker.stroke_width_factor !== undefined ? sticker.stroke_width_factor : 0.22;
    dom.strokeWidthVal.textContent = dom.strokeWidth.value;
    dom.textAlign.value = sticker.text_align || "center";
    dom.textX.value = sticker.text_x !== undefined ? sticker.text_x : 148;
    dom.textY.value = sticker.text_y !== undefined ? sticker.text_y : 58;

    const textHex = rgbaToHex(sticker.text_color || [0, 0, 0, 255]);
    dom.textColor.value = textHex;
    dom.textColorHex.value = textHex;

    const strokeHex = rgbaToHex(sticker.stroke_color || [255, 255, 255, 255]);
    dom.strokeColor.value = strokeHex;
    dom.strokeColorHex.value = strokeHex;

    dom.imageFormat.value = "png";
    dom.autoResize.checked = true;

    updateApiDocs();
    requestRender();

    const originalText = dom.btnResetParams.textContent;
    dom.btnResetParams.textContent = "✅ 已重置参数！";
    setTimeout(() => { dom.btnResetParams.textContent = originalText; }, 1500);
  });
}

// -------------------------------------------------------------
// Bootstrap Lifecycle
// -------------------------------------------------------------
async function bootstrap() {
  console.log("[Playground] Bootstrapping replicated UI...");
  await client.init();
  initWebFont();
  await Promise.allSettled([loadStatus(), initPacks()]);
  console.log("[Playground] Ready!");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
