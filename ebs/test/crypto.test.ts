import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {canonicalize, sha256, eventHash, verifyChain, merkleRoot, inclusionProof, verifyInclusion, drawWinner} from '../src/mdtl/core.ts';
import type {SignedEvent,Json} from '../src/mdtl/core.ts';

test('canonical strings, nested sorting and strict numeric domain', () => {
  // Check escaping, Unicode and rejected inputs before hashing.
  assert.equal(canonicalize({z:[true,null,'a"\n'],a:{я:2,b:1}}), '{"a":{"b":1,"я":2},"z":[true,null,"a\\\"\\n"]}');
  for (const value of [NaN,Infinity,1.5,-0,2**53,undefined,'\ud800']) assert.throws(()=>canonicalize(value));
  assert.equal(sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('RFC6962 roots and proofs for uneven trees, wrong leaves, paths and sizes', () => {
  // Independent recursive oracle checks every leaf for many uneven trees.
  function oracle(leaves: Buffer[]): Buffer {
    if (!leaves.length) return createHash('sha256').update('').digest();
    if (leaves.length===1) return createHash('sha256').update(Buffer.concat([Buffer.from([0]),leaves[0]])).digest();
    const split=2**Math.floor(Math.log2(leaves.length-1));
    return createHash('sha256').update(Buffer.concat([Buffer.from([1]),oracle(leaves.slice(0,split)),oracle(leaves.slice(split))])).digest();
  }
  for(let n=1;n<=33;n++) {
    const leaves=Array.from({length:n},(_,i)=>Buffer.from(`leaf-${i}`));
    const root=merkleRoot(leaves);
    assert.equal(root,oracle(leaves).toString('hex'));
    for(let i=0;i<n;i++) {
      const proof=inclusionProof(leaves,i);
      assert.equal(verifyInclusion(leaves[i],i,n,proof,root),true);
      assert.equal(verifyInclusion(Buffer.from('wrong'),i,n,proof,root),false);
      assert.equal(verifyInclusion(leaves[i],i,n,[...proof,'00'.repeat(32)],root),false);
      assert.equal(verifyInclusion(leaves[i],i,0,proof,root),false);
    }
  }
  assert.equal(merkleRoot([]),sha256(''));
  assert.throws(()=>inclusionProof([],0));
});

test('signed chain detects tampering, replay, wrong key, gaps and truncation', () => {
  // Generate an independent signer, then mutate copies without re-signing.
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const events: SignedEvent[]=[];
  for(let seq=0;seq<3;seq++) {
    const payload:Json=seq===0?{device_id:'device',app_ver:'0.1',geo_enabled:false}:{batt_pct:90};
    const header={v:1,channel_id:'123',session_id:'session',seq,type:seq===0?'SESSION_START':'PULSE',client_ts_ms:1000+seq*5000,prev_hash:seq?events[seq-1].event_hash:'0'.repeat(64),payload_hash:sha256(canonicalize(payload)),challenge:sha256(String(seq))};
    const signature=sign('sha256',Buffer.from('MDTL1\n'+canonicalize(header)),privateKey).toString('base64');
    events.push({header,payload,signature,event_hash:eventHash(header,signature),received_at:header.client_ts_ms,challenge_issued_at:header.client_ts_ms-100});
  }
  const options={channelId:'123',sessionId:'session',expectedHead:events[2].event_hash,expectedCount:3};
  assert.equal(verifyChain(events,spki,options).ok,true);
  for(const mutate of [
    (e:SignedEvent[])=>{e[1].payload={batt_pct:1};},
    (e:SignedEvent[])=>{e[1].header.prev_hash='0'.repeat(64);},
    (e:SignedEvent[])=>{e[1].header.seq=5;},
    (e:SignedEvent[])=>{e[1].challenge_issued_at=-100000;},
    (e:SignedEvent[])=>{e[1].header.challenge=e[0].header.challenge;},
    (e:SignedEvent[])=>{e.pop();}
  ]) {const copy=structuredClone(events);mutate(copy);assert.equal(verifyChain(copy,spki,options).ok,false);}
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'}).toString('base64');
  assert.equal(verifyChain(events,other,options).ok,false);
});

test('draw uses unsigned big-endian digest modulo nonempty participant count', () => {
  // Independent digest computation fixes byte order and checks invalid input.
  const seed='01'.repeat(32), root='ab'.repeat(32), count=7;
  const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(count));
  const expected=Number(BigInt('0x'+createHash('sha256').update(Buffer.concat([Buffer.from(seed,'hex'),Buffer.from(root,'hex'),n])).digest('hex'))%7n);
  assert.equal(drawWinner(seed,root,count),expected);
  assert.throws(()=>drawWinner(seed,root,0));
  assert.throws(()=>drawWinner('bad',root,count));
});
