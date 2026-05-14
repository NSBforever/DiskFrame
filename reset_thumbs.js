const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'diskframe', 'diskframe.db');
const db = new Database(dbPath);
db.prepare('UPDATE files SET thumb = NULL').run();
console.log('Done - reset all thumbs to NULL');
console.log('Restart the app now and click your drive');
