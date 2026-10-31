import {generateKeyPairSync,randomInt,randomUUID,randomBytes,sign} from 'node:crypto';
import {SignJWT} from 'jose';
import {canonicalize,sha256,eventHash,drawWinner,verifyInclusion} from '../ebs/src/mdtl/core.ts';
import type {Header,Json,SignedEvent} from '../ebs/src/mdtl/core.ts';
import {deviceMessage} from '../ebs/src/auth.ts';
import {Pool} from 'pg';

const base=process.env.EBS_URL??'http://127.0.0.1:8080';

async function request(path:string,method:string,body:unknown,authorization:string):Promise<Record<string,any>> {
  // Bound network waits and surface HTTP failures without logging credentials.
  const response=await fetch(base+path,{method,headers:{Authorization:authorization,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${data.error??'Request failed'}`);
  return data;
}

try {
  // Simulator-generated Twitch JWTs are restricted to explicitly configured test mode.
  if(process.env.REQUIRE_TWITCH_LIVE!=='false'||!process.env.TWITCH_EXTENSION_SECRET) throw new Error('Simulator requires explicit test mode and its test extension secret');
  const channel=String(randomInt(900000000,999999999));
  const jwt='Bearer '+await new SignJWT({channel_id:channel,role:'broadcaster',opaque_user_id:'Usimulator',user_id:channel}).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').sign(Buffer.from(process.env.TWITCH_EXTENSION_SECRET,'base64'));
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const code=await request('/v1/pair/code','POST',{},jwt);
  const pairingSignature=sign('sha256',Buffer.from('MDTL1-PAIR\n'+code.code),privateKey).toString('base64');
  const paired=await request('/v1/pair/complete','POST',{code:code.code,spki,signature:pairingSignature},'');
  async function device(path:string,body:unknown):Promise<Record<string,any>> {
    // Re-sign HTTP envelope on retries while preserving the event itself.
    const now=Date.now(),signature=sign('sha256',Buffer.from(deviceMessage('POST',path,now,body)),privateKey).toString('base64');
    return request(path,'POST',body,`MDTL1 device_id=${paired.device_id},ts=${now},sig=${signature}`);
  }
  let state=await device('/v1/session/start',{});
  const sessionId=state.session_id;
  let last:SignedEvent|undefined;
  for(let i=0;i<4;i++) {
    const payload:Json=i===0?{app_ver:'sim-0.1',device_id:paired.device_id,geo_enabled:false}:{batt_pct:99};
    const header:Header={v:1,channel_id:channel,session_id:sessionId,seq:state.next_seq,type:i===0?'SESSION_START':'PULSE',client_ts_ms:Date.now(),prev_hash:state.head_hash,payload_hash:sha256(canonicalize(payload)),challenge:state.next_challenge.nonce};
    const signature=sign('sha256',Buffer.from('MDTL1\n'+canonicalize(header)),privateKey).toString('base64');
    last={header,payload,signature,event_hash:eventHash(header,signature),received_at:0,challenge_issued_at:0};
    state=await device('/v1/events',last);
  }
  const duplicate=await device('/v1/events',last);
  if(!duplicate.duplicate||duplicate.next_seq!==4) throw new Error('Idempotent retry failed');
  const visible=await request('/v1/state','GET',undefined,jwt);
  if(visible.status!=='SIMULATED') throw new Error(`Unexpected status ${visible.status}`);
  console.info(JSON.stringify({test:'signed-session',status:'PASS',session_id:sessionId,events:4,duplicate_rejected_as_new:true}));
  if(process.argv.includes('--tamper')) {
    // Alter only this run's synthetic channel, verify detection, then restore it.
    const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
    let original:unknown;
    try {
      const row=await pool.query('SELECT payload_json FROM events WHERE session_id=$1 AND seq=1',[sessionId]);
      original=row.rows[0].payload_json;
      await pool.query('UPDATE events SET payload_json=$2 WHERE session_id=$1 AND seq=1',[sessionId,{batt_pct:1}]);
      const corrupted=await request('/v1/state','GET',undefined,jwt);
      if(corrupted.status!=='DATA_MISMATCH') throw new Error('Tampering was not detected');
      console.info(JSON.stringify({test:'database-tamper',status:'PASS',shield:corrupted.status}));
    } finally {
      if(original!==undefined) await pool.query('UPDATE events SET payload_json=$2 WHERE session_id=$1 AND seq=1',[sessionId,original]);
      await pool.end();
    }
  }
  if(process.argv.includes('--giveaway')) {
    // Run a full draw with three independently authenticated synthetic viewers.
    async function sendEvent(type:string,payload:Json):Promise<void> {
      const header:Header={v:1,channel_id:channel,session_id:sessionId,seq:state.next_seq,type,client_ts_ms:Date.now(),prev_hash:state.head_hash,payload_hash:sha256(canonicalize(payload)),challenge:''};
      const signature=sign('sha256',Buffer.from('MDTL1\n'+canonicalize(header)),privateKey).toString('base64');
      state=await device('/v1/events',{header,payload,signature,event_hash:eventHash(header,signature)});
    }
    const id=randomUUID(),seed=randomBytes(32).toString('hex');
    await sendEvent('GIVEAWAY_OPEN',{giveaway_id:id,prize:'Integration test prize',seed_commit:sha256(Buffer.from(seed,'hex'))});
    const viewers:string[]=[];
    for(const user of ['10','20','3']) {
      const token='Bearer '+await new SignJWT({channel_id:channel,role:'viewer',opaque_user_id:'U'+user,user_id:user}).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').sign(Buffer.from(process.env.TWITCH_EXTENSION_SECRET!,'base64'));
      viewers.push(token);await request('/v1/giveaway/enter','POST',{},token);
    }
    const frozen=await device('/v1/giveaway/lock-request',{giveaway_id:id});
    await sendEvent('GIVEAWAY_LOCK',frozen as Json);
    await sendEvent('GIVEAWAY_REVEAL',{giveaway_id:id,seed});
    const result=await device('/v1/giveaway/result-preview',{giveaway_id:id});
    if(result.winner_index!==drawWinner(seed,frozen.entries_hash,3))throw new Error('Independent draw mismatch');
    await sendEvent('GIVEAWAY_RESULT',result as Json);
    const publicResult=await request('/v1/giveaway','GET',undefined,jwt);
    const winnerLeaf=Buffer.from(`MDTL-ENTRY-1\n${id}\n${publicResult.winner_user_key}`);
    if(!verifyInclusion(winnerLeaf,publicResult.winner_index,3,publicResult.winner_proof,publicResult.entries_hash))throw new Error('Winner proof invalid');
    for(const token of viewers) {
      const proof=await request('/v1/giveaway/proof','GET',undefined,token);
      if(!verifyInclusion(Buffer.from(`MDTL-ENTRY-1\n${id}\n${proof.user_key}`),proof.index,proof.count,proof.proof,proof.root))throw new Error('Viewer inclusion proof invalid');
    }
    console.info(JSON.stringify({test:'fair-drop',status:'PASS',participants:3,winner_index:result.winner_index,proofs_verified:4}));
  }
  const payload={reason:'simulator_complete'};
  const header:Header={v:1,channel_id:channel,session_id:sessionId,seq:state.next_seq,type:'SESSION_END',client_ts_ms:Date.now(),prev_hash:state.head_hash,payload_hash:sha256(canonicalize(payload)),challenge:''};
  const signature=sign('sha256',Buffer.from('MDTL1\n'+canonicalize(header)),privateKey).toString('base64');
  await device('/v1/events',{header,payload,signature,event_hash:eventHash(header,signature)});
  console.info(JSON.stringify({test:'session-end',status:'PASS'}));
} catch(error) {console.error('Simulator failed:',error instanceof Error?error.message:'Unknown error');process.exitCode=1;}
