import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeSignature,deliverAnchor} from '../src/anchor-delivery.ts';

test('signature encoding preserves leading zero bytes',()=>{
  // Known base58 vectors protect the locally computed transaction identity.
  assert.equal(encodeSignature(Uint8Array.of(0,0,1)),'112');
  assert.equal(encodeSignature(Uint8Array.of(255)),'5Q');
  assert.equal(encodeSignature(new Uint8Array(64)),'1'.repeat(64));
});

test('uncertain delivery retries the saved bytes and never signs a replacement',async()=>{
  // Simulate an RPC accepting bytes but losing its response on the first attempt.
  const record={tx_signature:'signature',raw_tx:Buffer.from('signed bytes').toString('base64'),last_valid_height:'100'};
  const sent:Buffer[]=[];
  const rpc={getSignatureStatuses:async()=>({value:[null]}),getBlockHeight:async()=>50n,sendRawTransaction:async(bytes:Uint8Array)=>{sent.push(Buffer.from(bytes));if(sent.length===1)throw new Error('Timeout');return 'signature';}};
  assert.equal((await deliverAnchor(record,rpc)).status,'PENDING');
  assert.equal((await deliverAnchor(record,rpc)).status,'SUBMITTED');
  assert.deepEqual(sent[0],sent[1]);
});

test('finalized, failed and expired transactions are never sent again',async()=>{
  // Status checks precede broadcasting and bound recovery when the blockhash expires.
  const record={tx_signature:'signature',raw_tx:'AQ==',last_valid_height:'100'};
  let sent=0;
  for(const [observed,height,expected] of [[{err:null,confirmationStatus:'finalized'},50n,'FINALIZED'],[{err:{InstructionError:[0,'error']},confirmationStatus:'finalized'},50n,'FAILED'],[null,101n,'EXPIRED_UNKNOWN']] as const) {
    const rpc={getSignatureStatuses:async()=>({value:[observed]}),getBlockHeight:async()=>height,sendRawTransaction:async()=>{sent++;return 'signature';}};
    assert.equal((await deliverAnchor(record,rpc)).status,expected);
  }
  assert.equal(sent,0);
});
