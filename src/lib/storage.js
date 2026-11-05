// Browser persistence: small settings in localStorage; known words, saved shows and the API cache in IndexedDB.
//
// Every project page on <user>.github.io shares one origin, so all keys are prefixed to avoid clashes.

const PREFIX = 'subtitle-flashcards:';
const DB_NAME = 'subtitle-flashcards';

export const settings = {
  get(name, fallback = '') {
    try { return localStorage.getItem(PREFIX + name) ?? fallback; } catch { return fallback; }
  },
  set(name, value) {
    try {
      if (value) localStorage.setItem(PREFIX + name, value);
      else localStorage.removeItem(PREFIX + name);
    } catch { /* storage blocked: setting lasts for this page only */ }
  },
};

export const session = {
  get(name) {
    try { return sessionStorage.getItem(PREFIX + name); } catch { return null; }
  },
  set(name, value) {
    try {
      if (value) sessionStorage.setItem(PREFIX + name, value);
      else sessionStorage.removeItem(PREFIX + name);
    } catch { /* ignore */ }
  },
};

// In-memory copies, loaded once by loadData() and written through to IndexedDB.
export const known = new Set();
export const cache = new Map();
export const shows = new Map(); // name -> {name, context, source, target, updatedAt}

const STORES = ['known', 'cache', 'shows'];

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function readAll(name) {
  const store = (await openDb()).transaction(name).objectStore(name);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}

/** Write [key, value] pairs; a value of undefined deletes the key. */
async function putMany(name, entries) {
  if (!entries.length) return;
  const tx = (await openDb()).transaction(name, 'readwrite');
  const store = tx.objectStore(name);
  for (const [k, v] of entries) v === undefined ? store.delete(k) : store.put(v, k);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Load known words and the cache into memory. Without IndexedDB the app still works, without persistence. */
export async function loadData() {
  try {
    const [k, c, s] = await Promise.all(STORES.map(readAll));
    for (const [word] of k) known.add(word);
    for (const [key, value] of c) cache.set(key, value);
    for (const [name, show] of s) shows.set(name, show);
    return true;
  } catch (e) {
    console.warn('IndexedDB unavailable; data will not persist.', e);
    return false;
  }
}

function persist(name, entries) {
  putMany(name, entries).catch(e => console.warn(`Could not save ${name}`, e));
}

/** Store cache entries ([key, value] pairs). */
export function cachePut(entries) {
  for (const [k, v] of entries) cache.set(k, v);
  persist('cache', entries);
}

const normalizeWord = w => String(w).trim().toLowerCase();

/** Add words to the known list; returns how many were new. */
export function addKnown(words) {
  const fresh = [...new Set(words.map(normalizeWord))].filter(w => w && !known.has(w));
  for (const w of fresh) known.add(w);
  persist('known', fresh.map(w => [w, Date.now()]));
  return fresh.length;
}

const isShow = v => v && typeof v.name === 'string' && v.name.trim() && typeof v.context === 'string';

/** Save (or replace) a show's notes under its name. */
export function saveShow({ name, context, source, target }) {
  const show = { name: name.trim(), context, source, target, updatedAt: Date.now() };
  shows.set(show.name, show);
  persist('shows', [[show.name, show]]);
  return show;
}

export function deleteShow(name) {
  shows.delete(name);
  persist('shows', [[name, undefined]]);
}

export function exportData() {
  return {
    app: 'subtitle-flashcards',
    version: 1,
    exportedAt: new Date().toISOString(),
    known: [...known].sort(),
    shows: [...shows.values()],
    cache: Object.fromEntries(cache),
  };
}

/**
 * Merge a file into the stored data. Accepts this app's JSON export, the old server's
 * translations_cache.json (a plain key -> value object), a JSON array of known words,
 * or a text file with one known word per line (# starts a comment).
 */
export function importData(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const words = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
    return { known: addKnown(words), cache: 0, shows: 0 };
  }
  let words = [], entries = [], showList = [];
  if (Array.isArray(data)) words = data;
  else if (data && typeof data === 'object') {
    if (data.app === 'subtitle-flashcards') {
      words = Array.isArray(data.known) ? data.known : [];
      entries = Object.entries(data.cache && typeof data.cache === 'object' ? data.cache : {});
      showList = Array.isArray(data.shows) ? data.shows.filter(isShow) : [];
    } else {
      entries = Object.entries(data);
    }
  } else {
    throw new Error('Unrecognised file format.');
  }
  const added = addKnown(words.filter(w => typeof w === 'string'));
  const fresh = entries.filter(([k]) => !cache.has(k));
  cachePut(fresh);
  // Shows already in this browser keep their notes.
  const newShows = showList.filter(sh => !shows.has(sh.name.trim()));
  newShows.forEach(saveShow);
  return { known: added, cache: fresh.length, shows: newShows.length };
}
