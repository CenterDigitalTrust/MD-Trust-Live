import {readFile} from 'node:fs/promises';
import {verifyChain,merkleRoot,drawWinner,verifyInclusion,sha256} from '../ebs/src/mdtl/core.ts';
import type {SignedEvent} from '../ebs/src/mdtl/core.ts';

try {
  // Offline verification proves internal consistency; ledger trust needs online checking.
  const file=process.argv[2];
  if(!file)throw new Error('Usage: node --experimental-strip-types tools/verify-export.ts session.json');
  const exported=JSON.parse(await readFile(file,'utf8'));
  const events=exported.events as SignedEvent[],session=exported.session;
  if(!Array.isArray(events)||!session)throw new Error('Invalid export envelope');
  const result=verifyChain(events,session.device_pubkey_spki,{channelId:session.channel_id,sessionId:session.session_id,expectedHead:session.head_hash,expectedCount:Number(session.event_count)});
  if(!result.ok)throw new Error(result.error);
  for(const anchor of exported.anchors??[]) {
    const leaves=events.slice(anchor.from_seq,anchor.to_seq+1).map(event=>Buffer.from(event.event_hash,'hex'));
    if(!leaves.length||merkleRoot(leaves)!==anchor.merkle_root)throw new Error('Anchor root mismatch');
  }
  for(const giveaway of exported.giveaways??[]) {
    if(giveaway.state!=='COMPLETE')continue;
    // Bind the display projection to signed events before checking its arithmetic.
    const journal=events.filter(event=>(event.payload as {giveaway_id?:string})?.giveaway_id===giveaway.giveaway_id);
    const payload=(type:string):Record<string,unknown>=>{
      const matches=journal.filter(event=>event.header.type===type);
      if(matches.length!==1)throw new Error(`Missing or duplicate signed ${type}`);
      return matches[0].payload as Record<string,unknown>;
    };
    const opened=payload('GIVEAWAY_OPEN'),locked=payload('GIVEAWAY_LOCK'),revealed=payload('GIVEAWAY_REVEAL'),completed=payload('GIVEAWAY_RESULT');
    if(opened.prize!==giveaway.prize||opened.seed_commit!==giveaway.seed_commit||locked.entries_hash!==giveaway.entries_hash||locked.entries_count!==giveaway.entries_count||revealed.seed!==giveaway.seed||completed.winner_index!==giveaway.winner_index||completed.winner_user_key!==giveaway.winner_user_key||completed.algo!=='MDTL-DRAW-1')throw new Error('Giveaway metadata differs from signed journal');
    if(sha256(Buffer.from(giveaway.seed,'hex'))!==giveaway.seed_commit)throw new Error('Seed commitment mismatch');
    const index=drawWinner(giveaway.seed,giveaway.entries_hash,giveaway.entries_count);
    if(index!==giveaway.winner_index)throw new Error('Winner index mismatch');
    const leaf=Buffer.from(`MDTL-ENTRY-1\n${giveaway.giveaway_id}\n${giveaway.winner_user_key}`);
    if(!verifyInclusion(leaf,index,giveaway.entries_count,giveaway.winner_proof,giveaway.entries_hash))throw new Error('Winner inclusion proof mismatch');
  }
  console.info(JSON.stringify({valid:true,events:events.length,ledger_checked:false,notice:'Offline consistency verified. Confirm anchor transactions independently on the stated Solana cluster.'},null,2));
} catch(error){console.error('Export verification failed:',error instanceof Error?error.message:'Invalid export');process.exitCode=1;}
