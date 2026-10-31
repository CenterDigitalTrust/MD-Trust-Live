import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Config} from './config.ts';
import {authenticateDevice,authenticateTwitch} from './auth.ts';
import {canonicalize,sha256,verifySignature,verifyChain,inclusionProof} from './mdtl/core.ts';
import type {SignedEvent} from './mdtl/core.ts';
import {TwitchLiveClient} from './twitch.ts';
import {applyGiveawayEvent,verifyGiveawayRecords,entryLeaves} from './giveaway.ts';

function failure(message:string,statusCode=400):Error {
  // Attach an HTTP status while preserving a meaningful diagnostic.
  return Object.assign(new Error(message),{statusCode});
}

export async function transaction<T>(pool:Pool,action:(db:PoolClient)=>Promise<T>):Promise<T> {
  // Roll back every failed operation and always return the connection.
  const db=await pool.connect();
  try {await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}
  catch(error) {await db.query('ROLLBACK');throw error;}
  finally {db.release();}
}

export async function deviceIdentity(request:FastifyRequest,db:PoolClient):Promise<{channel_id:string;device_id:string;device_pubkey_spki:string}> {
  // Resolve only the claimed device, then verify its signature using stored SPKI.
  const id=/^MDTL1 device_id=([a-zA-Z0-9_-]{1,128}),/.exec(request.headers.authorization??'')?.[1];
  if(!id) throw failure('Device authorization required',401);
  const result=await db.query('SELECT channel_id,device_id,device_pubkey_spki FROM channels WHERE device_id=$1 FOR UPDATE',[id]);
  if(!result.rowCount) throw failure('Device not paired',401);
  const row=result.rows[0];
  authenticateDevice(request.headers.authorization,request.method,request.url,request.body,row.device_pubkey_spki);
  return row;
}

export async function readEvents(db:PoolClient,sessionId:string):Promise<SignedEvent[]> {
  // Convert PostgreSQL bigint strings explicitly before canonical checks.
  const result=await db.query('SELECT * FROM events WHERE session_id=$1 ORDER BY seq',[sessionId]);
  return result.rows.map(row=>({header:row.header_json,payload:row.payload_json,signature:row.signature,event_hash:row.event_hash,received_at:Number(row.received_at),challenge_issued_at:Number(row.challenge_issued_at)}));
}

export async function nextChallenge(db:PoolClient,sessionId:string):Promise<{nonce:string;issued_at:number}> {
  // Retain historical nonces for verification; reuse only an unexpired unused one.
  const now=Date.now();
  const existing=await db.query('SELECT nonce,issued_at FROM challenges WHERE session_id=$1 AND consumed_seq IS NULL AND issued_at>$2 ORDER BY issued_at DESC LIMIT 1',[sessionId,now-30000]);
  if(existing.rowCount) return {nonce:existing.rows[0].nonce,issued_at:Number(existing.rows[0].issued_at)};
  const nonce=randomBytes(32).toString('hex');
  await db.query('INSERT INTO challenges(nonce,session_id,issued_at) VALUES($1,$2,$3)',[nonce,sessionId,now]);
  return {nonce,issued_at:now};
}

export function checkJournal(events:SignedEvent[],session:Record<string,unknown>) {
  // Session snapshots prevent re-pairing from invalidating historical keys.
  return verifyChain(events,String(session.device_pubkey_spki),{channelId:String(session.channel_id),sessionId:String(session.session_id),expectedHead:String(session.head_hash),expectedCount:Number(session.event_count)});
}

export async function registerLive(app:FastifyInstance,pool:Pool,config:Config):Promise<void> {
  // Every mutation serializes on the channel/session row to prevent double accepts.
  const twitch=new TwitchLiveClient(process.env.TWITCH_API_CLIENT_ID??'',process.env.TWITCH_API_CLIENT_SECRET??'');
  app.post('/v1/pair/code',async request=>{
    const user=await authenticateTwitch(request.headers.authorization,config.extensionSecret,true);
    return transaction(pool,async db=>{
      await db.query('INSERT INTO channels(channel_id) VALUES($1) ON CONFLICT DO NOTHING',[user.channelId]);
      await db.query('SELECT channel_id FROM channels WHERE channel_id=$1 FOR UPDATE',[user.channelId]);
      const code=String(randomInt(100000,1000000)),expires=Date.now()+300000;
      await db.query('DELETE FROM pair_codes WHERE channel_id=$1 OR expires_at<$2',[user.channelId,Date.now()]);
      await db.query('INSERT INTO pair_codes(code_hash,channel_id,expires_at) VALUES($1,$2,$3)',[sha256(code),user.channelId,expires]);
      return {code,expires_at:expires};
    });
  });
  app.post('/v1/pair/complete',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{
    const body=request.body as {code?:string;spki?:string;signature?:string};
    if(!body||!/^\d{6}$/.test(body.code??'')||typeof body.spki!=='string'||typeof body.signature!=='string') throw failure('Invalid pairing request');
    if(!verifySignature('MDTL1-PAIR\n'+body.code,body.signature,body.spki)) throw failure('Invalid pairing signature',401);
    return transaction(pool,async db=>{
      const codes=await db.query('SELECT * FROM pair_codes WHERE code_hash=$1 AND expires_at>$2 FOR UPDATE',[sha256(body.code!),Date.now()]);
      if(!codes.rowCount) throw failure('Pairing code expired or invalid',401);
      const channelId=codes.rows[0].channel_id,deviceId=sha256(Buffer.from(body.spki!,'base64'));
      await db.query('SELECT channel_id FROM channels WHERE channel_id=$1 FOR UPDATE',[channelId]);
      const active=await db.query('SELECT session_id FROM sessions WHERE channel_id=$1 AND ended_at IS NULL',[channelId]);
      if(active.rowCount) throw failure('End the active session before pairing another device',409);
      await db.query('UPDATE channels SET device_id=$2,device_pubkey_spki=$3,paired_at=$4 WHERE channel_id=$1',[channelId,deviceId,body.spki,Date.now()]);
      await db.query('DELETE FROM pair_codes WHERE code_hash=$1',[sha256(body.code!)]);
      return {channel_id:channelId,device_id:deviceId};
    });
  });
  app.post('/v1/session/start',async request=>transaction(pool,async db=>{
    const device=await deviceIdentity(request,db);
    const requestHash=sha256(request.headers.authorization??'');
    const receipt=await db.query('SELECT response_json FROM request_receipts WHERE request_hash=$1',[requestHash]);
    if(receipt.rowCount)return receipt.rows[0].response_json;
    const existing=await db.query('SELECT * FROM sessions WHERE channel_id=$1 AND ended_at IS NULL FOR UPDATE',[device.channel_id]);
    let session=existing.rows[0];
    if(!session) {
      const id=randomUUID();
      const inserted=await db.query('INSERT INTO sessions(session_id,channel_id,device_id,device_pubkey_spki,started_at) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,device.channel_id,device.device_id,device.device_pubkey_spki,Date.now()]);
      session=inserted.rows[0];
    }
    const response={session_id:session.session_id,channel_id:device.channel_id,next_seq:session.event_count,head_hash:session.head_hash,next_challenge:await nextChallenge(db,session.session_id)};
    await db.query('DELETE FROM request_receipts WHERE expires_at<$1',[Date.now()]);
    await db.query('INSERT INTO request_receipts(request_hash,expires_at,response_json) VALUES($1,$2,$3)',[requestHash,Date.now()+120000,response]);
    return response;
  }));
  app.post('/v1/session/challenge',async request=>transaction(pool,async db=>{
    const device=await deviceIdentity(request,db);
    const session=await db.query('SELECT * FROM sessions WHERE channel_id=$1 AND ended_at IS NULL FOR UPDATE',[device.channel_id]);
    if(!session.rowCount) throw failure('No active session',404);
    const row=session.rows[0];
    return {session_id:row.session_id,next_seq:row.event_count,head_hash:row.head_hash,next_challenge:await nextChallenge(db,row.session_id)};
  }));
  app.post('/v1/events',async request=>{
    const accepted=await transaction(pool,async db=>{
    const device=await deviceIdentity(request,db);
    const incoming=request.body as SignedEvent;
    if(!incoming?.header||typeof incoming.header.session_id!=='string'||!/^[0-9a-f-]{36}$/.test(incoming.header.session_id)) throw failure('Invalid event envelope');
    const rows=await db.query('SELECT * FROM sessions WHERE session_id=$1 AND channel_id=$2 FOR UPDATE',[incoming.header.session_id,device.channel_id]);
    if(!rows.rowCount) throw failure('Unknown session',404);
    const session=rows.rows[0];
    const events=await readEvents(db,session.session_id);
    const checked=checkJournal(events,session);
    if(!checked.ok||!await verifyGiveawayRecords(db,events)) throw failure('Stored journal mismatch',409);
    if(incoming.header.seq<session.event_count) {
      const previous=events[incoming.header.seq];
      if(!previous||previous.event_hash!==incoming.event_hash||canonicalize(previous.header)!==canonicalize(incoming.header)||canonicalize(previous.payload)!==canonicalize(incoming.payload)||previous.signature!==incoming.signature) throw failure('Sequence conflict',409);
      return {ok:true,duplicate:true,event_hash:previous.event_hash,next_seq:session.event_count,head_hash:session.head_hash,next_challenge:session.ended_at?null:await nextChallenge(db,session.session_id)};
    }
    if(session.ended_at) throw failure('Session ended',409);
    if(!['SESSION_START','PULSE','SESSION_END','GIVEAWAY_OPEN','GIVEAWAY_LOCK','GIVEAWAY_REVEAL','GIVEAWAY_RESULT'].includes(incoming.header.type)) throw failure('Event type not enabled yet');
    let issued=0;
    if(['SESSION_START','PULSE'].includes(incoming.header.type)) {
      const nonce=await db.query('SELECT * FROM challenges WHERE nonce=$1 AND session_id=$2 AND consumed_seq IS NULL FOR UPDATE',[incoming.header.challenge,session.session_id]);
      if(!nonce.rowCount) throw failure('Unknown or consumed challenge',409);
      issued=Number(nonce.rows[0].issued_at);
    }
    const event:SignedEvent={header:incoming.header,payload:incoming.payload,signature:incoming.signature,event_hash:incoming.event_hash,received_at:Date.now(),challenge_issued_at:issued};
    const result=verifyChain([...events,event],session.device_pubkey_spki,{channelId:device.channel_id,sessionId:session.session_id,expectedHead:event.event_hash,expectedCount:session.event_count+1});
    if(!result.ok) throw failure(result.error??'Invalid event',409);
    await applyGiveawayEvent(db,event);
    await db.query('INSERT INTO events(session_id,seq,type,header_json,payload_json,event_hash,signature,received_at,challenge_issued_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[session.session_id,event.header.seq,event.header.type,event.header,event.payload,event.event_hash,event.signature,event.received_at,issued]);
    if(['SESSION_START','PULSE'].includes(event.header.type))await db.query('UPDATE challenges SET consumed_seq=$2 WHERE nonce=$1',[event.header.challenge,event.header.seq]);
    const ended=event.header.type==='SESSION_END';
    await db.query('UPDATE sessions SET head_hash=$2,event_count=event_count+1,ended_at=$3 WHERE session_id=$1',[session.session_id,event.event_hash,ended?event.received_at:null]);
    return {ok:true,event_hash:event.event_hash,next_seq:session.event_count+1,head_hash:event.event_hash,next_challenge:ended?null:await nextChallenge(db,session.session_id)};
    });
    if((request.body as SignedEvent)?.header?.type==='GIVEAWAY_RESULT'&&!('duplicate' in accepted))app.server.emit('mdtl:result',(request.body as SignedEvent).header.session_id);
    return accepted;
  });
  app.get('/v1/state',async request=>{
    const user=await authenticateTwitch(request.headers.authorization,config.extensionSecret);
    const live=config.requireTwitchLive?await twitch.status(user.channelId):null;
    return transaction(pool,async db=>{
      // A repeatable snapshot prevents a concurrent pulse from looking like truncation.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const rows=await db.query('SELECT * FROM sessions WHERE channel_id=$1 ORDER BY started_at DESC LIMIT 1',[user.channelId]);
      if(!rows.rowCount) return {status:'OFFLINE',reason:'no_session',mode:config.requireTwitchLive?'LIVE':'SIMULATED'};
      const session=rows.rows[0],events=await readEvents(db,session.session_id),checked=checkJournal(events,session);
      if(!await verifyGiveawayRecords(db,events)){checked.ok=false;checked.error='Giveaway evidence mismatch';}
      const last=events.filter(e=>e.header.type==='PULSE').at(-1);
      const age=last?Date.now()-last.received_at:Infinity;
      // A positive recent Helix check is mandatory for production green.
      const status=!checked.ok?'DATA_MISMATCH':session.ended_at||age>90000?'OFFLINE':age>15000?'WAITING':config.requireTwitchLive?(live?.live===true?'VERIFIED_LIVE':'WAITING'):'SIMULATED';
      return {status,reason:checked.error??(live?.reason??(live?.live===false?'channel_offline':undefined)),mode:config.requireTwitchLive?'LIVE':'SIMULATED',session_id:session.session_id,seq:Number(session.event_count)-1,head_hash:session.head_hash,last_pulse_at:last?.received_at??null,server_time:Date.now()};
    });
  });
  app.get('/v1/export/:session_id',async request=>{
    const id=(request.params as {session_id:string}).session_id;
    if(!/^[0-9a-f-]{36}$/.test(id)) throw failure('Invalid session id');
    return transaction(pool,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const rows=await db.query('SELECT * FROM sessions WHERE session_id=$1',[id]);
      if(!rows.rowCount) throw failure('Unknown session',404);
      const session=rows.rows[0],events=await readEvents(db,id);
      const anchors=(await db.query('SELECT id,session_id,from_seq,to_seq,merkle_root,tx_signature,cluster,created_at,status,signer,fee_lamports FROM anchors WHERE session_id=$1 ORDER BY cluster,from_seq',[id])).rows;
      const giveaways=(await db.query('SELECT * FROM giveaways WHERE session_id=$1',[id])).rows;
      for(const giveaway of giveaways) {
        if(giveaway.state==='COMPLETE') {
          const users=(await db.query('SELECT user_key FROM entries WHERE giveaway_id=$1',[giveaway.giveaway_id])).rows.map(row=>String(row.user_key)).sort();
          giveaway.winner_proof=inclusionProof(entryLeaves(giveaway.giveaway_id,users),giveaway.winner_index);
        }
      }
      const verification=checkJournal(events,session);
      if(!await verifyGiveawayRecords(db,events)){verification.ok=false;verification.error='Giveaway evidence mismatch';}
      return {protocol:'MDTL1',session,events,anchors,giveaways,verification,anchor_verified:false};
    });
  });
}
