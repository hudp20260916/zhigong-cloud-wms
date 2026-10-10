import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** SQLite 数据文件位置 */
  dbFile: process.env.DB_FILE ?? path.resolve(__dirname, '../data/app.db'),
  /** JWT 签名密钥；生产环境务必通过环境变量覆盖 */
  jwtSecret: process.env.JWT_SECRET ?? 'zhigong-cloud-wms-dev-secret',
  /** token 有效期（秒）：8 小时 */
  tokenTtl: 8 * 60 * 60,
  serverRoot: path.resolve(__dirname, '..'),
};
