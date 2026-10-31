import {test} from 'node:test';
import assert from 'node:assert/strict';
import {anchorMemo,anchorCoversEvents} from '../src/anchor.ts';
import {merkleRoot} from '../src/mdtl/core.ts';

test('anchor memo binds session and range and rejects malformed commitments',()=>{
  // Different session/range commitments must never share memo text.
  const session='12345678-1234-1234-1234-123456789012',root='ab'.repeat(32);
  assert.equal(anchorMemo(session,0,4,root),`MDTL1|${session}|0|4|${root}`);
  assert.notEqual(anchorMemo(session,0,4,root),anchorMemo(session,1,4,root));
  assert.throws(()=>anchorMemo(session,4,0,root));
  assert.throws(()=>anchorMemo(session,0,4,'bad'));
});

test('anchor coverage rejects gaps, overlaps, roots and out-of-range commitments',()=>{
  // A finalized unrelated root must never certify the exported events.
  const events=[{event_hash:'ab'.repeat(32)},{event_hash:'cd'.repeat(32)}];
  const anchor={from_seq:0,to_seq:1,merkle_root:merkleRoot(events.map(e=>Buffer.from(e.event_hash,'hex')))};
  assert.equal(anchorCoversEvents(anchor,events,0),true);
  for(const changed of [{from_seq:1},{to_seq:2},{to_seq:-1},{merkle_root:'00'.repeat(32)}])assert.equal(anchorCoversEvents({...anchor,...changed},events,0),false);
  assert.equal(anchorCoversEvents(anchor,events,1),false);
});
