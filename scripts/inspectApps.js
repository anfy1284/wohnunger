const fs = require('fs');
const path = require('path');

const local = path.join(__dirname, '..', 'node_modules', 'my-old-space', 'drive_forms', 'apps.json');
const pkg = path.join(__dirname, '..', 'node_modules', 'my-old-space', 'apps.json');
const proj = path.join(process.cwd(), 'apps.json');

const sources = [];
if (fs.existsSync(local)) sources.push({ cfg: JSON.parse(fs.readFileSync(local, 'utf8')), baseDir: path.resolve(__dirname, '..', 'node_modules', 'my-old-space', 'drive_forms') });
if (fs.existsSync(pkg)) sources.push({ cfg: JSON.parse(fs.readFileSync(pkg, 'utf8')), baseDir: path.resolve(__dirname, '..', 'node_modules', 'my-old-space') });
if (fs.existsSync(proj)) sources.push({ cfg: JSON.parse(fs.readFileSync(proj, 'utf8')), baseDir: process.cwd() });

const appsMap = new Map();
for (const s of sources) {
  const cfg = s.cfg || {};
  const apps = cfg.apps || [];
  const appsPath = (cfg.path || '/apps').replace(/^[/\\]+/, '');
  for (const a of apps) {
    appsMap.set(a.name, Object.assign({}, a, { __appsBaseDir: s.baseDir, __appsPath: appsPath }));
  }
}

const list = Array.from(appsMap.values());
console.log('SOURCES:', sources.map(s => s.baseDir));
console.log('APPS:');
for (const a of list) {
  const cleanAppPath = (a.path || `/${a.name}`).replace(/^[/\\]+/, '');
  console.log('-', a.name, '->', path.resolve(a.__appsBaseDir, a.__appsPath, cleanAppPath));
}
