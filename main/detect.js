// Auto-detect emulators, ROM folders, Steam and media apps.
const path = require('path');
const { execFile } = require('child_process');
const { CONSOLES, APPS, SEARCH_ROOTS, ROM_ROOT_NAMES } = require('./systems');
const { expand, isFile, isDir, readDir, findFile, appRoot } = require('./paths');

// (1.82) Each folder searched is listed once, two folders deep, and every console and app looks its program names up in
// that list: the same answer as findFile (the first match, breadth first), without walking the Desktop, Downloads and
// Documents again for each of a dozen consoles while the setup window waits.
// (beta.12, Linux) what a folder entry really is: Flatpak puts its programs in exports/bin as links (org.libretro.RetroArch
// -> ../app/...), EmuDeck links folders too; a link was neither a file nor a folder here, so every Flatpak emulator was
// missed. Windows keeps its own answer (junctions aren't followed there)
const LINKS = process.platform !== 'win32';
function kind(full, ent) {
  if (ent.isFile()) return 'file'; if (ent.isDirectory()) return 'dir';
  if (LINKS && ent.isSymbolicLink()) { try { const s = require('fs').statSync(full); return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : ''; } catch { return ''; } }
  return '';
}
function makeIndex(maxDepth = 2) {
  const cache = new Map();
  return dir => {
    const key = dir.toLowerCase(); let m = cache.get(key); if (m) return m;
    m = new Map(); let seq = 0; const queue = [[dir, 0]];
    while (queue.length) {
      const [d, depth] = queue.shift();
      for (const ent of readDir(d)) {
        const full = path.join(d, ent.name), k0 = kind(full, ent);
        if (k0 === 'file') { const k = ent.name.toLowerCase(); if (!m.has(k)) m.set(k, { full, seq: seq++ }); }
        else if (k0 === 'dir' && depth < maxDepth && !ent.name.startsWith('.')) queue.push([full, depth + 1]);
      }
    }
    cache.set(key, m); return m;
  };
}
function findIn(index, dir, exeNames) {
  const m = index(dir); let best = null;
  for (const n of exeNames) {
    if (n.startsWith('re:')) { // (Linux) a pattern, for versioned AppImage names: "re:^duckstation.*\.appimage$"
      const re = new RegExp(n.slice(3), 'i');
      for (const [k, h] of m) if (re.test(k) && (!best || h.seq < best.seq)) best = h;
      continue; }
    const h = m.get(n.toLowerCase()); if (h && (!best || h.seq < best.seq)) best = h; }
  return best ? best.full : null;
}
// (Linux) SD cards and USB drives: /run/media/<user>/<card> (SteamOS, most desktops), /run/media/mmcblk0p1 (older SteamOS),
// /media/<user>/<card> (Ubuntu). Each card, and its Emulation and retrodeck folders, is searched like the home folder.
function mediaRoots() {
  if (process.platform !== 'linux') return [];
  const out = [], user = require('os').userInfo().username;
  for (const base of ['/run/media/' + user, '/run/media', '/media/' + user]) {
    for (const ent of readDir(base)) { if (!ent.isDirectory() || ent.name === user) continue; const d = path.join(base, ent.name); out.push(d, path.join(d, 'Emulation'), path.join(d, 'retrodeck')); }
  }
  return [...new Set(out)];
}
const searchRoots = () => [...SEARCH_ROOTS.map(expand), ...mediaRoots()];

function findExe(folders, exeNames, index = makeIndex()) {
  for (const f of folders) {
    const dir = expand(f);
    if (!isDir(dir)) continue;
    const hit = findIn(index, dir, exeNames);
    if (hit) return hit;
  }
  // Portable copies in common places (e.g. Desktop\Emulators\Dolphin-x64\Dolphin.exe)
  for (const root of searchRoots()) {
    if (!isDir(root)) continue;
    const hit = findIn(index, root, exeNames);
    if (hit) return hit;
  }
  return null;
}

// Look for "<root>\ROMS\<system>" style folders.
function findRomDirs(sys) {
  const found = new Set();
  const roots = [appRoot(), ...searchRoots()];
  for (const root of roots) {
    if (!isDir(root)) continue;
    const candidates = [root];
    for (const ent of readDir(root)) {
      if (kind(path.join(root, ent.name), ent) === 'dir' && ROM_ROOT_NAMES.includes(ent.name.toLowerCase())) candidates.push(path.join(root, ent.name));
    }
    for (const c of candidates) {
      for (const ent of readDir(c)) {
        if (kind(path.join(c, ent.name), ent) === 'dir' && sys.romFolderNames.includes(ent.name.toLowerCase())) found.add(path.join(c, ent.name)); // (a linked folder counts: EmuDeck's roms on an SD card)
      }
    }
  }
  return [...found];
}

function regQuery(key, value) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(new RegExp(value + '\\s+REG_\\w+\\s+(.+)', 'i'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function findSteam() {
  // (Linux) Steam's own folder (the one with steamapps): native, the Steam Deck's, or the Flatpak's
  if (process.platform === 'linux') {
    for (const p of ['%HOME%/.steam/steam', '%HOME%/.local/share/Steam', '%HOME%/.var/app/com.valvesoftware.Steam/.local/share/Steam'].map(expand))
      if (isDir(path.join(p, 'steamapps'))) { try { return require('fs').realpathSync(p); } catch { return p; } }
    return null;
  }
  const reg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const options = [reg && reg.replace(/\//g, '\\'), expand('%ProgramFiles(x86)%\\Steam'), expand('%ProgramFiles%\\Steam'), 'C:\\Steam', 'D:\\Steam'];
  for (const p of options) if (p && isFile(path.join(p, 'steam.exe'))) return p;
  return null;
}

// (fr) Disques de la machine (Windows): lettres existantes, pour que l'assistant demande où chercher.
function listDrives() {
  if (process.platform !== 'win32') return [];
  const out = [], sys = String(process.env.SystemDrive || 'C:').replace(':', '').toUpperCase();
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    try { require('fs').readdirSync(l + ':\\'); out.push({ letter: l, path: l + ':\\', system: l === sys }); } catch { /* absent ou illisible */ }
  }
  return out;
}

// (fr) Recherche en profondeur sur les disques choisis: émulateurs (par nom de programme) et dossiers de jeux (par nom de
// console, seulement s'ils sont dans un chemin qui parle de roms / jeux / émulation). Cherche d'abord près de la racine.
const DRIVE_SKIP = new Set(['windows', '$recycle.bin', 'system volume information', 'node_modules', 'appdata', 'programdata', 'winsxs', 'recovery', 'perflogs', '$windows.~bt', 'msocache', '.git']);
const ROMISH = ['rom', 'game', 'iso', 'emul', 'retro', 'batocera', 'recalbox', 'jeux'];
async function scanDrives(drives) {
  const names = new Map(), pats = [];
  for (const s of CONSOLES) for (const n of (s.exeNames || [])) {
    if (n.startsWith('re:')) { try { pats.push([new RegExp(n.slice(3), 'i'), s.id]); } catch { /* ignore */ } }
    else { const k = n.toLowerCase(); if (!names.has(k)) names.set(k, []); names.get(k).push(s.id); }
  }
  const romNames = new Map();
  for (const s of CONSOLES) for (const n of (s.romFolderNames || [])) { const k = n.toLowerCase(); if (!romNames.has(k)) romNames.set(k, []); romNames.get(k).push(s.id); }
  const systems = {}, get = id => (systems[id] = systems[id] || { emulator: null, romDirs: [] });
  let steps = 0;
  for (const dr of drives || []) {
    const root = String(dr || '').replace(/[\\/]*$/, '') + '\\';
    if (!/^[A-Za-z]:\\$/.test(root) || !isDir(root)) continue;
    const queue = [[root, 0, false]], t0 = Date.now(); let seen = 0;
    while (queue.length && seen < 400000 && Date.now() - t0 < 180000) {
      const [d, depth, romish] = queue.shift();
      seen++;
      if (++steps % 300 === 0) await new Promise(r => setImmediate(r)); // laisse respirer le programme
      for (const ent of readDir(d)) {
        const full = path.join(d, ent.name), low = ent.name.toLowerCase(), k0 = kind(full, ent);
        if (k0 === 'file') {
          for (const id of (names.get(low) || [])) { const e = get(id); if (!e.emulator) e.emulator = full; }
          if (low.endsWith('.exe')) for (const [re, id] of pats) if (re.test(low)) { const e = get(id); if (!e.emulator) e.emulator = full; }
        } else if (k0 === 'dir' && !DRIVE_SKIP.has(low) && !low.startsWith('$')) {
          const isRomish = romish || ROMISH.some(w => low.includes(w));
          const ids = romNames.get(low);
          if (ids && romish) { for (const id of ids) { const e = get(id); if (!e.romDirs.includes(full)) e.romDirs.push(full); } continue; }
          if (depth < 5) queue.push([full, depth + 1, isRomish]);
        }
      }
    }
  }
  return systems;
}

async function detectAll(drives) {
  const systems = {}, index = makeIndex();
  for (const s of CONSOLES) {
    systems[s.id] = { emulator: findExe(s.emulatorFolders, s.exeNames, index), romDirs: findRomDirs(s) };
  }
  if (Array.isArray(drives) && drives.length) {
    const extra = await scanDrives(drives);
    for (const [id, e] of Object.entries(extra)) {
      const s = systems[id]; if (!s) continue;
      if (!s.emulator && e.emulator) s.emulator = e.emulator;
      for (const d of e.romDirs) if (!s.romDirs.some(x => x.toLowerCase() === d.toLowerCase())) s.romDirs.push(d);
    }
  }
  const apps = {};
  for (const a of APPS) apps[a.id] = { path: findExe(a.folders, a.exeNames, index) };
  return { systems, apps, steam: { path: await findSteam() }, appRoot: appRoot() };
}

// one console's emulator and games folders (a console added in an update, found once as setup would have)
function detectSystem(id) { const s = CONSOLES.find(c => c.id === id); return s ? { emulator: findExe(s.emulatorFolders, s.exeNames), romDirs: findRomDirs(s) } : null; }

// (fr) Scan d'un dossier choisi par l'utilisateur (ex. retrobat\emulators): chaque console y cherche son émulateur, jusqu'à 4
// niveaux de profondeur. Renvoie { systems: { id: chemin }, count }.
function scanEmulatorFolder(root) {
  const dir = expand(String(root || ''));
  if (!dir || !isDir(dir)) return { error: 'Folder not found', systems: {}, count: 0 };
  const index = makeIndex(4), systems = {};
  for (const s of CONSOLES) {
    const hit = findIn(index, dir, s.exeNames);
    if (hit) systems[s.id] = hit;
  }
  return { systems, count: Object.keys(systems).length, root: dir };
}

// (fr) Scan d'un dossier de ROMs: les sous-dossiers (jusqu'à 3 niveaux) dont le nom est celui d'une console (gc, wii, ps2,
// psx, megadrive...) deviennent ses dossiers de jeux. Renvoie { systems: { id: [dossiers] }, count }.
function scanRomFolder(root) {
  const dir = expand(String(root || ''));
  if (!dir || !isDir(dir)) return { error: 'Folder not found', systems: {}, count: 0 };
  const byName = new Map();
  for (const s of CONSOLES) for (const n of (s.romFolderNames || [])) { const k = n.toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(s.id); }
  const systems = {}, queue = [[dir, 0]];
  const add = (id, d) => { (systems[id] = systems[id] || []); if (!systems[id].includes(d)) systems[id].push(d); };
  while (queue.length) {
    const [d, depth] = queue.shift();
    for (const ent of readDir(d)) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (kind(full, ent) !== 'dir') continue;
      const ids = byName.get(ent.name.toLowerCase());
      if (ids) { for (const id of ids) add(id, full); continue; } // un dossier de console: on ne descend pas dedans
      if (depth < 2) queue.push([full, depth + 1]);
    }
  }
  // un nom partagé par plusieurs consoles (ex. "fbneo": arcade) n'est gardé que pour la première
  return { systems, count: Object.keys(systems).length, root: dir };
}

module.exports = { detectAll, detectSystem, findSteam, scanEmulatorFolder, scanRomFolder, listDrives };
