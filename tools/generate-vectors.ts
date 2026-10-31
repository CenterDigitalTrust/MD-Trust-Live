import {generateKeyPairSync,sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {canonicalize,sha256,eventHash,merkleRoot,inclusionProof,drawWinner} from '../ebs/src/mdtl/core.ts';

try {
  // Export public fixtures only; the ephemeral test private key is never saved.
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const payload={app_ver:'0.1.0',device_id:'vector-device',geo_enabled:false};
  const header={v:1,channel_id:'123',session_id:'vector-session',seq:0,type:'SESSION_START',client_ts_ms:1793232000000,prev_hash:'0'.repeat(64),payload_hash:sha256(canonicalize(payload)),challenge:'12'.repeat(32)};
  const signature=sign('sha256',Buffer.from('MDTL1\n'+canonicalize(header)),pair.privateKey).toString('base64');
  const entries=['10','20','3'],giveawayId='vector-draw',seed='01'.repeat(32);
  const leaves=entries.map(id=>Buffer.from('MDTL-ENTRY-1\n'+giveawayId+'\n'+id));
  const root=merkleRoot(leaves),winner=drawWinner(seed,root,entries.length);
  const fixtures={canonical:[{input:{z:'quote"\n',a:[1,true,null,'Привіт']},expected:canonicalize({z:'quote"\n',a:[1,true,null,'Привіт']})}],spki:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),event:{header,payload,signature,event_hash:eventHash(header,signature),received_at:header.client_ts_ms,challenge_issued_at:header.client_ts_ms-100},draw:{giveawayId,entries,seed,root,count:entries.length,winner,proof:inclusionProof(leaves,winner)}};
  writeFileSync(new URL('../docs/test-vectors.json',import.meta.url),JSON.stringify(fixtures,null,2)+'\n');
} catch(error) {console.error('Vector generation failed:',error instanceof Error?error.message:error);process.exitCode=1;}
