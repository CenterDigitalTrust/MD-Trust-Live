import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {SignedEvent} from '../src/mdtl/core.ts';
import {sha256,merkleRoot,drawWinner} from '../src/mdtl/core.ts';
import {entryLeaves,verifyGiveawayRecords} from '../src/giveaway.ts';

test('giveaway verification rejects metadata tampering and duplicate results',async()=>{
  // This test isolates DB projection integrity; signature verification has separate tests.
  const id='11111111-1111-1111-1111-111111111111',session='22222222-2222-2222-2222-222222222222';
  const users=['1','2','3'],seed='ab'.repeat(32),commit=sha256(Buffer.from(seed,'hex'));
  const root=merkleRoot(entryLeaves(id,users)),winner=drawWinner(seed,root,users.length);
  const events=[
    ['GIVEAWAY_OPEN',{prize:'Test prize',seed_commit:commit}],
    ['GIVEAWAY_LOCK',{entries_hash:root,entries_count:users.length}],
    ['GIVEAWAY_REVEAL',{seed}],
    ['GIVEAWAY_RESULT',{winner_index:winner,winner_user_key:users[winner],algo:'MDTL-DRAW-1'}],
  ].map(([type,payload])=>({header:{type,session_id:session},payload:{giveaway_id:id,...payload as object}})) as unknown as SignedEvent[];
  const original={giveaway_id:id,session_id:session,prize:'Test prize',seed_commit:commit,entries_hash:root,entries_count:3,seed,winner_index:winner,winner_user_key:users[winner],state:'COMPLETE'};
  let row:Record<string,unknown>={...original};
  const db={query:async(sql:string)=>{
    // Unexpected SQL fails rather than silently returning a permissive fake response.
    if(sql.startsWith('SELECT user_key'))return {rows:users.map(user_key=>({user_key}))};
    if(sql.startsWith('SELECT * FROM giveaways'))return {rows:[row]};
    throw new Error(`Unexpected test query: ${sql}`);
  }} as unknown as PoolClient;
  assert.equal(await verifyGiveawayRecords(db,events),true);
  for(const [field,value] of Object.entries({prize:'Replaced',seed_commit:'00'.repeat(32),entries_hash:'00'.repeat(32),entries_count:4,seed:'00'.repeat(32),winner_index:(winner+1)%3,winner_user_key:'999',state:'OPEN'})) {
    row={...original,[field]:value};
    assert.equal(await verifyGiveawayRecords(db,events),false,`Must reject changed ${field}`);
  }
  row={...original};
  assert.equal(await verifyGiveawayRecords(db,[...events,events[3]]),false);
});
