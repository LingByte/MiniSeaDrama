/** 把 src/lib/data.ts 转译成 CJS 供后端复用种子数据（构建期执行一次，保证前后端种子一致） */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const r = spawnSync('npx', ['tsc', 'src/lib/data.ts', '--outDir', 'server', '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--moduleResolution', 'node'], { cwd: root, stdio: 'inherit', shell: true })
if (r.status !== 0) process.exit(r.status ?? 1)
fs.renameSync(path.join(root, 'server/data.js'), path.join(root, 'server/seed.cjs'))
console.log('server/seed.cjs 已生成')
