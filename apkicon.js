'use strict';
/**
 * apkicon.js — 从电视上的 APK 里提取「启动器图标」（launcher icon）
 *
 * 为什么需要自己解析：
 *   · APK 里的 AndroidManifest.xml / resources.arsc 都是二进制格式，设备上没有 aapt；
 *   · 很多 APK 的资源名被混淆（res/9w.png 这种），靠文件名猜图标会大量猜错；
 *   · 正确路径：AXML 清单里 <application android:icon> 拿到资源 ID →
 *     ARSC 资源表把 ID 解析成文件路径 → unzip -p 取出图片字节。
 *
 * 用法（CLI 测试）：
 *   node apkicon.js <包名> [输出目录]      # 提取单个
 *   node apkicon.js --all [输出目录]       # 提取 /tmp/pkgs.txt 里所有包
 *
 * 用法（模块）：
 *   const { extractIcon } = require('./apkicon');
 *   const r = await extractIcon('com.cibn.tv', { adb: 'adb', serial: '192.168.1.50:5555' });
 *   // r = { ok: true, data: Buffer, ext: 'png'|'webp'|'jpg', w, h, path } 或 { ok: false, why }
 */
const { spawn } = require('child_process');

const ANDROID_URI = 'http://schemas.android.com/apk/res/android';
const MAX_ICON = 512 * 1024;      // 图标超过 512KB 基本是取错了

/* ================= adb ================= */
function adbRun(adb, serial, args, timeout = 15000) {
  return new Promise((resolve) => {
    const full = serial ? ['-s', serial].concat(args) : args.slice();
    const so = [], se = [];
    let done = false, timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ err, stdout: Buffer.concat(so), stderr: Buffer.concat(se) });
    };
    let child;
    try {
      child = spawn(adb, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish(e); }
    timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish(new Error('timeout ' + timeout));
    }, timeout);
    child.stdout.on('data', (d) => so.push(d));
    child.stderr.on('data', (d) => se.push(d));
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(null));
  });
}

/* ================= 二进制解析 ================= */

/** 字符串池（UTF-8 / UTF-16 都支持）。锚点：chunkStart + stringsStart + offset[i] */
function parseStringPool(b, off) {
  if (off + 28 > b.length) return null;
  if (b.readUInt16LE(off) !== 0x0001) return null;
  const size = b.readUInt32LE(off + 4);
  const stringCount = b.readUInt32LE(off + 8);
  const flags = b.readUInt32LE(off + 16);
  const stringsStart = b.readUInt32LE(off + 20);
  if (stringCount > 200000) return null;
  const utf8 = (flags & 0x100) !== 0;
  const data = off + stringsStart;
  const strings = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) {
    const so = b.readUInt32LE(off + 28 + i * 4);
    const p = data + so;
    if (p < 0 || p + 2 > b.length) { strings[i] = ''; continue; }
    try {
      if (utf8) {
        // aapt2 的 UTF-8 串是「双长度前缀」：[u8 UTF-16长度][u8 UTF-8长度][数据][0x00]
        // （ASCII 时两个长度相等，容易看错；中文串两字节不同，如 04 0c = 4 字 / 12 字节）
        // 老 aapt1 是单前缀 [u8 长度][数据][0x00]。用结尾的 0x00 自动判别，两种都兼容。
        let q = p;
        let len16 = b[q++];
        if (len16 & 0x80) len16 = ((len16 & 0x7f) << 8) | b[q++];
        let len8 = b[q++];
        if (len8 & 0x80) len8 = ((len8 & 0x7f) << 8) | b[q++];
        if (q + len8 <= b.length && b[q + len8] === 0) {
          strings[i] = b.subarray(q, q + len8).toString('utf8');
        } else {
          let len = b[p]; let r = p + 1;
          if (len & 0x80) len = ((len & 0x7f) << 8) | b[r++];
          strings[i] = b.subarray(r, r + len).toString('utf8');
        }
      } else {
        let len = b.readUInt16LE(p), q = p + 2;
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(q); q += 2; }
        let s = '';
        const end = q + len * 2;
        for (; q + 1 < end && q + 1 < b.length; q += 2) s += String.fromCharCode(b.readUInt16LE(q));
        strings[i] = s;
      }
    } catch (e) { strings[i] = ''; }
  }
  return { strings, end: off + size, utf8, count: stringCount };
}

/** AXML（二进制 XML）：返回根元素 { name, attrs:[{name,nsUri,rawValue,dataType,data}], children:[…] } */
function parseAXML(buf) {
  if (!buf || buf.length < 12 || buf.readUInt16LE(0) !== 0x0003) return null;
  let off = 8;
  let pool = null;
  const stack = [];
  let root = null;
  let guard = 0;
  while (off + 8 <= buf.length && guard++ < 20000) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (type === 0x0001) {
      if (!pool) pool = parseStringPool(buf, off);
    } else if (type === 0x0102) {           // start tag
      const nameIdx = buf.readInt32LE(off + 20);
      const attrStart = buf.readUInt16LE(off + 24);
      const attrSize = buf.readUInt16LE(off + 26) || 20;
      const attrCount = buf.readUInt16LE(off + 28);
      const el = { name: pool ? (pool.strings[nameIdx] || '') : '', attrs: [], children: [] };
      const base = off + 16 + attrStart;
      for (let i = 0; i < attrCount; i++) {
        const a = base + i * attrSize;
        if (a + 20 > buf.length) break;
        const ans = buf.readInt32LE(a);
        const aname = buf.readInt32LE(a + 4);
        const araw = buf.readInt32LE(a + 8);
        el.attrs.push({
          name: pool ? (pool.strings[aname] || '') : '',
          nsUri: ans >= 0 && pool ? (pool.strings[ans] || '') : '',
          rawValue: araw >= 0 && pool ? (pool.strings[araw] || '') : '',
          dataType: buf[a + 15],
          data: buf.readUInt32LE(a + 16),
        });
      }
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (!root) root = el;
      stack.push(el);
    } else if (type === 0x0103) {           // end tag
      stack.pop();
    }
    off += size;
  }
  return root;
}

function parseTypeChunk(buf, c) {
  const typeId = buf[c + 8];
  const entryCount = buf.readUInt32LE(c + 12);
  const entryStart = buf.readUInt32LE(c + 16);
  const hs = buf.readUInt16LE(c + 2);
  const cfg = c + 20;
  const density = hs >= 34 ? buf.readUInt16LE(cfg + 14) : 0;   // config.density
  const lang = hs >= 30 ? buf.subarray(cfg + 8, cfg + 10).toString('latin1').replace(/\0/g, '') : '';
  const country = hs >= 32 ? buf.subarray(cfg + 10, cfg + 12).toString('latin1').replace(/\0/g, '') : '';
  const locale = lang ? lang + (country ? '-' + country : '') : '';
  const entriesTable = c + hs;
  const entries = new Map();
  if (entryCount > 65535) return null;
  for (let i = 0; i < entryCount; i++) {
    const eo = buf.readUInt32LE(entriesTable + i * 4);
    if (eo === 0xffffffff || eo > 0x00ffffff) continue;
    const ep = c + entryStart + eo;
    if (ep + 16 > buf.length) continue;
    const flags = buf.readUInt16LE(ep + 2);
    if (flags & 0x0001) continue;                          // complex entry，图标用不到
    // 简单条目固定 16 字节：size(2) flags(2) key(4) value{size(2) res0(1) dataType(1) data(4)}
    entries.set(i, {
      keyIdx: buf.readUInt32LE(ep + 4),
      dataType: buf[ep + 11],
      data: buf.readUInt32LE(ep + 12),
    });
  }
  return { typeId, entries, density, locale };
}

/** ARSC 资源表：resolve(resId) → 文件路径字符串（如 res/9w.png） */
function parseARSC(buf) {
  if (!buf || buf.length < 12 || buf.readUInt16LE(0) !== 0x0002) return null;
  const pkgCount = buf.readUInt32LE(8);
  let off = 12;
  const pools = [];      // { off, pool } 按文件顺序
  const packages = [];
  let guard = 0;
  while (off + 8 <= buf.length && guard++ < 500) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (type === 0x0001) {
      const pool = parseStringPool(buf, off);
      if (pool) pools.push({ off, pool });
      off += size;
    } else if (type === 0x0200) {
      const pkg = parseARSCPackage(buf, off, size);
      pkg.off = off;
      packages.push(pkg);
      off += size;
    } else break;
  }
  if (!packages.length) return null;
  // 每个包的 value 字符串池：优先取「紧邻包前面」的那个池（aapt2 布局），
  // 否则用包内尾部的池（aapt1 布局）
  const pkgInfo = packages.map((p) => {
    let vp = null;
    for (let i = pools.length - 1; i >= 0; i--) {
      if (pools[i].off < p.off) { vp = pools[i].pool; break; }
    }
    return { pkg: p, valuePool: vp || p.trailingPool };
  });
  return {
    packages,
    /** 同一资源 ID 的所有文件路径变体（locale 可选：优先中文；密度从高到低） */
    resolveAll(resId, locale) {
      const pkgId = (resId >>> 24) & 0xff;
      const typeId = (resId >>> 16) & 0xff;
      const entryId = resId & 0xffff;
      let hit = pkgInfo.find((x) => x.pkg.id === pkgId) || pkgInfo[0];
      if (!hit || !hit.valuePool) return [];
      const chunks = hit.pkg.types.filter((t) => t.typeId === typeId && t.entries.has(entryId));
      if (!chunks.length) return [];
      chunks.sort((a, b) => {
        if (locale) {
          const sa = localeScore(a.locale, locale), sb = localeScore(b.locale, locale);
          if (sa !== sb) return sb - sa;
        }
        return (b.density || 0) - (a.density || 0);   // 图标优先高密度
      });
      const out = [];
      for (const ch of chunks) {
        const e = ch.entries.get(entryId);
        if (e.dataType === 0x03) {                                  // TYPE_STRING → 文件路径
          const s = hit.valuePool.strings[e.data];
          if (s && out.indexOf(s) < 0) out.push(s);
        }
      }
      return out;
    },
    resolve(resId, locale) {
      const a = this.resolveAll(resId, locale);
      return a.length ? a[0] : null;
    },
    /** 资源 ID 的原始值变体 [{dataType, data}]（颜色等用） */
    values(resId) {
      const pkgId = (resId >>> 24) & 0xff;
      const typeId = (resId >>> 16) & 0xff;
      const entryId = resId & 0xffff;
      const hit = pkgInfo.find((x) => x.pkg.id === pkgId) || pkgInfo[0];
      if (!hit) return [];
      const chunks = hit.pkg.types.filter((t) => t.typeId === typeId && t.entries.has(entryId));
      chunks.sort((a, b) => (b.density || 0) - (a.density || 0));
      const out = [];
      for (const ch of chunks) {
        const e = ch.entries.get(entryId);
        if (e) out.push({ dataType: e.dataType, data: e.data });
      }
      return out;
    },
  };
}

function parseARSCPackage(buf, p, size) {
  const id = buf.readUInt32LE(p + 8);
  let name = '';
  for (let i = 0; i < 128; i++) {
    const ch = buf.readUInt16LE(p + 12 + i * 2);
    if (!ch) break;
    name += String.fromCharCode(ch);
  }
  const tsOff = buf.readUInt32LE(p + 268);
  const ksOff = buf.readUInt32LE(p + 276);
  const typePool = parseStringPool(buf, p + tsOff);
  const keyPool = parseStringPool(buf, p + ksOff);
  const types = [];
  let trailingPool = null;
  let o = p + buf.readUInt16LE(p + 2);
  const end = p + size;
  let guard = 0;
  while (o + 8 <= end && guard++ < 5000) {
    const t = buf.readUInt16LE(o);
    const sz = buf.readUInt32LE(o + 4);
    if (sz < 8 || o + sz > end) break;
    if (t === 0x0201) {
      const tc = parseTypeChunk(buf, o);
      if (tc) types.push(tc);
    } else if (t === 0x0001 && !trailingPool) {
      trailingPool = parseStringPool(buf, o);
    }
    o += sz;
  }
  return { id, name, typePool, keyPool, types, trailingPool };
}

/* ================= 矢量图标 → SVG ================= */
/**
 * 自适应图标 / 矢量图（VectorDrawable）的 pathData 就是 SVG 路径语法，
 * 直接在服务端转成 SVG，浏览器 <img> 原生渲染，无需任何 rasterizer。
 */

function attrOf(el, name) {
  for (const at of el.attrs || []) {
    if (at.name === name && at.nsUri === ANDROID_URI) return at;
  }
  return null;
}

const _f32 = Buffer.alloc(4);
function floatBits(bits) {
  _f32.writeUInt32LE(bits >>> 0);
  return _f32.readFloatLE(0);
}

/** 数值属性：兼容 INT_DEC / FLOAT / DIMENSION / BOOLEAN（后几种 data 是浮点位模式） */
function attrNumber(el, name, dflt) {
  const at = attrOf(el, name);
  if (!at) return dflt;
  if (at.dataType === 0x04 || at.dataType === 0x05 || at.dataType === 0x06) return floatBits(at.data);
  if (at.dataType === 0x10 || at.dataType === 0x11) return at.data | 0;
  if (at.dataType === 0x12) return at.data !== 0 ? 1 : 0;
  const n = parseFloat(at.rawValue);
  return isNaN(n) ? dflt : n;
}

function attrStr(el, name) {
  const at = attrOf(el, name);
  return at ? (at.rawValue || '') : '';
}

/** Android 颜色（#AARRGGBB 或 ref 或 INT_COLOR_*）→ CSS 颜色 */
function attrColor(el, name, table) {
  const at = attrOf(el, name);
  if (!at) return '#cccccc';
  if (at.dataType >= 0x1c && at.dataType <= 0x1f) {                   // INT_COLOR_ARGB8/RGB8/ARGB4/RGB4
    const c = at.data >>> 0;
    if (at.dataType === 0x1c) return argbToCss(c);                    // #AARRGGBB
    if (at.dataType === 0x1d) return 'rgb(' + ((c >>> 16) & 0xff) + ',' + ((c >>> 8) & 0xff) + ',' + (c & 0xff) + ')';
    const a = at.dataType === 0x1e ? (((c >>> 12) & 0xf) * 17) : 255;
    const r = ((c >>> 8) & 0xf) * 17, g = ((c >>> 4) & 0xf) * 17, b = (c & 0xf) * 17;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255).toFixed(3) + ')';
  }
  const raw = (at.rawValue || '').trim();
  if (raw.startsWith('#')) {
    if (raw.length === 9) {                                           // #AARRGGBB
      return argbToCss(parseInt(raw.slice(1), 16) >>> 0);
    }
    return raw;
  }
  if (at.dataType === 0x01 && table) {                                // 颜色资源引用
    try {
      for (const v of table.values(at.data)) {
        if (v.dataType >= 0x1c && v.dataType <= 0x1f) return attrColor({ attrs: [{ name, nsUri: ANDROID_URI, dataType: v.dataType, data: v.data, rawValue: '' }] }, name, null);
      }
    } catch (e) {}
  }
  return '#cccccc';
}

/** fillAlpha 可能是 0..1 浮点也可能是 0..255 整数，统一成 0..1 */
function attrAlpha(el, name) {
  const at = attrOf(el, name);
  if (!at) return -1;
  let v;
  if (at.dataType === 0x04 || at.dataType === 0x05) v = floatBits(at.data);
  else if (at.dataType === 0x10) v = at.data | 0;
  else { v = parseFloat(at.rawValue); }
  if (isNaN(v)) return -1;
  return v > 1 ? v / 255 : v;
}

function argbToCss(c) {
  const a = (c >>> 24) & 0xff, r = (c >>> 16) & 0xff, g = (c >>> 8) & 0xff, b = c & 0xff;
  if (a === 255) return 'rgb(' + r + ',' + g + ',' + b + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255).toFixed(3) + ')';
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** <vector> 元素 → { vw, vh, body }（body 是 SVG 内部内容） */
function vectorParts(el, table) {
  const vw = attrNumber(el, 'viewportWidth', 24) || 24;
  const vh = attrNumber(el, 'viewportHeight', 24) || 24;
  const out = [];
  const walk = (node, transform) => {
    for (const ch of node.children || []) {
      if (ch.name === 'path') {
        const d = attrStr(ch, 'pathData');
        if (!d) continue;
        const fill = attrColor(ch, 'fillColor', table);
        const alpha = attrAlpha(ch, 'fillAlpha');
        const op = alpha >= 0 ? ' fill-opacity="' + alpha.toFixed(3) + '"' : '';
        out.push('<path fill="' + fill + '"' + op + ' d="' + escXml(d) + '"' + transform + '/>');
      } else if (ch.name === 'group') {
        // group 变换：translate / rotation / scale（pivotX/pivotY）
        let t = '';
        const rot = attrNumber(ch, 'rotation', 0);
        const px = attrNumber(ch, 'pivotX', 0), py = attrNumber(ch, 'pivotY', 0);
        if (rot) t += ' rotate(' + rot + ' ' + px + ' ' + py + ')';
        const sx = attrNumber(ch, 'scaleX', 1), sy = attrNumber(ch, 'scaleY', 1);
        if (sx !== 1 || sy !== 1) t += ' scale(' + sx + ' ' + sy + ')';
        const tx = attrNumber(ch, 'translateX', 0), ty = attrNumber(ch, 'translateY', 0);
        if (tx || ty) t += ' translate(' + tx + ' ' + ty + ')';
        walk(ch, t ? (transform || '') + ' transform="' + t.trim() + '"' : transform);
      }
    }
  };
  walk(el, '');
  if (!out.length) return null;
  return { vw, vh, body: out.join('') };
}

/** 把一层（矢量或纯色）包成 108×108 自适应画布里的一层 */
function layerToG(layer, table) {
  if (!layer) return '';
  if (layer.solid) return '<rect x="0" y="0" width="108" height="108" fill="' + layer.solid + '"/>';
  const s = 108 / (layer.vw || 108);
  return '<g transform="scale(' + s.toFixed(4) + ')">' + layer.body + '</g>';
}
/* ================= 图片校验 ================= */
function imageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const fmt = buf.toString('latin1', 12, 16);
    if (fmt === 'VP8X' && buf.length >= 30) {
      return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1, ext: 'webp' };
    }
    if (fmt === 'VP8 ' && buf.length >= 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, ext: 'webp' };
    }
    if (fmt === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, ext: 'webp' };
    }
    return { w: 0, h: 0, ext: 'webp' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { w: 0, h: 0, ext: 'jpg' };
  return null;
}

function iconOk(buf) {
  if (!buf || buf.length < 512 || buf.length > MAX_ICON) return false;
  const info = imageInfo(buf);
  if (!info) return false;
  if (!info.w || !info.h) return true;            // jpg/未知格式不校验尺寸
  if (info.w < 24 || info.h < 24 || info.w > 2048 || info.h > 2048) return false;
  const r = info.w / info.h;
  return r > 0.45 && r < 2.2;                     // 图标基本是方的
}

/* ================= 从 AXML 里找图标引用 ================= */
function attrRef(el, name) {
  for (const at of el.attrs || []) {
    if (at.name === name && at.nsUri === ANDROID_URI && at.dataType === 0x01 && at.data) return at.data;
  }
  return null;
}

function elText(el, name) {
  for (const at of el.attrs || []) {
    if (at.name === name && at.nsUri === ANDROID_URI) return at.rawValue || '';
  }
  return '';
}

function hasLauncherCategory(activity) {
  let main = false, cat = false;
  for (const f of activity.children || []) {
    if (f.name !== 'intent-filter') continue;
    let m2 = false, c2 = false;
    for (const x of f.children || []) {
      if (x.name === 'action' && elText(x, 'name').endsWith('.MAIN')) m2 = true;
      if (x.name === 'category' && /LAUNCHER$/.test(elText(x, 'name'))) c2 = true;
    }
    if (m2) main = true;
    if (c2) cat = true;
  }
  return main && cat;
}

/** 应用图标 ref 优先；没有就退回启动 Activity 的图标 ref */
function findIconRef(root) {
  if (!root) return null;
  let actIcon = null;
  for (const app of root.children || []) {
    if (app.name !== 'application') continue;
    const appIcon = attrRef(app, 'icon');
    if (appIcon) return appIcon;
    for (const a of app.children || []) {
      if (a.name !== 'activity' && a.name !== 'activity-alias') continue;
      if (hasLauncherCategory(a)) actIcon = attrRef(a, 'icon') || actIcon;
    }
  }
  return actIcon;
}

/** 自适应图标 XML（<adaptive-icon>）里找前景/背景 drawable 引用（按优先级返回多个） */
function findAdaptiveRefs(root) {
  if (!root) return [];
  const out = [];
  for (const want of ['foreground', 'background', 'icon']) {
    for (const el of root.children || []) {
      if (el.name === want) {
        const r = attrRef(el, 'drawable') || attrRef(el, 'icon');
        if (r) out.push(r);
      }
    }
  }
  return out;
}

/** 资源 ID 的所有「原始值」变体（颜色等非文件资源用） */
function tableValues(table, resId) {
  if (!table || !table.values) return [];
  return table.values(resId);
}

/** locale 偏好打分：zh-CN > 其他 zh 变体 > 默认 */
function localeScore(chunkLocale, want) {
  if (!chunkLocale) return 0;
  if (chunkLocale === want || chunkLocale === want + '-CN') return 3;
  if (chunkLocale.slice(0, 2) === want) return 2;
  return 0;
}

/** drawable 引用 → 一层 SVG（矢量 / 纯色）。位图引用返回 null（没法进 SVG） */
async function drawableToLayer(ref, apk, adb, serial, table, depth) {
  // 先看是不是颜色资源
  for (const v of tableValues(table, ref)) {
    if (v.dataType === 0x1c) return { solid: argbToCss(v.data >>> 0) };
  }
  for (const p of table.resolveAll(ref)) {
    if (!/\.xml$/i.test(p)) return null;                       // 位图，SVG 用不了
    const xb = await adbRun(adb, serial, ['exec-out', 'unzip', '-p', apk, p], 25000);
    if (!xb.stdout.length) continue;
    const xt = parseAXML(xb.stdout);
    if (!xt) continue;
    if (xt.name === 'vector') {
      const parts = vectorParts(xt, table);
      if (parts) return parts;
    } else if (xt.name === 'adaptive-icon' && depth < 4) {
      // 嵌套自适应图标：递归取背景+前景
      const inner = [];
      for (const want of ['background', 'foreground']) {
        const child = (xt.children || []).find((c) => c.name === want);
        if (!child) continue;
        const r2 = attrRef(child, 'drawable') || attrRef(child, 'icon');
        if (!r2) continue;
        const layer = await drawableToLayer(r2, apk, adb, serial, table, depth + 1);
        if (layer) inner.push(layerToG(layer, table));
      }
      if (inner.length) return { vw: 108, vh: 108, body: inner.join('') };
    }
  }
  return null;
}

/** apk 里的一个 XML 资源 → 完整 SVG 字符串（矢量或自适应图标），失败返回 '' */
async function xmlToSvg(path, apk, adb, serial, table, depth) {
  const xb = await adbRun(adb, serial, ['exec-out', 'unzip', '-p', apk, path], 25000);
  if (!xb.stdout.length) return '';
  const xt = parseAXML(xb.stdout);
  if (!xt) return '';
  if (xt.name === 'vector') {
    const parts = vectorParts(xt, table);
    if (!parts) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + parts.vw + ' ' + parts.vh + '">' + parts.body + '</svg>';
  }
  if (xt.name === 'adaptive-icon') {
    const layers = [];
    for (const want of ['background', 'foreground']) {
      const child = (xt.children || []).find((c) => c.name === want);
      if (!child) continue;
      const ref = attrRef(child, 'drawable') || attrRef(child, 'icon');
      if (!ref) continue;
      const layer = await drawableToLayer(ref, apk, adb, serial, table, depth);
      if (layer) layers.push(layerToG(layer, table));
    }
    if (!layers.length) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">' + layers.join('') + '</svg>';
  }
  return '';
}

/* ================= 主流程 ================= */
async function apkPath(pkg, adb, serial) {
  const r = await adbRun(adb, serial, ['shell', 'pm', 'path', pkg], 10000);
  const m = /package:([^\r\n]+)/.exec(r.stdout.toString('utf8'));
  return m ? m[1].trim() : '';
}

/**
 * 提取图标。
 * @returns {Promise<{ok:true,data:Buffer,ext:string,w:number,h:number,path:string}|{ok:false,why:string}>}
 */
async function extractIcon(pkg, opts) {
  const adb = (opts && opts.adb) || 'adb';
  const serial = (opts && opts.serial) || '';
  if (!/^[A-Za-z][\w.]*$/.test(String(pkg || ''))) return { ok: false, why: 'bad-pkg' };

  const apk = await apkPath(pkg, adb, serial);
  if (!apk) return { ok: false, why: 'no-apk' };

  const mani = await adbRun(adb, serial, ['exec-out', 'unzip', '-p', apk, 'AndroidManifest.xml'], 25000);
  if (!mani.stdout.length) return { ok: false, why: 'no-manifest' };
  const tree = parseAXML(mani.stdout);
  const iconRef = findIconRef(tree);
  if (!iconRef) return { ok: false, why: 'no-icon-ref' };

  const arsc = await adbRun(adb, serial, ['exec-out', 'unzip', '-p', apk, 'resources.arsc'], 40000);
  if (!arsc.stdout.length) return { ok: false, why: 'no-arsc' };
  const table = parseARSC(arsc.stdout);
  if (!table) return { ok: false, why: 'bad-arsc' };

  const paths = table.resolveAll(iconRef);
  if (!paths.length) return { ok: false, why: 'no-entry' };
  // 同一图标资源常有多个密度变体：anydpi-v26 里放的是自适应图标 XML（前景常是矢量图，
  // 取不出位图），而各密度分片里就是现成的 PNG/WebP。优先用非 XML 的变体。
  let path = paths.find((p) => !/\.xml$/i.test(p)) || paths[0];

  // 万不得已全是 XML（自适应图标 / 矢量图）：转成 SVG 交给浏览器渲染
  let depth = 0;
  while (path && /\.xml$/i.test(path) && depth++ < 4) {
    const svg = await xmlToSvg(path, apk, adb, serial, table, depth);
    if (svg) return { ok: true, svg, ext: 'svg', w: 0, h: 0, path };
    return { ok: false, why: 'svg-fail' };
  }
  if (!path || /\.xml$/i.test(path)) return { ok: false, why: 'still-xml' };

  const ic = await adbRun(adb, serial, ['exec-out', 'unzip', '-p', apk, path], 25000);
  if (!ic.stdout.length) return { ok: false, why: 'no-icon-data' };
  if (!iconOk(ic.stdout)) return { ok: false, why: 'icon-invalid' };
  const info = imageInfo(ic.stdout);
  return { ok: true, data: ic.stdout, ext: info.ext, w: info.w, h: info.h, path };
}

/* ================= CLI ================= */
if (require.main === module) {
  (async () => {
    const fs = require('fs');
    const args = process.argv.slice(2);
    const adb = process.env.ADB || 'adb';
    const serial = process.env.TV_ADB || '';
    let pkgs = [], outdir = '/tmp/icons2';
    if (args[0] === '--all') {
      pkgs = fs.readFileSync(args[1] || '/tmp/pkgs.txt', 'utf8').split(/\r?\n/).filter(Boolean);
      outdir = args[2] || outdir;
    } else if (args[0]) {
      pkgs = [args[0]];
      outdir = args[1] || outdir;
    } else {
      console.log('用法: node apkicon.js <包名> [输出目录] | node apkicon.js --all [包列表文件] [输出目录]');
      process.exit(1);
    }
    fs.mkdirSync(outdir, { recursive: true });
    let ok = 0, bad = 0;
    for (const pkg of pkgs) {
      try {
        const r = await extractIcon(pkg, { adb, serial });
        if (r.ok) {
          const f = outdir + '/' + pkg + '.' + r.ext;
          const bytes = r.data !== undefined ? r.data : Buffer.from(r.svg || '', 'utf8');
          fs.writeFileSync(f, bytes);
          ok++;
          console.log(`OK   ${pkg}  ${r.path}  ${r.ext === 'svg' ? 'SVG' : r.w + 'x' + r.h}  ${bytes.length}B`);
        } else {
          bad++;
          console.log(`FAIL ${pkg}  ${r.why}`);
        }
      } catch (e) {
        bad++;
        console.log(`ERR  ${pkg}  ${e.message}`);
      }
    }
    console.log(`\n完成: ${ok} 成功, ${bad} 失败`);
  })();
}

module.exports = { extractIcon, parseAXML, parseARSC, parseStringPool, imageInfo, iconOk };
