const DB_NAME = "wrap_sqlite";
const IDB_KEY = "wrap_sqlite_db";
const SYNC_KEY = "wrap_sync_queue";
const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js";
const SP_SITE = "dxcportal.sharepoint.com,c1b2d8ac-0660-4808-90ab-d72c546fd10c,f286ea24-576d-4a2a-9999-8689e378a229";
const CLIENT_ID = "49cd2be1-1a88-4b8a-b38f-3db0edc3eb41";
const TENANT_ID = "93f33571-550f-43cf-b09f-cd331338d086";
const SP_LISTS = {
  users: "WRAP_Users",
  allocations: "WRAP_WorkAllocations",
  activities: "WRAP_ActivityMaster",
  ipl: "WRAP_IPLEntries",
  leaves: "WRAP_LeaveRequests",
  events: "WRAP_CalendarEvents"
};
function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveQueue(q) {
  localStorage.setItem(SYNC_KEY, JSON.stringify(q));
}
function enqueue(job) {
  const q = loadQueue();
  q.push({ ...job, id: crypto.randomUUID(), ts: Date.now() });
  saveQueue(q);
}
async function idbSave(data) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("db");
    req.onsuccess = () => {
      const tx = req.result.transaction("db", "readwrite");
      tx.objectStore("db").put(data, IDB_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  });
}
async function idbLoad() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("db");
    req.onsuccess = () => {
      const tx = req.result.transaction("db", "readonly");
      const get = tx.objectStore("db").get(IDB_KEY);
      get.onsuccess = () => res(get.result || null);
      get.onerror = () => rej(get.error);
    };
    req.onerror = () => rej(req.error);
  });
}
let _SQL = null;
let _db = null;
let _ready = false;
let _readyPromise = null;
async function loadSqlJs() {
  if (_SQL) return _SQL;
  return new Promise((res, rej) => {
    if (window.initSqlJs) {
      res(window.initSqlJs);
      return;
    }
    const s = document.createElement("script");
    s.src = SQL_JS_CDN;
    s.onload = () => res(window.initSqlJs);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}
async function getSQLiteDB() {
  if (_db && _ready) return _db;
  if (_readyPromise) {
    await _readyPromise;
    return _db;
  }
  _readyPromise = (async () => {
    const initSqlJs = await loadSqlJs();
    _SQL = await initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
    });
    const saved = await idbLoad();
    _db = saved ? new _SQL.Database(saved) : new _SQL.Database();
    _db.run(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS allocations (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS ipl (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS leaves (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS schemas (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS prod_forms (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS special_handling (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
      CREATE TABLE IF NOT EXISTS saved_queries (id TEXT PRIMARY KEY, data TEXT NOT NULL, synced INTEGER DEFAULT 0, ts INTEGER);
    `);
    await persist();
    _ready = true;
  })();
  await _readyPromise;
  return _db;
}
async function persist() {
  if (!_db) return;
  const data = _db.export();
  await idbSave(data);
}
class SQLiteAdapter {
  async db() {
    return getSQLiteDB();
  }
  tbl(table) {
    return table.replace(/[^a-z0-9_]/gi, "_");
  }
  async getAll(table) {
    const db = await this.db();
    const tbl = this.tbl(table);
    try {
      const res = db.exec(`SELECT data FROM ${tbl} ORDER BY ts ASC`);
      if (!res[0]) return [];
      return res[0].values.map((r) => JSON.parse(r[0]));
    } catch {
      return [];
    }
  }
  async getById(table, id) {
    var _a;
    const db = await this.db();
    const tbl = this.tbl(table);
    try {
      const res = db.exec(`SELECT data FROM ${tbl} WHERE id = ?`, [String(id)]);
      if (!((_a = res[0]) == null ? void 0 : _a.values[0])) return null;
      return JSON.parse(res[0].values[0][0]);
    } catch {
      return null;
    }
  }
  async create(table, data) {
    const db = await this.db();
    const tbl = this.tbl(table);
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const record = { ...data, id };
    const json = JSON.stringify(record);
    db.run(
      `INSERT OR REPLACE INTO ${tbl} (id, data, synced, ts) VALUES (?, ?, 0, ?)`,
      [id, json, Date.now()]
    );
    await persist();
    enqueue({ op: "create", table, recordId: id, data: record });
    triggerSync();
    return record;
  }
  async update(table, id, data) {
    const db = await this.db();
    const tbl = this.tbl(table);
    const existing = await this.getById(table, id);
    const merged = { ...existing, ...data, id };
    const json = JSON.stringify(merged);
    db.run(
      `INSERT OR REPLACE INTO ${tbl} (id, data, synced, ts) VALUES (?, ?, 0, ?)`,
      [String(id), json, Date.now()]
    );
    await persist();
    enqueue({ op: "update", table, recordId: id, data: merged });
    triggerSync();
  }
  async remove(table, id) {
    const db = await this.db();
    const tbl = this.tbl(table);
    db.run(`DELETE FROM ${tbl} WHERE id = ?`, [String(id)]);
    await persist();
    enqueue({ op: "delete", table, recordId: id });
    triggerSync();
  }
  async query(table, filters) {
    const all = await this.getAll(table);
    return all.filter(
      (r) => Object.entries(filters).every(([k, v]) => r[k] === v)
    );
  }
}
let _spToken = null;
let _syncRunning = false;
let _spReachable = null;
async function getSpToken() {
  if (_spToken) return _spToken;
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: CLIENT_ID,
          scope: "https://graph.microsoft.com/.default"
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    _spToken = data.access_token;
    setTimeout(() => {
      _spToken = null;
    }, (data.expires_in - 60) * 1e3);
    return _spToken;
  } catch {
    return null;
  }
}
async function checkSpReachable() {
  try {
    const token = await getSpToken();
    if (!token) return false;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${SP_SITE}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);
    _spReachable = (res == null ? void 0 : res.ok) === true;
    return _spReachable;
  } catch {
    _spReachable = false;
    return false;
  }
}
async function spPost(list, fields, token) {
  return fetch(
    `https://graph.microsoft.com/v1.0/sites/${SP_SITE}/lists/${list}/items`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    }
  );
}
async function spPatch(list, spId, fields, token) {
  return fetch(
    `https://graph.microsoft.com/v1.0/sites/${SP_SITE}/lists/${list}/items/${spId}/fields`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(fields)
    }
  );
}
async function spDelete(list, spId, token) {
  return fetch(
    `https://graph.microsoft.com/v1.0/sites/${SP_SITE}/lists/${list}/items/${spId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
}
function toSpFields(table, data) {
  const d = { ...data };
  delete d.id;
  delete d._spId;
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "object" && v !== null) d[k] = JSON.stringify(v);
    if (typeof v === "boolean") d[k] = v ? "true" : "false";
  }
  d.WrapId = String(data.id || "");
  d.Title = data.title || data.activityName || data.name || data.userName || "Record";
  return d;
}
async function flushSyncQueue() {
  var _a, _b;
  if (_syncRunning) return { synced: 0, failed: 0 };
  _syncRunning = true;
  const reachable = await checkSpReachable();
  if (!reachable) {
    _syncRunning = false;
    return { synced: 0, failed: 0 };
  }
  const token = await getSpToken();
  if (!token) {
    _syncRunning = false;
    return { synced: 0, failed: 0 };
  }
  const queue = loadQueue();
  if (queue.length === 0) {
    _syncRunning = false;
    return { synced: 0, failed: 0 };
  }
  let synced = 0, failed = 0;
  const remaining = [];
  for (const job of queue) {
    const spList = SP_LISTS[job.table];
    if (!spList) {
      synced++;
      continue;
    }
    try {
      if (job.op === "create" && job.data) {
        const fields = toSpFields(job.table, job.data);
        const res = await spPost(spList, fields, token);
        if (res.ok) {
          const created = await res.json();
          const db = await getSQLiteDB();
          const existing = db.exec(`SELECT data FROM ${job.table} WHERE id = ?`, [String(job.recordId)]);
          if ((_a = existing[0]) == null ? void 0 : _a.values[0]) {
            const rec = JSON.parse(existing[0].values[0][0]);
            rec._spId = created.id;
            db.run(
              `UPDATE ${job.table} SET data = ?, synced = 1 WHERE id = ?`,
              [JSON.stringify(rec), String(job.recordId)]
            );
            await persist();
          }
          synced++;
        } else {
          remaining.push(job);
          failed++;
        }
      } else if (job.op === "update" && job.data) {
        const spId = job.data._spId;
        if (spId) {
          const fields = toSpFields(job.table, job.data);
          const res = await spPatch(spList, spId, fields, token);
          if (res.ok) {
            synced++;
          } else {
            remaining.push(job);
            failed++;
          }
        } else {
          synced++;
        }
      } else if (job.op === "delete") {
        const spId = (_b = job.data) == null ? void 0 : _b._spId;
        if (spId) {
          const res = await spDelete(spList, spId, token);
          if (res.ok || res.status === 404) {
            synced++;
          } else {
            remaining.push(job);
            failed++;
          }
        } else {
          synced++;
        }
      }
    } catch {
      remaining.push(job);
      failed++;
    }
  }
  saveQueue(remaining);
  _syncRunning = false;
  window.dispatchEvent(new CustomEvent("wrap-sync-complete", { detail: { synced, failed, pending: remaining.length } }));
  return { synced, failed };
}
let _syncTimer = null;
function triggerSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => flushSyncQueue(), 3e3);
}
function startBackgroundSync(intervalMs = 3e4) {
  flushSyncQueue();
  const id = setInterval(flushSyncQueue, intervalMs);
  window.addEventListener("online", () => flushSyncQueue());
  return () => clearInterval(id);
}
export {
  SQLiteAdapter,
  flushSyncQueue,
  getSQLiteDB,
  startBackgroundSync,
  triggerSync
};
