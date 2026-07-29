const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, clipboard, nativeImage, dialog, globalShortcut, Notification } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');
const execFileAsync = promisify(execFile);

let win;
let peekWin;
let watcher;
let refreshTimer;
let systemTimer;
let companionTimer;
let previousCpu = null;
let diskCache = { at: 0, data: [] };
let displayNameCache = null;
let regionActive = false;
let hoverTimer = null;
let expandedMode = false;
let peekHidden = false;
let hoverHideAt = 0;
let manualFullScreen = false;
let latestRemainingPercent = 0;
const tokenFileCache = new Map();
let database = null;
let activeSessionFile = null;
let activeSessionMeta = null;
const ocrInFlight = new Set();
const ocrQueue = [];
let ocrWorkerActive = false;

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const sessionsRoot = path.join(codexHome, 'sessions');
const PEEK_HEIGHT = 4;
const FONT_SCALES = { normal: 1, medium: 1.14, large: 1.28 };

function fontMode() {
  const mode = getSetting('font_size', 'normal');
  return FONT_SCALES[mode] ? mode : 'normal';
}

function uiScale() { return FONT_SCALES[fontMode()]; }

function normalWindowBounds(display, expanded = expandedMode) {
  const scale = uiScale();
  const width = Math.min(display.workArea.width - 16, Math.round((expanded ? 700 : 690) * scale));
  const height = expanded ? Math.min(Math.round(950 * scale), display.workArea.height - 12) : Math.round(138 * scale);
  return { x: display.workArea.x + Math.round((display.workArea.width - width) / 2), y: display.workArea.y, width, height };
}

function createPeekWindow() {
  peekWin = new BrowserWindow({
    width: Math.round(690 * uiScale()), height: PEEK_HEIGHT, minWidth: 1, minHeight: 1,
    frame: false, transparent: true, hasShadow: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false, focusable: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:rgba(23,28,45,.84)}i{display:block;width:0;height:100%;background:linear-gradient(90deg,#7787ff,#68d9b4);box-shadow:0 0 10px rgba(104,217,180,.55)}</style></head><body><i id="bar"></i></body></html>`;
  peekWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  peekWin.setIgnoreMouseEvents(true, { forward: true });
  peekWin.webContents.once('did-finish-load', () => updatePeekBar(latestRemainingPercent));
}

function updatePeekBar(value) {
  latestRemainingPercent = Math.max(0, Math.min(100, Number(value) || 0));
  if (peekWin && !peekWin.isDestroyed() && !peekWin.webContents.isLoading()) {
    peekWin.webContents.executeJavaScript(`document.getElementById('bar').style.width='${latestRemainingPercent}%'`).catch(() => {});
  }
}

function initDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'yooncode.sqlite');
  database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      remaining REAL NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_samples_ts ON usage_samples(ts);
    CREATE TABLE IF NOT EXISTS screenshots (
      path TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      ocr_text TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '截图',
      tags TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      ocr_status INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_letters (
      day TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_action_events_ts ON action_events(ts);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function recordUsageSample(remaining, totalTokens) {
  if (!database || !Number.isFinite(remaining)) return;
  const now = Date.now();
  const last = database.prepare('SELECT ts, remaining, total_tokens FROM usage_samples ORDER BY ts DESC LIMIT 1').get();
  if (!last || now - last.ts >= 60000 || last.remaining !== remaining || last.total_tokens !== totalTokens) {
    database.prepare('INSERT INTO usage_samples(ts, remaining, total_tokens) VALUES (?, ?, ?)').run(now, remaining, totalTokens);
    database.prepare('DELETE FROM usage_samples WHERE ts < ?').run(now - 30 * 24 * 60 * 60 * 1000);
  }
}

function buildForecast(remaining) {
  if (!database || !Number.isFinite(remaining)) return { ready: false, reason: '等待额度数据' };
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = database.prepare('SELECT ts, remaining FROM usage_samples WHERE ts >= ? ORDER BY ts ASC').all(since);
  if (rows.length < 2) return { ready: false, reason: '正在积累样本' };
  let segmentStart = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].remaining - rows[i - 1].remaining > 5) segmentStart = i;
  const segment = rows.slice(segmentStart);
  const latest = segment[segment.length - 1];
  const candidates = segment.filter(row => latest.ts - row.ts >= 20 * 60 * 1000 && row.remaining > latest.remaining);
  if (!candidates.length) return { ready: false, reason: '至少需要20分钟有效消耗样本', samples: segment.length };
  const earliest = candidates[0];
  const spanHours = (latest.ts - earliest.ts) / 3600000;
  const ratePerHour = (earliest.remaining - latest.remaining) / spanHours;
  if (!(ratePerHour > 0)) return { ready: false, reason: '当前消耗速度较低', samples: segment.length };
  const hoursLeft = remaining / ratePerHour;
  const exhaustAt = Date.now() + hoursLeft * 3600000;
  const confidence = spanHours >= 2 && candidates.length >= 8 ? '高' : spanHours >= 0.5 && candidates.length >= 3 ? '中等' : '初步';
  return {
    ready: true,
    ratePerHour,
    hoursLeft,
    exhaustAt,
    confidence,
    samples: segment.length,
    spanHours
  };
}

function screenshotsDir() {
  return path.join(app.getPath('pictures'), 'Codex Pulse');
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const initial = normalWindowBounds(display, false);
  win = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: 620,
    minHeight: 2,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  createPeekWindow();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => win.webContents.setZoomFactor(uiScale()));
  win.once('ready-to-show', () => {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = win.getBounds();
    win.setPosition(area.x + Math.round((area.width - bounds.width) / 2), area.y);
    win.show();
    publishUsage();
  });
  win.on('closed', () => { if (peekWin && !peekWin.isDestroyed()) peekWin.destroy(); peekWin = null; win = null; });
}

async function setPeekWindow(hidden) {
  if (!win || win.isDestroyed() || expandedMode) return;
  const display = screen.getDisplayMatching(win.getBounds());
  peekHidden = hidden;
  if (hidden) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.send('window:peek', true);
    try {
      await win.webContents.executeJavaScript("new Promise(resolve => { const app = document.getElementById('app'); if (app) app.classList.add('peek'); requestAnimationFrame(() => requestAnimationFrame(resolve)); })");
    } catch {}
    if (!win || win.isDestroyed() || !peekHidden || expandedMode) return;
    const width = normalWindowBounds(display, false).width;
    const bounds = { x: display.workArea.x + Math.round((display.workArea.width - width) / 2), y: display.workArea.y, width, height: PEEK_HEIGHT };
    win.hide();
    if (peekWin && !peekWin.isDestroyed()) {
      peekWin.setBounds(bounds, false);
      peekWin.setAlwaysOnTop(win.isAlwaysOnTop(), 'screen-saver');
      peekWin.showInactive();
    }
    return;
  }
  if (peekWin && !peekWin.isDestroyed()) peekWin.hide();
  win.setBounds(normalWindowBounds(display, false), false);
  win.setResizable(true);
  win.setIgnoreMouseEvents(false);
  win.webContents.send('window:peek', false);
  if (!win.isVisible()) win.showInactive();
}

function startNativeHoverMonitor() {
  clearInterval(hoverTimer);
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || expandedMode) return;
    const cursor = screen.getCursorScreenPoint();
    if (peekHidden) {
      if (!peekWin || peekWin.isDestroyed() || !peekWin.isVisible()) return;
      const bounds = peekWin.getBounds();
      const inTopTrigger = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
        cursor.y >= bounds.y && cursor.y < bounds.y + PEEK_HEIGHT;
      if (inTopTrigger) {
        hoverHideAt = 0;
        setPeekWindow(false);
      }
      return;
    }
    if (!win.isVisible()) return;
    const bounds = win.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
    if (inside) hoverHideAt = 0;
    else if (!hoverHideAt) hoverHideAt = Date.now() + 850;
    else if (Date.now() >= hoverHideAt) {
      hoverHideAt = 0;
      setPeekWindow(true);
    }
  }, 100);
}

function readDisplayName() {
  if (displayNameCache) return displayNameCache;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
    const token = auth.tokens?.id_token || auth.id_token;
    if (token) {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
      displayNameCache = payload.name || payload.given_name || payload.email?.split('@')[0];
    }
  } catch {}
  return displayNameCache || os.userInfo().username;
}

async function walk(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) out.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out;
}

async function tailLines(file, maxBytes = 1024 * 1024) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString('utf8').split(/\r?\n/).reverse();
  } finally { await handle.close(); }
}

async function headLines(file, maxBytes = 256 * 1024) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8').split(/\r?\n/);
  } finally { await handle.close(); }
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function readIndexedTitle(sessionId) {
  if (!sessionId) return null;
  try {
    const rows = (await fsp.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8')).split(/\r?\n/).reverse();
    for (const line of rows) {
      const row = safeJson(line);
      if (row?.id === sessionId && row.thread_name) return row.thread_name;
    }
  } catch {}
  return null;
}

async function readAllTokenTotal() {
  const roots = [sessionsRoot, path.join(codexHome, 'archived_sessions')];
  const groups = await Promise.all(roots.map(root => walk(root)));
  const files = groups.flat();
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    seen.add(file.full);
    let cached = tokenFileCache.get(file.full);
    if (!cached || cached.mtimeMs !== file.mtimeMs || cached.size !== file.size) {
      let tokens = 0;
      for (const line of await tailLines(file.full, 1024 * 1024)) {
        const row = safeJson(line);
        if (row?.payload?.type === 'token_count') {
          tokens = row.payload.info?.total_token_usage?.total_tokens || 0;
          break;
        }
      }
      cached = { mtimeMs: file.mtimeMs, size: file.size, tokens };
      tokenFileCache.set(file.full, cached);
    }
    total += cached.tokens;
  }
  for (const full of tokenFileCache.keys()) if (!seen.has(full)) tokenFileCache.delete(full);
  return total;
}

async function readSessionCard(file) {
  const lines = (await tailLines(file.full, 2 * 1024 * 1024)).map(safeJson).filter(Boolean);
  const tokenRows = lines.filter(row => row.payload?.type === 'token_count');
  const newest = tokenRows[0];
  if (!newest) return null;
  let meta = lines.find(row => row.type === 'session_meta')?.payload || null;
  if (!meta) {
    for (const line of await headLines(file.full)) {
      const row = safeJson(line);
      if (row?.type === 'session_meta') { meta = row.payload || {}; break; }
    }
  }
  let model = null;
  for (const row of lines) {
    const payload = row.payload || {};
    model = payload.model || payload.model_name || row.model || (payload.type === 'turn_context' ? payload.model : null);
    if (model) break;
  }
  const info = newest.payload.info || {};
  const last = info.last_token_usage || {};
  const contextWindow = info.model_context_window || 0;
  const currentContextTokens = last.input_tokens || 0;
  const contextPercent = contextWindow ? Math.min(100, currentContextTokens / contextWindow * 100) : 0;
  const history = tokenRows.slice(0, 30).reverse().map(row => {
    const eventInfo = row.payload.info || {};
    const eventLast = eventInfo.last_token_usage || {};
    const window = eventInfo.model_context_window || 0;
    const contextTokens = eventLast.input_tokens || 0;
    return { timestamp: row.timestamp, contextTokens, contextPercent: window ? Math.min(100, contextTokens / window * 100) : 0 };
  });
  const title = await readIndexedTitle(meta?.id);
  return {
    path: file.full,
    sessionId: meta?.id || null,
    title: title || meta?.title || meta?.cwd || path.basename(file.full, '.jsonl'),
    workspacePath: meta?.cwd || null,
    model: model || meta?.model || 'Codex',
    currentContextTokens,
    contextWindow,
    contextPercent,
    updatedAt: newest.timestamp || file.mtimeMs,
    history
  };
}

function buildReplay(rows) {
  const timeline = [];
  const seenThresholds = new Set();
  for (const row of rows) {
    const payload = row.payload || {};
    const timestamp = row.timestamp || payload.timestamp || Date.now();
    if (payload.type === 'user_message') {
      const text = payload.message || payload.text || contentText(payload.content);
      if (text) timeline.push({ type: 'request', timestamp, title: '提出新需求', detail: cleanSnippet(text, 90) });
    } else if (payload.type === 'agent_message') {
      const text = payload.message || payload.text || contentText(payload.content);
      if (text) timeline.push({ type: 'done', timestamp, title: 'Codex 完成一次回复', detail: cleanSnippet(text, 90) });
    } else if (row.type === 'response_item' && payload.type === 'function_call') {
      timeline.push({ type: 'tool', timestamp, title: `调用工具：${payload.name || '本地工具'}`, detail: '正在读取、修改或验证当前工作区' });
    } else if (payload.type === 'token_count') {
      const info = payload.info || {};
      const window = info.model_context_window || 0;
      const context = info.last_token_usage?.input_tokens || 0;
      const percent = window ? Math.round(context / window * 100) : 0;
      const threshold = percent >= 90 ? 90 : percent >= 80 ? 80 : percent >= 65 ? 65 : 0;
      if (threshold && !seenThresholds.has(threshold)) {
        seenThresholds.add(threshold);
        timeline.push({ type: threshold >= 80 ? 'warning' : 'context', timestamp, title: `上下文达到 ${percent}%`, detail: threshold >= 80 ? '记忆舱建议进入迁移准备状态' : '建议开始整理关键结论' });
      }
    }
  }
  const deduped = [];
  for (const item of timeline) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.type === item.type && previous.detail === item.detail) continue;
    deduped.push(item);
  }
  return deduped.slice(-12);
}

async function readUsage() {
  const files = (await walk(sessionsRoot)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
  let latestToken = null;
  let latestModel = null;
  let latestSession = null;
  let tokenFile = null;

  for (const file of files) {
    const lines = await tailLines(file.full, 2 * 1024 * 1024);
    let fileToken = null;
    let fileModel = null;
    let fileSession = null;
    for (const line of lines) {
      const row = safeJson(line);
      if (!row) continue;
      const payload = row.payload || {};
      if (!fileToken && payload.type === 'token_count') fileToken = { ...payload, timestamp: row.timestamp, file: file.full };
      if (!fileModel) {
        fileModel = payload.model || payload.model_name || row.model || null;
        if (!fileModel && payload.type === 'turn_context') fileModel = payload.model;
      }
      if (!fileSession && row.type === 'session_meta') fileSession = payload;
      if (fileToken && fileModel && fileSession) break;
    }
    if (fileToken) {
      if (!fileSession) {
        for (const line of await headLines(file.full)) {
          const row = safeJson(line);
          if (row?.type === 'session_meta') { fileSession = row.payload || {}; break; }
        }
      }
      latestToken = fileToken;
      latestModel = fileModel;
      latestSession = fileSession;
      tokenFile = file.full;
      break;
    }
  }

  const info = latestToken?.info || {};
  const rate = latestToken?.rate_limits || {};
  const primary = rate.primary || {};
  const usage = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  const usedPercent = Number.isFinite(primary.used_percent) ? primary.used_percent : null;
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const indexedTitle = await readIndexedTitle(latestSession?.id);
  const allTimeTokens = await readAllTokenTotal();
  activeSessionFile = tokenFile;
  activeSessionMeta = latestSession;
  recordUsageSample(remainingPercent, allTimeTokens);
  const forecast = buildForecast(remainingPercent);
  let history = [];
  let replay = [];
  if (tokenFile) {
    const recentRows = (await tailLines(tokenFile, 2 * 1024 * 1024)).map(safeJson).filter(Boolean);
    const events = recentRows
      .filter(row => row.payload?.type === 'token_count')
      .reverse()
      .slice(-30);
    history = events.map(row => {
      const eventInfo = row.payload.info || {};
      const eventLast = eventInfo.last_token_usage || {};
      const window = eventInfo.model_context_window || 0;
      const contextTokens = eventLast.input_tokens || 0;
      return {
        timestamp: row.timestamp,
        contextTokens,
        contextPercent: window ? Math.min(100, contextTokens / window * 100) : 0,
        totalTokens: eventInfo.total_token_usage?.total_tokens || 0
      };
    });
    replay = buildReplay([...recentRows].reverse());
  }
  const sessions = (await Promise.all(files.slice(0, 8).map(readSessionCard))).filter(Boolean);
  return {
    connected: Boolean(latestToken),
    codexName: latestModel || latestSession?.model || 'Codex',
    displayName: readDisplayName(),
    username: os.userInfo().username,
    sessionTitle: indexedTitle || latestSession?.title || latestSession?.cwd || '当前会话',
    workspacePath: latestSession?.cwd || null,
    sessionId: latestSession?.id || null,
    sessionPath: tokenFile,
    totalTokens: allTimeTokens,
    sessionTotalTokens: usage.total_tokens || 0,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cachedTokens: usage.cached_input_tokens || 0,
    lastTokens: last.total_tokens || 0,
    turnOutputTokens: (last.output_tokens || 0) + (last.reasoning_output_tokens || 0),
    currentContextTokens: last.input_tokens || 0,
    contextWindow: info.model_context_window || 0,
    usedPercent,
    remainingPercent,
    windowMinutes: primary.window_minutes || null,
    resetsAt: primary.resets_at || null,
    credits: rate.credits || null,
    updatedAt: latestToken?.timestamp || null,
    history,
    sessions,
    replay,
    forecast,
    source: latestToken ? 'Codex 本机会话事件' : '未找到 Codex 会话事件',
    note: '套餐剩余量来自 Codex 返回的限额百分比；token 数与套餐百分比不是同一计量单位。'
  };
}

async function publishUsage() {
  if (!win || win.isDestroyed()) return;
  try { const usage = await readUsage(); updatePeekBar(usage.remainingPercent); win.webContents.send('usage:update', usage); }
  catch (error) { win.webContents.send('usage:error', error.message); }
}

function cpuSnapshot() {
  const cores = os.cpus();
  return cores.reduce((sum, core) => {
    const total = Object.values(core.times).reduce((a, b) => a + b, 0);
    return { idle: sum.idle + core.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

function cpuUsage() {
  const now = cpuSnapshot();
  if (!previousCpu) { previousCpu = now; return 0; }
  const total = now.total - previousCpu.total;
  const idle = now.idle - previousCpu.idle;
  previousCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

async function readDisks() {
  if (Date.now() - diskCache.at < 15000) return diskCache.data;
  try {
    const command = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace,VolumeName | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
    const raw = JSON.parse(stdout.trim() || '[]');
    const rows = Array.isArray(raw) ? raw : [raw];
    diskCache = {
      at: Date.now(),
      data: rows.map(row => ({
        name: row.DeviceID,
        label: row.VolumeName || '本地磁盘',
        total: Number(row.Size) || 0,
        free: Number(row.FreeSpace) || 0,
        usedPercent: row.Size ? Math.round((1 - Number(row.FreeSpace) / Number(row.Size)) * 100) : 0
      }))
    };
  } catch { diskCache = { at: Date.now(), data: [] }; }
  return diskCache.data;
}

async function readSystemStats() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    cpuPercent: Math.round(cpuUsage()),
    memoryPercent: Math.round((1 - freeMemory / totalMemory) * 100),
    memoryUsed: totalMemory - freeMemory,
    memoryTotal: totalMemory,
    uptime: os.uptime(),
    disks: await readDisks()
  };
}

async function publishSystemStats() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('system:update', await readSystemStats());
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(publishUsage, 250);
}

function startWatching() {
  try {
    watcher = fs.watch(sessionsRoot, { recursive: true }, scheduleRefresh);
  } catch {
    const timer = setInterval(publishUsage, 2000);
    app.on('before-quit', () => clearInterval(timer));
  }
}

function categorizeOcr(text) {
  const value = String(text || '').toLowerCase();
  if (/error|exception|failed|失败|错误|异常|报错/.test(value)) return '报错';
  if (/function|const |let |class |import |export |def |public |private |代码|token/.test(value)) return '代码';
  if (/figma|按钮|界面|页面|设计|ui|ux/.test(value)) return 'UI';
  if (/文档|说明|手册|markdown|readme/.test(value)) return '文档';
  return '截图';
}

async function runScreenshotOcr(full) {
  if (!database || ocrInFlight.has(full)) return;
  ocrInFlight.add(full);
  database.prepare('UPDATE screenshots SET ocr_status = 1 WHERE path = ?').run(full);
  try {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'ocr.ps1')
      : path.join(__dirname, 'ocr.ps1');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', full], {
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    });
    const text = String(stdout || '').replace(/\s+/g, ' ').trim();
    database.prepare('UPDATE screenshots SET ocr_text = ?, category = ?, ocr_status = 2 WHERE path = ?').run(text, categorizeOcr(text), full);
  } catch {
    database.prepare('UPDATE screenshots SET ocr_status = -1 WHERE path = ?').run(full);
  } finally {
    ocrInFlight.delete(full);
    if (win && !win.isDestroyed()) win.webContents.send('screenshots:update', await listScreenshots());
  }
}

function queueScreenshotOcr(full) {
  if (ocrInFlight.has(full) || ocrQueue.includes(full)) return;
  ocrQueue.push(full);
  if (!ocrWorkerActive) processScreenshotOcrQueue();
}

async function processScreenshotOcrQueue() {
  ocrWorkerActive = true;
  while (ocrQueue.length) {
    const full = ocrQueue.shift();
    if (fs.existsSync(full)) await runScreenshotOcr(full);
  }
  ocrWorkerActive = false;
}

async function listScreenshots(query = '') {
  const dir = screenshotsDir();
  await fsp.mkdir(dir, { recursive: true });
  const names = (await fsp.readdir(dir)).filter(n => n.endsWith('.png')).sort().reverse();
  const existing = new Set(names.map(name => path.join(dir, name)));
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await fsp.stat(full);
    const row = database.prepare('SELECT path, ocr_status FROM screenshots WHERE path = ?').get(full);
    if (!row) {
      database.prepare('INSERT INTO screenshots(path, created_at) VALUES (?, ?)').run(full, Math.round(stat.birthtimeMs || stat.mtimeMs));
      queueScreenshotOcr(full);
    } else if (row.ocr_status === 0) queueScreenshotOcr(full);
  }
  for (const row of database.prepare('SELECT path FROM screenshots').all()) {
    if (!existing.has(row.path)) database.prepare('DELETE FROM screenshots WHERE path = ?').run(row.path);
  }
  const term = String(query || '').trim();
  const rows = term
    ? database.prepare(`SELECT * FROM screenshots WHERE path LIKE ? OR ocr_text LIKE ? OR tags LIKE ? OR category LIKE ? ORDER BY favorite DESC, created_at DESC LIMIT 100`).all(...Array(4).fill(`%${term}%`))
    : database.prepare('SELECT * FROM screenshots ORDER BY favorite DESC, created_at DESC LIMIT 100').all();
  return rows.map(row => ({
    name: path.basename(row.path), path: row.path, url: `file://${row.path.replace(/\\/g, '/')}`,
    createdAt: row.created_at, ocrText: row.ocr_text, category: row.category, tags: row.tags,
    favorite: Boolean(row.favorite), ocrStatus: row.ocr_status
  }));
}

async function takeScreenshot() {
  if (win) win.hide();
  await new Promise(resolve => setTimeout(resolve, 180));
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale)
      }
    });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('没有获取到屏幕画面');
    const full = await saveImage(source.thumbnail, 'codex');
    return { ok: true, path: full, items: await listScreenshots() };
  } finally {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  }
}

async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  });
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('没有获取到屏幕画面');
  return { display, image: source.thumbnail };
}

async function saveImage(image, prefix = 'codex') {
  const dir = screenshotsDir();
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const full = path.join(dir, `${prefix}-${stamp}.png`);
  await fsp.writeFile(full, image.toPNG());
  return full;
}

async function takeRegionScreenshot() {
  if (regionActive) return { ok: false, busy: true, items: await listScreenshots() };
  regionActive = true;
  if (win) win.hide();
  await new Promise(resolve => setTimeout(resolve, 180));
  let captured;
  try { captured = await capturePrimaryScreen(); }
  catch (error) { regionActive = false; if (win && !win.isDestroyed()) win.show(); throw error; }
  const { display, image } = captured;
  const selector = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'selector-preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  selector.setAlwaysOnTop(true, 'screen-saver');
  await selector.loadFile(path.join(__dirname, 'selector.html'));
  selector.webContents.send('selection:image', image.toDataURL());
  selector.show(); selector.focus();

  return new Promise(resolve => {
    let settled = false;
    const finish = async (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('selection:complete', onComplete);
      ipcMain.removeListener('selection:cancel', onCancel);
      if (!selector.isDestroyed()) selector.destroy();
      let result = { ok: false, cancelled: true, items: await listScreenshots() };
      if (rect && rect.width >= 4 && rect.height >= 4) {
        const scale = image.getSize().width / display.size.width;
        const crop = {
          x: Math.max(0, Math.round(rect.x * scale)), y: Math.max(0, Math.round(rect.y * scale)),
          width: Math.min(image.getSize().width - Math.max(0, Math.round(rect.x * scale)), Math.round(rect.width * scale)),
          height: Math.min(image.getSize().height - Math.max(0, Math.round(rect.y * scale)), Math.round(rect.height * scale))
        };
        const cropped = image.crop(crop);
        const full = await saveImage(cropped, 'region');
        result = { ok: true, path: full, items: await listScreenshots() };
      }
      if (win && !win.isDestroyed()) { win.show(); win.focus(); }
      regionActive = false;
      resolve(result);
    };
    const onComplete = (event, rect) => { if (event.sender === selector.webContents) finish(rect); };
    const onCancel = event => { if (event.sender === selector.webContents) finish(null); };
    ipcMain.on('selection:complete', onComplete);
    ipcMain.on('selection:cancel', onCancel);
    selector.on('closed', () => { if (!settled) finish(null); else if (win && !win.isDestroyed()) win.show(); });
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item?.text || item?.input_text || item?.output_text || '').filter(Boolean).join('\n');
}

function cleanSnippet(text, limit = 260) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function dailySnippet(text, limit = 118) {
  const cleaned = cleanSnippet(text, 240)
    .replace(/^#{1,6}\s*/, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/^[\-*✓•]+\s*/, '');
  const firstThought = cleaned.split(/(?<=[。！？!?])\s*/)[0] || cleaned;
  return firstThought.slice(0, limit).trim();
}

async function buildHandoffPackage(requestedSessionFile = null) {
  if (!activeSessionFile) await readUsage();
  const sessionFile = requestedSessionFile ? path.resolve(requestedSessionFile) : activeSessionFile;
  if (!sessionFile) throw new Error('暂未找到活跃的 Codex 对话');
  const allowedRoots = [sessionsRoot, path.join(codexHome, 'archived_sessions')].map(root => path.resolve(root));
  if (!allowedRoots.some(root => sessionFile.startsWith(root + path.sep))) throw new Error('对话路径无效');
  const stat = await fsp.stat(sessionFile);
  const overview = await readSessionCard({ full: sessionFile, mtimeMs: stat.mtimeMs });
  if (!overview) throw new Error('暂未读取到该对话的 Token 信息');
  const rows = (await tailLines(sessionFile, 6 * 1024 * 1024)).reverse().map(safeJson).filter(Boolean);
  const userMessages = [];
  const assistantMessages = [];
  const userSeen = new Set();
  const assistantSeen = new Set();
  const files = new Set();
  const pushUnique = (list, seen, text, limit) => {
    const cleaned = cleanSnippet(text, limit);
    const key = cleaned.replace(/\s+/g, '').toLowerCase();
    if (!cleaned || seen.has(key)) return;
    seen.add(key); list.push(cleaned);
  };
  const addFile = candidate => {
    const cleaned = String(candidate || '').replace(/\\\\/g, '\\').trim();
    if (!cleaned || cleaned.length > 260 || /--check|exit code|wall time|output:|[;`]/i.test(cleaned)) return;
    files.add(cleaned);
  };
  for (const row of rows) {
    const payload = row.payload || {};
    if (payload.type === 'user_message') {
      const text = payload.message || payload.text || contentText(payload.content);
      pushUnique(userMessages, userSeen, text, 700);
    }
    if (payload.type === 'agent_message') {
      const text = payload.message || payload.text || contentText(payload.content);
      pushUnique(assistantMessages, assistantSeen, text, 420);
    }
    if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = contentText(payload.content);
      pushUnique(assistantMessages, assistantSeen, text, 420);
    }
    const raw = JSON.stringify(payload);
    for (const match of raw.matchAll(/(?:Add|Update|Delete) File:\s*([^\\n\"]+)/g)) addFile(match[1]);
    for (const match of raw.matchAll(/[A-Za-z]:\\[^\"\r\n]+?\.(?:js|ts|tsx|jsx|py|rs|go|java|html|css|json|toml|md|sql|ps1|yaml|yml)/g)) addFile(match[0]);
  }
  const objective = userMessages.at(-1) || '继续当前任务';
  const priorRequests = userMessages.slice(-4, -1);
  const completed = assistantMessages.slice(-5);
  const fileList = [...files].filter(item => {
    const absolute = path.isAbsolute(item) ? item : path.resolve(overview.workspacePath || process.cwd(), item);
    return fs.existsSync(absolute);
  }).slice(-20);
  const lines = [
    '# YoonCode 新对话续聊包',
    '',
    '## 当前目标',
    objective,
    '',
    '## 原对话状态',
    `- 模型：${overview.model}`,
    `- 上下文：${Math.round(overview.contextPercent)}%（${overview.currentContextTokens} / ${overview.contextWindow} token）`,
    `- 工作目录：${overview.workspacePath || '未识别'}`,
    `- 会话：${overview.title || overview.sessionId || '所选对话'}`,
    '',
    '## 最近的需求脉络',
    ...(priorRequests.length ? priorRequests.map(item => `- ${item}`) : ['- 无额外历史需求']),
    '',
    '## 最近完成或确认的内容',
    ...(completed.length ? completed.map(item => `- ${item}`) : ['- 请从原对话记录继续确认']),
    '',
    '## 相关文件',
    ...(fileList.length ? fileList.map(item => `- ${item}`) : ['- 暂未从工具记录中识别到文件']),
    '',
    '## 新对话执行要求',
    '- 先阅读以上上下文并复述当前目标。',
    '- 检查工作区现状，不要重复已经完成的步骤。',
    '- 延续现有设计和数据口径，完成后进行验证。',
    '- 如果信息不足，先指出缺口再继续。',
    '',
    `请继续完成：${objective}`
  ];
  return {
    text: lines.join('\n'),
    stats: { objectives: 1, completed: completed.length, files: fileList.length, pending: 1 },
    contextPercent: Math.round(overview.contextPercent),
    sessionPath: sessionFile,
    sessionTitle: overview.title,
    generatedAt: Date.now()
  };
}

async function readGitSummary(workspacePath) {
  if (!workspacePath || !path.isAbsolute(workspacePath)) return '未识别到 Git 工作区';
  try {
    const { stdout } = await execFileAsync('git.exe', ['-C', workspacePath, 'status', '--short'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const rows = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 30);
    return rows.length ? rows.join('\n') : '工作区当前没有未提交变更';
  } catch { return '当前目录不是可读取的 Git 仓库'; }
}

async function buildBugCapsule() {
  const usage = await readUsage();
  const system = await readSystemStats();
  const capture = await takeScreenshot();
  const git = await readGitSummary(usage.workspacePath);
  const recent = (usage.replay || []).slice(-6);
  const lines = [
    '# YoonCode 故障胶囊', '',
    '## 请协助定位刚刚发生的问题',
    '请结合截图、当前对话、工作区状态和系统信息分析根因；先复述可观察到的现象，再给出验证步骤和修复方案。', '',
    '## 故障现场',
    `- 截图：${capture.path}`,
    `- 当前对话：${usage.sessionTitle}`,
    `- 模型：${usage.codexName}`,
    `- 工作目录：${usage.workspacePath || '未识别'}`,
    `- 上下文：${usage.contextWindow ? Math.round(usage.currentContextTokens / usage.contextWindow * 100) : 0}%`,
    `- CPU：${system.cpuPercent}%`,
    `- 内存：${system.memoryPercent}%`, '',
    '## 最近工作事件',
    ...(recent.length ? recent.map(item => `- ${item.title}：${item.detail}`) : ['- 暂未读取到最近事件']), '',
    '## Git 工作区状态', '```', git, '```', '',
    '## 用户补充',
    '请在这里补充：刚才执行了什么、预期结果是什么、实际发生了什么。'
  ];
  return { text: lines.join('\n'), screenshotPath: capture.path, screenshotItems: capture.items, generatedAt: Date.now(), sessionTitle: usage.sessionTitle };
}

function localDay(value = Date.now()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayStart(day = localDay()) { return new Date(`${day}T00:00:00`).getTime(); }
function getSetting(key, fallback = '') { return database?.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback; }
function setSetting(key, value) { database.prepare('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)').run(key, String(value)); }
function recordAction(type, meta = {}) {
  if (!database) return;
  database.prepare('INSERT INTO action_events(ts, type, meta) VALUES (?, ?, ?)').run(Date.now(), type, JSON.stringify(meta));
  database.prepare('DELETE FROM action_events WHERE ts < ?').run(Date.now() - 180 * 24 * 60 * 60 * 1000);
}

function roleFolder() { return path.join(app.getPath('userData'), 'roles'); }
function builtinRole() {
  return {
    id: 'builtin-yoona', name: '允儿', description: '温柔、细腻，会替你守住工作节奏。', theme: '#8391ff', builtin: true,
    sprite: 'assets/yoona-expressions.png', expressions: [],
    messages: {
      gentle: ['忙了这么久，肩膀放松一下，好不好？', '别忘了喝一点水，我会替你守着状态。', '你不必一直高效，平稳地前进也很了不起。'],
      abundant: ['今天状态很充足，我们安心创造吧。', '进度很好，也别忘了照顾自己呀。'],
      normal: ['慢慢来，我会陪你把重要的事做好。', '先完成眼前这一小步，就已经很棒了。'],
      tight: ['额度有点紧啦，我们先做最重要的事。', '别着急，留住结论比赶进度更重要。'],
      context: ['上下文快满了，我帮你把重要思路收好。', '换个新对话也没关系，我们不会从零开始。'],
      letter: ['剩下的交给明天的你吧，今晚先好好休息。', '今天的每一步都没有白走，我已经替你记住了。']
    }
  };
}

function sanitizeRole(input, forcedId = null) {
  if (!input || typeof input !== 'object') throw new Error('角色包格式无效');
  const name = cleanSnippet(input.name, 28);
  if (!name) throw new Error('角色名称不能为空');
  const theme = /^#[0-9a-fA-F]{6}$/.test(input.theme || '') ? input.theme : '#8391ff';
  const expressions = Array.isArray(input.expressions) ? input.expressions.slice(0, 5) : [];
  if (expressions.length !== 5 || expressions.some(value => !/^data:image\/(?:png|jpeg|webp);base64,/.test(value) || value.length > 4_000_000)) throw new Error('角色需要五张不超过 3MB 的 PNG、JPG 或 WebP 表情');
  const allowedMessageKeys = ['gentle', 'abundant', 'normal', 'tight', 'context', 'letter'];
  const messages = {};
  for (const key of allowedMessageKeys) {
    const values = Array.isArray(input.messages?.[key]) ? input.messages[key] : [];
    messages[key] = values.map(value => cleanSnippet(value, 120)).filter(Boolean).slice(0, 20);
  }
  if (!messages.gentle.length) messages.gentle = ['我会在这里陪你，慢慢来就好。'];
  const id = forcedId || `role-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return { format: 'yooncode-role', version: 1, id, name, description: cleanSnippet(input.description, 100), theme, builtin: false, expressions, messages };
}

async function listRoles() {
  await fsp.mkdir(roleFolder(), { recursive: true });
  const roles = [builtinRole()];
  for (const entry of await fsp.readdir(roleFolder(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(roleFolder(), entry.name), 'utf8');
      if (raw.length > 20_000_000) continue;
      const parsed = JSON.parse(raw);
      roles.push(sanitizeRole(parsed, parsed.id || path.basename(entry.name, '.json')));
    } catch {}
  }
  return roles;
}

async function saveRole(input) {
  const role = sanitizeRole(input);
  await fsp.mkdir(roleFolder(), { recursive: true });
  await fsp.writeFile(path.join(roleFolder(), `${role.id}.json`), JSON.stringify(role), 'utf8');
  return role;
}

async function currentRole() {
  const roles = await listRoles();
  return roles.find(role => role.id === getSetting('current_role', 'builtin-yoona')) || roles[0];
}

async function collectDailyInsights(day = localDay()) {
  const start = dayStart(day), end = start + 86400000;
  const files = (await walk(sessionsRoot)).filter(file => file.mtimeMs >= start && file.mtimeMs < end).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
  const achievements = [], requests = [], seen = new Set();
  for (const file of files) {
    const rows = (await tailLines(file.full, 4 * 1024 * 1024)).reverse().map(safeJson).filter(Boolean);
    for (const row of rows) {
      const timestamp = new Date(row.timestamp || 0).getTime();
      if (!(timestamp >= start && timestamp < end)) continue;
      const payload = row.payload || {};
      if (payload.type === 'user_message') {
        const value = dailySnippet(payload.message || payload.text || contentText(payload.content));
        if (value) requests.push({ text: value, at: timestamp, path: file.full });
      }
      if (payload.type === 'agent_message' || (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant')) {
        const value = dailySnippet(payload.message || payload.text || contentText(payload.content));
        const key = value.replace(/\s+/g, '').toLowerCase();
        if (value && !seen.has(key)) { seen.add(key); achievements.push({ text: value, at: timestamp }); }
      }
    }
  }
  achievements.sort((a, b) => b.at - a.at); requests.sort((a, b) => b.at - a.at);
  const allFiles = await walk(sessionsRoot);
  const activeDays = new Set(allFiles.map(file => localDay(file.mtimeMs)));
  let streak = 0, cursor = new Date(`${day}T12:00:00`);
  while (activeDays.has(localDay(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return { sessions: files.length, achievements: achievements.slice(0, 5).map(item => item.text), latestRequest: requests[0]?.text || '', latestSessionPath: requests[0]?.path || null, streak };
}

async function generateDailyLetter(force = false, day = localDay()) {
  const existing = database.prepare('SELECT payload FROM daily_letters WHERE day = ?').get(day);
  if (existing && !force) return JSON.parse(existing.payload);
  const [usage, insights, role] = await Promise.all([readUsage(), collectDailyInsights(day), currentRole()]);
  const start = dayStart(day), end = start + 86400000;
  const screenshotCount = Number(database.prepare('SELECT COUNT(*) AS count FROM screenshots WHERE created_at >= ? AND created_at < ?').get(start, end)?.count || 0);
  const actions = database.prepare('SELECT type, meta FROM action_events WHERE ts >= ? AND ts < ?').all(start, end).map(row => ({ type: row.type, meta: safeJson(row.meta) || {} }));
  const handoffCopies = actions.filter(item => item.type === 'handoff_copy').length;
  const bugCopies = actions.filter(item => item.type === 'bug_copy').length;
  const protectedCount = actions.filter(item => item.type === 'handoff_copy' && Number(item.meta.contextPercent || 0) >= 65).length;
  const riskCount = (usage.sessions || []).filter(item => item.contextPercent >= 65).length;
  const achievements = insights.achievements.length ? insights.achievements : ['今天留下了新的 Codex 工作记录，重要的过程已经被好好保存。'];
  const tomorrow = insights.latestRequest || '打开最近的记忆舱，从今天最后停下的地方继续。';
  const closingPool = role.messages?.letter?.length ? role.messages.letter : builtinRole().messages.letter;
  const closing = closingPool[Math.abs([...day].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % closingPool.length];
  const accountName = usage.username || os.userInfo().username;
  const payload = {
    day, generatedAt: Date.now(), displayName: accountName, roleId: role.id, roleName: role.name,
    greeting: `${accountName}，今天辛苦啦。`, achievements, tomorrow, closing,
    stats: { sessions: insights.sessions, achievements: achievements.length, streak: insights.streak, screenshotCount, handoffCopies, bugCopies, protectedCount, riskCount, savedExplanations: handoffCopies + bugCopies },
    sourceNote: `根据本机今日 ${insights.sessions} 个活跃对话、${screenshotCount} 张截图和 ${actions.length} 个记忆事件整理。`
  };
  database.prepare('INSERT OR REPLACE INTO daily_letters(day, generated_at, payload) VALUES (?, ?, ?)').run(day, payload.generatedAt, JSON.stringify(payload));
  recordAction('letter_generated', { day, automatic: !force });
  return payload;
}

async function companionDashboard() {
  const roles = await listRoles(), selectedId = getSetting('current_role', 'builtin-yoona');
  const letterRow = database.prepare('SELECT payload FROM daily_letters WHERE day = ?').get(localDay());
  let letter = letterRow ? JSON.parse(letterRow.payload) : null;
  const accountName = os.userInfo().username;
  if (letter && letter.displayName !== accountName) {
    letter = { ...letter, displayName: accountName, greeting: `${accountName}，今天辛苦啦。` };
    database.prepare('UPDATE daily_letters SET payload = ? WHERE day = ?').run(JSON.stringify(letter), localDay());
  }
  return { letter, roles, selectedRoleId: roles.some(role => role.id === selectedId) ? selectedId : roles[0].id, endTime: getSetting('letter_time', '18:30'), autoLetter: getSetting('auto_letter', '1') !== '0' };
}

async function maybeGenerateDailyLetter() {
  if (getSetting('auto_letter', '1') === '0') return;
  const [hour, minute] = getSetting('letter_time', '18:30').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
  if (database.prepare('SELECT 1 FROM daily_letters WHERE day = ?').get(localDay())) return;
  const letter = await generateDailyLetter(false);
  if (win && !win.isDestroyed()) win.webContents.send('companion:letter-ready', letter);
  if (Notification.isSupported()) new Notification({ title: 'YoonCode · 今天辛苦啦', body: '我已经替你把今天的工作和明天的第一步收好了。' }).show();
}

ipcMain.handle('usage:get', readUsage);
ipcMain.handle('handoff:generate', (_, sessionFile) => buildHandoffPackage(sessionFile));
ipcMain.handle('handoff:copy', (_, text, meta = {}) => { clipboard.writeText(String(text || '')); recordAction('handoff_copy', { contextPercent: Number(meta.contextPercent || 0), sessionTitle: cleanSnippet(meta.sessionTitle, 80) }); return true; });
ipcMain.handle('bug:generate', buildBugCapsule);
ipcMain.handle('bug:copy', (_, text) => { clipboard.writeText(String(text || '')); recordAction('bug_copy'); return true; });
ipcMain.handle('companion:get', companionDashboard);
ipcMain.handle('companion:generate-letter', (_, force = true) => generateDailyLetter(Boolean(force)));
ipcMain.handle('companion:settings', (_, settings = {}) => {
  if (typeof settings.endTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.endTime)) setSetting('letter_time', settings.endTime);
  if (typeof settings.autoLetter === 'boolean') setSetting('auto_letter', settings.autoLetter ? '1' : '0');
  return companionDashboard();
});
ipcMain.handle('companion:save-role', async (_, input) => { const role = await saveRole(input); setSetting('current_role', role.id); return companionDashboard(); });
ipcMain.handle('companion:select-role', async (_, roleId) => {
  const roles = await listRoles();
  if (!roles.some(role => role.id === roleId)) throw new Error('角色不存在');
  setSetting('current_role', roleId); return companionDashboard();
});
ipcMain.handle('companion:delete-role', async (_, roleId) => {
  if (!/^role-[a-zA-Z0-9-]+$/.test(roleId || '')) throw new Error('内置角色不能删除');
  const full = path.join(roleFolder(), `${roleId}.json`);
  if (fs.existsSync(full)) await fsp.unlink(full);
  if (getSetting('current_role') === roleId) setSetting('current_role', 'builtin-yoona');
  return companionDashboard();
});
ipcMain.handle('companion:import-role', async () => {
  const result = await dialog.showOpenDialog(win, { title: '安装 YoonCode 角色包', properties: ['openFile'], filters: [{ name: 'YoonCode 角色包', extensions: ['yoonpack', 'json'] }] });
  if (result.canceled || !result.filePaths[0]) return companionDashboard();
  const stat = await fsp.stat(result.filePaths[0]);
  if (stat.size > 20_000_000) throw new Error('角色包不能超过 20MB');
  const parsed = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  const role = await saveRole(parsed); setSetting('current_role', role.id); return companionDashboard();
});
ipcMain.handle('companion:export-role', async (_, roleId) => {
  const role = (await listRoles()).find(item => item.id === roleId);
  if (!role || role.builtin) throw new Error('内置角色无需导出');
  const result = await dialog.showSaveDialog(win, { title: '导出 YoonCode 角色包', defaultPath: `${role.name}.yoonpack`, filters: [{ name: 'YoonCode 角色包', extensions: ['yoonpack'] }] });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, JSON.stringify({ ...role, format: 'yooncode-role', version: 1 }), 'utf8'); return result.filePath;
});
ipcMain.handle('companion:save-card', async (_, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 25_000_000) throw new Error('协作卡片数据无效');
  const folder = path.join(app.getPath('pictures'), 'YoonCode Cards'); await fsp.mkdir(folder, { recursive: true });
  const result = await dialog.showSaveDialog(win, { title: '保存 AI 协作卡片', defaultPath: path.join(folder, `YoonCode-${localDay()}.png`), filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, Buffer.from(dataUrl.split(',')[1], 'base64')); recordAction('share_card_saved'); return result.filePath;
});
ipcMain.handle('companion:copy-card', (_, dataUrl) => { const image = nativeImage.createFromDataURL(dataUrl); if (image.isEmpty()) throw new Error('协作卡片数据无效'); clipboard.writeImage(image); recordAction('share_card_copied'); return true; });
ipcMain.handle('companion:copy-letter', (_, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('system:get', readSystemStats);
ipcMain.handle('screenshots:list', () => listScreenshots());
ipcMain.handle('screenshots:search', (_, query) => listScreenshots(query));
ipcMain.handle('screenshots:favorite', async (_, full, value) => {
  database.prepare('UPDATE screenshots SET favorite = ? WHERE path = ?').run(value ? 1 : 0, full);
  return listScreenshots();
});
ipcMain.handle('screenshots:tags', async (_, full, tags) => {
  database.prepare('UPDATE screenshots SET tags = ? WHERE path = ?').run(String(tags || '').slice(0, 300), full);
  return listScreenshots();
});
ipcMain.handle('screenshots:take', takeScreenshot);
ipcMain.handle('screenshots:region', takeRegionScreenshot);
ipcMain.handle('screenshots:open-folder', async () => shell.openPath(screenshotsDir()));
ipcMain.handle('screenshots:open', async (_, full) => shell.openPath(full));
ipcMain.handle('screenshots:copy', async (_, full) => {
  const image = nativeImage.createFromPath(full);
  if (image.isEmpty()) throw new Error('无法读取图片');
  clipboard.writeImage(image);
  return true;
});
ipcMain.handle('screenshots:save-as', async (_, full) => {
  const result = await dialog.showSaveDialog(win, { defaultPath: path.basename(full), filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
  if (result.canceled || !result.filePath) return null;
  await fsp.copyFile(full, result.filePath);
  return result.filePath;
});
ipcMain.handle('screenshots:save-annotation', async (_, sourcePath, dataUrl) => {
  const resolved = path.resolve(sourcePath);
  const root = path.resolve(screenshotsDir());
  if (!resolved.startsWith(root + path.sep)) throw new Error('截图路径无效');
  const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('标注图片数据无效');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const full = path.join(root, `annotated-${stamp}.png`);
  await fsp.writeFile(full, Buffer.from(match[1], 'base64'));
  return { ok: true, path: full, items: await listScreenshots() };
});
ipcMain.handle('screenshots:delete', async (_, full) => {
  const resolved = path.resolve(full);
  const root = path.resolve(screenshotsDir());
  if (!resolved.startsWith(root + path.sep)) throw new Error('截图路径无效');
  await fsp.unlink(resolved);
  database.prepare('DELETE FROM screenshots WHERE path = ?').run(resolved);
  return { deleted: true, items: await listScreenshots() };
});
ipcMain.handle('system:open-disk', async (_, name) => {
  if (!/^[A-Za-z]:$/.test(name)) throw new Error('磁盘路径无效');
  return shell.openPath(`${name}\\`);
});
ipcMain.handle('system:open-workspace', async (_, full) => {
  if (!full || !path.isAbsolute(full)) throw new Error('目录路径无效');
  const stat = await fsp.stat(full);
  if (!stat.isDirectory()) throw new Error('目标不是目录');
  return shell.openPath(full);
});
function manualImagePath() { return path.join(app.getPath('userData'), 'manual-cover.png'); }
function manualImageUrl() {
  const full = manualImagePath();
  return fs.existsSync(full) ? `file:///${full.replace(/\\/g, '/')}?v=${fs.statSync(full).mtimeMs}` : '';
}
ipcMain.handle('manual:get-image', () => manualImageUrl());
ipcMain.handle('manual:choose-image', async () => {
  const result = await dialog.showOpenDialog(win, { title:'选择使用手册封面配图', properties:['openFile'], filters:[{ name:'图片', extensions:['png','jpg','jpeg','webp'] }] });
  if (result.canceled || !result.filePaths[0]) return manualImageUrl();
  const image = nativeImage.createFromPath(result.filePaths[0]);
  if (image.isEmpty()) throw new Error('无法读取所选图片');
  await fsp.writeFile(manualImagePath(), image.toPNG());
  return manualImageUrl();
});
ipcMain.handle('manual:reset-image', async () => {
  const full = manualImagePath();
  if (fs.existsSync(full)) await fsp.unlink(full);
  return '';
});
ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:toggle-top', (_, value) => { win?.setAlwaysOnTop(Boolean(value)); peekWin?.setAlwaysOnTop(Boolean(value), 'screen-saver'); return Boolean(value); });
ipcMain.handle('window:set-expanded', (_, expanded) => {
  if (!win) return;
  expandedMode = Boolean(expanded);
  manualFullScreen = false;
  peekHidden = false;
  hoverHideAt = 0;
  const current = win.getBounds();
  const display = screen.getDisplayMatching(current);
  if (peekWin && !peekWin.isDestroyed()) peekWin.hide();
  win.setBounds(normalWindowBounds(display, Boolean(expanded)), true);
  if (!win.isVisible()) win.showInactive();
});
ipcMain.handle('window:set-peek', (_, hidden) => {
  return setPeekWindow(Boolean(hidden));
});
ipcMain.handle('ui:get-settings', () => ({ fontSize: fontMode() }));
ipcMain.handle('ui:set-font-size', (_, requested) => {
  const mode = FONT_SCALES[requested] ? requested : 'normal';
  setSetting('font_size', mode);
  if (!win || win.isDestroyed()) return { fontSize: mode };
  win.webContents.setZoomFactor(FONT_SCALES[mode]);
  const display = screen.getDisplayMatching(win.getBounds());
  if (manualFullScreen) {
    const area = display.workArea;
    win.setBounds({ x: area.x + 6, y: area.y + 6, width: area.width - 12, height: area.height - 12 }, true);
  } else if (peekHidden) {
    const width = normalWindowBounds(display, false).width;
    peekWin?.setBounds({ x: display.workArea.x + Math.round((display.workArea.width - width) / 2), y: display.workArea.y, width, height: PEEK_HEIGHT }, false);
  } else win.setBounds(normalWindowBounds(display, expandedMode), true);
  return { fontSize: mode };
});
ipcMain.handle('window:set-manual-fullscreen', (_, value) => {
  if (!win || win.isDestroyed()) return false;
  manualFullScreen = Boolean(value);
  const display = screen.getDisplayMatching(win.getBounds());
  if (manualFullScreen) {
    expandedMode = true; peekHidden = false; hoverHideAt = 0;
    if (peekWin && !peekWin.isDestroyed()) peekWin.hide();
    const area = display.workArea;
    win.setBounds({ x: area.x + 6, y: area.y + 6, width: area.width - 12, height: area.height - 12 }, true);
    if (!win.isVisible()) win.show();
  } else win.setBounds(normalWindowBounds(display, true), true);
  return manualFullScreen;
});
ipcMain.handle('window:close', () => win?.close());

app.whenReady().then(() => {
  initDatabase(); createWindow(); startWatching();
  startNativeHoverMonitor();
  systemTimer = setInterval(publishSystemStats, 2000);
  companionTimer = setInterval(() => maybeGenerateDailyLetter().catch(() => {}), 60000);
  setTimeout(() => maybeGenerateDailyLetter().catch(() => {}), 5000);
  globalShortcut.register('CommandOrControl+Alt+S', async () => {
    const result = await takeRegionScreenshot().catch(() => null);
    if (result?.items && win && !win.isDestroyed()) win.webContents.send('screenshots:update', result.items);
  });
  globalShortcut.register('CommandOrControl+Alt+F', async () => {
    const result = await takeScreenshot().catch(() => null);
    if (result?.items && win && !win.isDestroyed()) win.webContents.send('screenshots:update', result.items);
  });
  globalShortcut.register('CommandOrControl+Alt+B', async () => {
    const result = await buildBugCapsule().catch(() => null);
    if (!result || !win || win.isDestroyed()) return;
    clipboard.writeText(result.text);
    win.webContents.send('bug:ready', result);
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { watcher?.close(); clearTimeout(refreshTimer); clearInterval(systemTimer); clearInterval(hoverTimer); clearInterval(companionTimer); globalShortcut.unregisterAll(); });
