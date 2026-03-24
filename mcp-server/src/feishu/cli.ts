// 飞书同步 CLI 入口
// npm run feishu-auth   — 授权
// npm run feishu-sync   — 同步消息

import { startOAuth } from './oauth-server'
import { syncFeishu } from './sync'

const cmd = process.argv[2]

if (cmd === 'auth') {
  console.log('启动飞书 OAuth 授权...')
  startOAuth()
    .then(() => {
      console.log('✅ 授权成功，运行 npm run feishu-sync 开始同步')
      process.exit(0)
    })
    .catch((err) => {
      console.error('❌ 授权失败:', err.message)
      process.exit(1)
    })
} else if (cmd === 'sync') {
  syncFeishu((msg) => process.stdout.write(msg + '\n'))
    .then((result) => {
      if (result.errors.length > 0) {
        console.error('\n错误详情:')
        result.errors.forEach(e => console.error(' -', e))
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error('❌ 同步失败:', err.message)
      process.exit(1)
    })
} else {
  console.log('用法:')
  console.log('  npx ts-node src/feishu/cli.ts auth   # 飞书 OAuth 授权')
  console.log('  npx ts-node src/feishu/cli.ts sync   # 同步消息到本地数据库')
  process.exit(1)
}
