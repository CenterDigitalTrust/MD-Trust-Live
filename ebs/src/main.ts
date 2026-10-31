import {Pool} from 'pg';
import {loadConfig} from './config.ts';
import {buildServer} from './server.ts';
import {registerLive} from './live.ts';
import {registerGiveaway} from './giveaway.ts';
import {anchorOnce,verifyAnchor,anchorCoversEvents} from './anchor.ts';

try {
  // Startup errors are fatal; database credentials never enter application logs.
  process.loadEnvFile?.('.env');
} catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT') {console.error('Unable to load .env');process.exit(1);}
}
try {
  const config=loadConfig();
  const pool=new Pool({connectionString:config.databaseUrl,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});
  pool.on('error',()=>{console.error('Idle database connection failed');});
  const app=await buildServer(config,async()=>{await pool.query('SELECT 1');});
  await registerLive(app,pool,config);
  await registerGiveaway(app,pool,config);
  app.get('/v1/verify/:session_id',async(request,reply)=>{
    // Reuse the public export snapshot, then independently fetch ledger evidence.
    const id=(request.params as {session_id:string}).session_id;
    const response=await app.inject({method:'GET',url:'/v1/export/'+encodeURIComponent(id)});
    if(response.statusCode!==200)return reply.code(response.statusCode).send(response.json());
    const data=response.json();
    const anchors=[];
    const next=new Map<string,number>();
    for(const anchor of data.anchors) {
      const coverage=anchorCoversEvents(anchor,data.events,next.get(anchor.cluster)??0);
      const checked=coverage?await verifyAnchor(anchor,process.env.SOLANA_PUBLIC_KEY??''):{verified:false,reason:'event_range_or_root_mismatch'};
      anchors.push({...anchor,...checked});next.set(anchor.cluster,anchor.to_seq+1);
    }
    const cluster=process.env.SOLANA_CLUSTER??'devnet',current=anchors.filter(anchor=>anchor.cluster===cluster);
    return {session_id:id,cluster,chain:data.verification,anchors,fully_anchored:data.verification.ok&&current.length>0&&current.every(a=>a.verified)&&next.get(cluster)===Number(data.session.event_count)};
  });
  if(process.env.ANCHOR_ENABLED==='true') {
    // Limit scheduled work to one anchor per tick; RESULT requests an immediate attempt.
    const run=(id?:string)=>{anchorOnce(pool,id).then(result=>app.log.info(result,'Anchor cycle')).catch(()=>app.log.warn('Anchor cycle failed; inspect RPC and wallet configuration'));};
    const timer=setInterval(()=>run(),300000);
    app.server.on('mdtl:result',run);
    app.addHook('onClose',async()=>{clearInterval(timer);app.server.off('mdtl:result',run);});
  }
  app.addHook('onClose',async()=>{await pool.end();});
  for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{
    // Drain connections before exiting during deployment or local shutdown.
    app.close().catch(()=>{process.exitCode=1;});
  });
  await app.listen({host:config.host,port:config.port});
} catch(error) {console.error('EBS startup failed:',error instanceof Error?error.message:'Unknown error');process.exitCode=1;}
