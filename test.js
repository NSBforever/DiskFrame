const fs = require('fs');
const path = require('path');
let count = 0;
function walk(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && ['.jpg','.jpeg','.png','.mp4','.mov'].includes(path.extname(e.name).toLowerCase())) {
        count++;
        if (count <= 5) console.log(path.join(dir, e.name));
      } else if (e.isDirectory() && !['Windows','Program Files','AppData','node_modules'].includes(e.name)) {
        try { walk(path.join(dir, e.name)); } catch {}
      }
    }
  } catch {}
}
walk('C:\\Users\\nagir\\Pictures');
walk('C:\\Users\\nagir\\Downloads');
walk('C:\\Users\\nagir\\Documents');
console.log('Total found:', count);