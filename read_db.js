const Database = require('better-sqlite3')
const db = new Database('C:/Users/nagir/AppData/Roaming/diskframe/diskframe.db')
const rows = db.prepare('SELECT path, ext, thumb FROM files WHERE ext IN (".mp4", ".mov") LIMIT 10').all()
console.log(JSON.stringify(rows, null, 2))
