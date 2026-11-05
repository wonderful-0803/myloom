/** Standalone hub entry. TLS terminates at the operator's reverse proxy; default bind is loopback. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SyncDatabase } from './database.ts'
import { SyncHub, syncServer } from './hub.ts'
const file=process.env.LOOM_SYNC_BOOTSTRAP_FILE
if(!file) throw new Error('设置 LOOM_SYNC_BOOTSTRAP_FILE 为权限受保护的初始化凭据文件。')
const db=new SyncDatabase(resolve(process.env.LOOM_SYNC_DATA??'./loom-sync-data','hub.sqlite'))
const server=syncServer(new SyncHub(db,readFileSync(file,'utf8').trim()))
server.requestTimeout=30_000;server.headersTimeout=15_000
server.listen(Number(process.env.LOOM_SYNC_PORT??7421),process.env.LOOM_SYNC_HOST??'127.0.0.1',()=>process.stdout.write('Loom sync hub ready\n'))
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>{db.close();process.exit(0)}))
