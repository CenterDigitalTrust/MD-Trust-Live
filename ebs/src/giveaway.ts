import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import type {Config} from './config.ts';
import type {Json,SignedEvent} from './mdtl/core.ts';
import {sha256,merkleRoot,inclusionProof,drawWinner} from './mdtl/core.ts';
import {authenticateTwitch} from './auth.ts';
import {transaction,deviceIdentity,readEvents,checkJournal} from './live.ts';

function fail(message:string):never {
  // Invalid transitions are conflicts, never partial updates.
  throw Object.assign(new Error(message),{statusCode:409});
}
export function entryLeaves(id:string,users:string[]):Buffer[] {
  // Bytewise ASCII sorting matches the shared numeric-string identity contract.
  return [...users].sort().map(user=>Buffer.from(`MDTL-ENTRY-1\n${id}\n${user}`));
}
async function participants(db:PoolClient,id:string):Promise<string[]> {
  // Sort in application code so database collation cannot change the draw.
  const rows=await db.query('SELECT user_key FROM entries WHERE giveaway_id=$1',[id]);
  return rows.rows.map(row=>String(row.user_key)).sort();
}

export async function applyGiveawayEvent(db:PoolClient,event:SignedEvent):Promise<void> {
  // Called only after signature/chain validation, inside the event transaction.
  if(!event.header.type.startsWith('GIVEAWAY_'))return;
  const payload=event.payload as Record<string,Json>;
  const id=payload?.giveaway_id;
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))fail('Invalid giveaway identifier');
  if(event.header.type==='GIVEAWAY_OPEN') {
    if(typeof payload.prize!=='string'||payload.prize.length<1||payload.prize.length>200||typeof payload.seed_commit!=='string'||!/^[0-9a-f]{64}$/.test(payload.seed_commit))fail('Invalid prize or seed commitment');
    const active=await db.query("SELECT giveaway_id FROM giveaways WHERE session_id=$1 AND state NOT IN ('COMPLETE','CANCELLED')",[event.header.session_id]);
    if(active.rowCount)fail('Finish the current giveaway first');
    await db.query("INSERT INTO giveaways(giveaway_id,session_id,prize,seed_commit,state) VALUES($1,$2,$3,$4,'OPEN')",[id,event.header.session_id,payload.prize,payload.seed_commit]);
    return;
  }
  const rows=await db.query('SELECT * FROM giveaways WHERE giveaway_id=$1 AND session_id=$2 FOR UPDATE',[id,event.header.session_id]);
  if(!rows.rowCount)fail('Unknown giveaway');
  const row=rows.rows[0],users=await participants(db,id),root=merkleRoot(entryLeaves(id,users));
  if(event.header.type==='GIVEAWAY_LOCK') {
    if(row.state!=='FROZEN'||!users.length||payload.entries_hash!==root||payload.entries_count!==users.length||row.entries_hash!==root)fail('Frozen participant commitment mismatch');
    await db.query("UPDATE giveaways SET state='LOCKED' WHERE giveaway_id=$1",[id]);
  } else if(event.header.type==='GIVEAWAY_REVEAL') {
    if(row.state!=='LOCKED'||typeof payload.seed!=='string'||!/^[0-9a-f]{64}$/.test(payload.seed)||sha256(Buffer.from(payload.seed,'hex'))!==row.seed_commit)fail('Invalid seed reveal');
    await db.query("UPDATE giveaways SET state='REVEALED',seed=$2 WHERE giveaway_id=$1",[id,payload.seed]);
  } else if(event.header.type==='GIVEAWAY_RESULT') {
    if(row.state!=='REVEALED'||root!==row.entries_hash||users.length!==row.entries_count)fail('Giveaway is not ready for result');
    const index=drawWinner(row.seed,root,users.length);
    if(payload.winner_index!==index||payload.winner_user_key!==users[index]||payload.algo!=='MDTL-DRAW-1')fail('Incorrect giveaway result');
    await db.query("UPDATE giveaways SET state='COMPLETE',winner_index=$2,winner_user_key=$3 WHERE giveaway_id=$1",[id,index,users[index]]);
  }
}

export async function verifyGiveawayRecords(db:PoolClient,events:SignedEvent[]):Promise<boolean> {
  // Re-check frozen lists and event semantics instead of trusting mutable DB state.
  try {
    const seen=new Map<string,{session:string;prize:Json;commit:string;root?:string;count?:number;seed?:string;winner?:number;user?:string}>();
    for(const event of events) {
      if(!event.header.type.startsWith('GIVEAWAY_'))continue;
      const p=event.payload as Record<string,Json>,id=String(p.giveaway_id);
      const previous=seen.get(id);
      if(event.header.type==='GIVEAWAY_OPEN') {if(previous)return false;seen.set(id,{session:event.header.session_id,prize:p.prize,commit:String(p.seed_commit)});continue;}
      if(!previous)return false;
      const users=await participants(db,id),root=merkleRoot(entryLeaves(id,users));
      if(event.header.type==='GIVEAWAY_LOCK') {
        if(previous.root||p.entries_hash!==root||p.entries_count!==users.length)return false;
        previous.root=root;previous.count=users.length;
      } else if(event.header.type==='GIVEAWAY_REVEAL') {
        if(!previous.root||previous.seed||typeof p.seed!=='string'||sha256(Buffer.from(p.seed,'hex'))!==previous.commit)return false;
        previous.seed=p.seed;
      } else if(event.header.type==='GIVEAWAY_RESULT') {
        if(!previous.seed||!previous.root||!previous.count||previous.winner!==undefined)return false;
        const index=drawWinner(previous.seed,previous.root,previous.count);
        if(p.winner_index!==index||p.winner_user_key!==users[index]||p.algo!=='MDTL-DRAW-1')return false;
        previous.winner=index;previous.user=users[index];
      } else {return false;}
    }
    // Cross-check every displayed field against the signed journal, including nulls.
    const sessionIds=[...new Set(events.map(event=>event.header.session_id))];
    const records=await db.query('SELECT * FROM giveaways WHERE session_id=ANY($1::uuid[])',[sessionIds]);
    if(records.rows.length!==seen.size)return false;
    for(const row of records.rows) {
      const expected=seen.get(row.giveaway_id);
      if(!expected||row.session_id!==expected.session||row.prize!==expected.prize||row.seed_commit!==expected.commit)return false;
      if(row.seed!==(expected.seed??null)||row.winner_index!==(expected.winner??null)||row.winner_user_key!==(expected.user??null))return false;
      if(expected.root) {
        const state=expected.winner!==undefined?'COMPLETE':expected.seed?'REVEALED':'LOCKED';
        if(row.state!==state||row.entries_hash!==expected.root||row.entries_count!==expected.count)return false;
      } else if(row.state==='FROZEN') {
        const users=await participants(db,row.giveaway_id);
        if(!users.length||row.entries_hash!==merkleRoot(entryLeaves(row.giveaway_id,users))||row.entries_count!==users.length)return false;
      } else if(row.state!=='OPEN'||row.entries_hash!==null||row.entries_count!==null) {
        return false;
      }
    }
    return true;
  } catch {return false;}
}

async function requireValidGiveaway(db:PoolClient,sessionId:string):Promise<void> {
  // Fail closed before serving mutable giveaway data or participant proofs.
  const sessions=await db.query('SELECT * FROM sessions WHERE session_id=$1',[sessionId]);
  const events=await readEvents(db,sessionId);
  if(!sessions.rowCount||!checkJournal(events,sessions.rows[0]).ok||!await verifyGiveawayRecords(db,events))fail('Giveaway integrity check failed');
}

export async function registerGiveaway(app:FastifyInstance,pool:Pool,config:Config):Promise<void> {
  // Public viewer actions always use identity from the verified Twitch token.
  app.post('/v1/giveaway/enter',async request=>{
    const user=await authenticateTwitch(request.headers.authorization,config.extensionSecret);
    if(!user.userId)throw Object.assign(new Error('Share your Twitch identity to enter'),{statusCode:403});
    return transaction(pool,async db=>{
      const rows=await db.query("SELECT g.* FROM giveaways g JOIN sessions s USING(session_id) WHERE s.channel_id=$1 AND s.ended_at IS NULL AND g.state='OPEN' FOR UPDATE OF g",[user.channelId]);
      if(!rows.rowCount)fail('No open giveaway');
      await db.query('INSERT INTO entries(giveaway_id,user_key,entered_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[rows.rows[0].giveaway_id,user.userId,Date.now()]);
      return {entered:true};
    });
  });
  app.post('/v1/giveaway/lock-request',async request=>transaction(pool,async db=>{
    const device=await deviceIdentity(request,db);
    const rows=await db.query("SELECT g.* FROM giveaways g JOIN sessions s USING(session_id) WHERE s.channel_id=$1 AND s.ended_at IS NULL AND g.state IN ('OPEN','FROZEN') FOR UPDATE OF g",[device.channel_id]);
    if(!rows.rowCount)fail('No giveaway to freeze');
    const row=rows.rows[0],users=await participants(db,row.giveaway_id);
    if((request.body as {giveaway_id?:string})?.giveaway_id!==row.giveaway_id)fail('Giveaway identifier mismatch');
    if(!users.length)fail('At least one participant is required');
    const root=merkleRoot(entryLeaves(row.giveaway_id,users));
    await db.query("UPDATE giveaways SET state='FROZEN',entries_hash=$2,entries_count=$3 WHERE giveaway_id=$1",[row.giveaway_id,root,users.length]);
    return {giveaway_id:row.giveaway_id,entries_hash:root,entries_count:users.length};
  }));
  app.get('/v1/giveaway',async request=>{
    const user=await authenticateTwitch(request.headers.authorization,config.extensionSecret);
    return transaction(pool,async db=>{
      const rows=await db.query("SELECT g.* FROM giveaways g JOIN sessions s USING(session_id) JOIN events e ON e.session_id=g.session_id AND e.type='GIVEAWAY_OPEN' AND e.payload_json->>'giveaway_id'=g.giveaway_id::text WHERE s.channel_id=$1 ORDER BY s.started_at DESC,e.seq DESC LIMIT 1",[user.channelId]);
      if(!rows.rowCount)return {state:'NONE'};
      const row=rows.rows[0],users=await participants(db,row.giveaway_id);
      await requireValidGiveaway(db,row.session_id);
      const winner=row.winner_index;
      return {giveaway_id:row.giveaway_id,state:row.state,prize:row.prize,entries_count:users.length,you_entered:users.includes(user.userId??''),entries_hash:row.entries_hash,seed_commit:row.seed_commit,seed:row.seed,winner_index:winner,winner_user_key:row.winner_user_key,winner_proof:winner===null?null:inclusionProof(entryLeaves(row.giveaway_id,users),winner),anchor_verified:false};
    });
  });
  app.get('/v1/giveaway/proof',async request=>{
    const user=await authenticateTwitch(request.headers.authorization,config.extensionSecret);
    if(!user.userId)throw Object.assign(new Error('Shared identity required'),{statusCode:403});
    return transaction(pool,async db=>{
      const rows=await db.query("SELECT g.* FROM giveaways g JOIN sessions s USING(session_id) JOIN events e ON e.session_id=g.session_id AND e.type='GIVEAWAY_OPEN' AND e.payload_json->>'giveaway_id'=g.giveaway_id::text WHERE s.channel_id=$1 AND g.state<>'OPEN' ORDER BY s.started_at DESC,e.seq DESC LIMIT 1",[user.channelId]);
      if(!rows.rowCount)fail('No frozen giveaway');
      const row=rows.rows[0],users=await participants(db,row.giveaway_id),index=users.indexOf(user.userId!);
      await requireValidGiveaway(db,row.session_id);
      if(index<0)fail('You are not in this giveaway');
      return {giveaway_id:row.giveaway_id,user_key:user.userId,index,count:users.length,root:row.entries_hash,proof:inclusionProof(entryLeaves(row.giveaway_id,users),index)};
    });
  });
  app.post('/v1/giveaway/result-preview',async request=>transaction(pool,async db=>{
    const device=await deviceIdentity(request,db);
    const rows=await db.query("SELECT g.* FROM giveaways g JOIN sessions s USING(session_id) WHERE s.channel_id=$1 AND s.ended_at IS NULL AND g.state='REVEALED'",[device.channel_id]);
    if(!rows.rowCount)fail('Reveal the seed first');
    const row=rows.rows[0],users=await participants(db,row.giveaway_id),index=drawWinner(row.seed,row.entries_hash,users.length);
    if((request.body as {giveaway_id?:string})?.giveaway_id!==row.giveaway_id)fail('Giveaway identifier mismatch');
    return {giveaway_id:row.giveaway_id,winner_index:index,winner_user_key:users[index],algo:'MDTL-DRAW-1'};
  }));
}
