import fs from 'node:fs';
import { config } from '../config.js';

/** 清空数据文件，下次启动自动重建并写入演示数据 */
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${config.dbFile}${suffix}`;
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`[db] 已删除 ${file}`);
  }
}
console.log('[db] 重置完成，执行 npm run dev:server 后自动重建');
