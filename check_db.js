const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'diskframe', 'diskframe.db');
const db = new Database(dbPath);
const withThumb = db.prepare('SELECT COUNT(*) as c FROM files WHERE thumb IS NOT NULL').get();
const withoutThumb = db.prepare('SELECT COUNT(*) as c FROM files WHERE thumb IS NULL').get();
console.log('With thumb:', withThumb.c);
console.log('Without thumb:', withoutThumb.c);
