import {createHash,createPublicKey,verify} from 'node:crypto';

export type Json = null|boolean|string|number|Json[]|{[key:string]:Json};
export interface Header {v:number;channel_id:string;session_id:string;seq:number;type:string;client_ts_ms:number;prev_hash:string;payload_hash:string;challenge:string}
export interface SignedEvent {header:Header;payload:Json;signature:string;event_hash:string;received_at:number;challenge_issued_at:number}
export interface ChainOptions {channelId:string;sessionId:string;expectedHead:string;expectedCount:number}
export interface Verification {ok:boolean;error?:string}
const HEX=/^[a-f0-9]{64}$/;
const TYPES=new Set(['SESSION_START','PULSE','GIVEAWAY_OPEN','GIVEAWAY_LOCK','GIVEAWAY_REVEAL','GIVEAWAY_RESULT','VAULT_MARK','SESSION_END']);

export function canonicalize(value:unknown):string {
  // Reject ambiguous values instead of silently changing signed data.
  const seen=new Set<object>();
  function encode(item:unknown):string {
    if(item===null) return 'null';
    if(typeof item==='boolean') return String(item);
    if(typeof item==='number') {
      if(!Number.isSafeInteger(item)||Object.is(item,-0)) throw new Error('Canonical numbers must be safe integers');
      return String(item);
    }
    if(typeof item==='string') {
      if(!item.isWellFormed()) throw new Error('Unpaired Unicode surrogate');
      return JSON.stringify(item);
    }
    if(typeof item!=='object'||item===null) throw new Error('Unsupported canonical value');
    if(seen.has(item)) throw new Error('Circular canonical value');
    seen.add(item);
    try {
      if(Array.isArray(item)) {
        for(let i=0;i<item.length;i++) if(!(i in item)) throw new Error('Sparse array');
        return '['+item.map(encode).join(',')+']';
      }
      if(Object.getPrototypeOf(item)!==Object.prototype && Object.getPrototypeOf(item)!==null) throw new Error('Expected plain object');
      return '{'+Object.keys(item).sort().map(k=>encode(k)+':'+encode((item as Record<string,unknown>)[k])).join(',')+'}';
    } finally {seen.delete(item);}
  }
  return encode(value);
}

export function sha256(data:string|Uint8Array):string {
  // Return lowercase hex for all protocol digests.
  return createHash('sha256').update(data).digest('hex');
}

export function eventHash(header:Header,signature:string):string {
  // Domain separation prevents confusing records with request signatures.
  return sha256('MDTL1-EVT\n'+canonicalize(header)+'\n'+signature);
}

export function verifySignature(message:string,signature:string,spki:string):boolean {
  // Enforce curve, encoding and signature format before cryptographic verification.
  try {
    if(Buffer.from(signature,'base64').toString('base64')!==signature) return false;
    if(Buffer.from(spki,'base64').toString('base64')!==spki) return false;
    const key=createPublicKey({key:Buffer.from(spki,'base64'),type:'spki',format:'der'});
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1') return false;
    return verify('sha256',Buffer.from(message),{key,dsaEncoding:'der'},Buffer.from(signature,'base64'));
  } catch {return false;}
}

export function verifyEvent(event:SignedEvent,spki:string):Verification {
  // Historical receipt times remain verifiable after nonce expiration.
  try {
    const h=event.header;
    if(h.v!==1||!TYPES.has(h.type)||!Number.isSafeInteger(h.seq)||h.seq<0) throw new Error('Invalid event header');
    if(!HEX.test(h.prev_hash)||!HEX.test(h.payload_hash)||!HEX.test(event.event_hash)) throw new Error('Invalid digest');
    if(h.payload_hash!==sha256(canonicalize(event.payload))) throw new Error('Payload hash mismatch');
    if(event.event_hash!==eventHash(h,event.signature)) throw new Error('Event hash mismatch');
    if(!verifySignature('MDTL1\n'+canonicalize(h),event.signature,spki)) throw new Error('Invalid device signature');
    if(!Number.isSafeInteger(event.received_at)||!Number.isSafeInteger(h.client_ts_ms)) throw new Error('Invalid timestamp');
    if(h.type==='SESSION_START'||h.type==='PULSE') {
      if(!HEX.test(h.challenge)||!Number.isSafeInteger(event.challenge_issued_at)) throw new Error('Missing challenge');
      const age=event.received_at-event.challenge_issued_at;
      if(age<0||age>45000) throw new Error('Expired or future challenge');
      if(Math.abs(event.received_at-h.client_ts_ms)>30000) throw new Error('Device clock outside tolerance');
    }
    return {ok:true};
  } catch(error) {return {ok:false,error:error instanceof Error?error.message:'Invalid event'};}
}

export function verifyChain(events:SignedEvent[],spki:string,options:ChainOptions):Verification {
  // Check continuity against a separately persisted head and nonce history.
  try {
    if(events.length!==options.expectedCount) throw new Error('Event count mismatch');
    let previous='0'.repeat(64), ended=false;
    const used=new Set<string>();
    for(let i=0;i<events.length;i++) {
      const e=events[i],h=e.header,result=verifyEvent(e,spki);
      if(!result.ok) throw new Error(result.error);
      if(ended||h.seq!==i||h.prev_hash!==previous||h.channel_id!==options.channelId||h.session_id!==options.sessionId) throw new Error('Chain continuity mismatch');
      if((i===0)!==(h.type==='SESSION_START')) throw new Error('Invalid session start');
      if(h.type==='PULSE'||h.type==='SESSION_START') {
        if(used.has(h.challenge)) throw new Error('Reused challenge');
        used.add(h.challenge);
      }
      if(i>0&&e.received_at<events[i-1].received_at) throw new Error('Receipt time regression');
      ended=h.type==='SESSION_END';previous=e.event_hash;
    }
    if(previous!==options.expectedHead) throw new Error('Head mismatch or truncated journal');
    return {ok:true};
  } catch(error) {return {ok:false,error:error instanceof Error?error.message:'Invalid chain'};}
}

function splitSize(n:number):number {
  // RFC6962 splits at the greatest power of two strictly less than n.
  return 2**Math.floor(Math.log2(n-1));
}
function leafHash(data:Uint8Array):Buffer {
  // Prefix leaves to distinguish them from internal nodes.
  return createHash('sha256').update(Buffer.from([0])).update(data).digest();
}
function parent(left:Buffer,right:Buffer):Buffer {
  // Ordered children preserve participant index in inclusion proofs.
  return createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest();
}
function rootBytes(leaves:Uint8Array[]):Buffer {
  // Empty trees use SHA256(empty), without a leaf prefix.
  if(!leaves.length) return Buffer.from(sha256(''),'hex');
  if(leaves.length===1) return leafHash(leaves[0]);
  const k=splitSize(leaves.length);
  return parent(rootBytes(leaves.slice(0,k)),rootBytes(leaves.slice(k)));
}
export function merkleRoot(leaves:Uint8Array[]):string {
  // Public API exposes the unambiguous raw-leaf convention.
  return rootBytes(leaves).toString('hex');
}
export function inclusionProof(leaves:Uint8Array[],index:number):string[] {
  // Append sibling hashes bottom-up along the recursive RFC6962 path.
  if(!Number.isInteger(index)||index<0||index>=leaves.length) throw new Error('Invalid proof index');
  if(leaves.length===1) return [];
  const k=splitSize(leaves.length);
  return index<k?[...inclusionProof(leaves.slice(0,k),index),merkleRoot(leaves.slice(k))]:[...inclusionProof(leaves.slice(k),index-k),merkleRoot(leaves.slice(0,k))];
}
export function verifyInclusion(leaf:Uint8Array,index:number,count:number,proof:string[],root:string):boolean {
  // Derive sibling directions from index and size; reject extra/missing hashes.
  try {
    if(!Number.isSafeInteger(count)||count<=0||!Number.isSafeInteger(index)||index<0||index>=count||!HEX.test(root)) return false;
    let cursor=0;
    function rebuild(i:number,n:number):Buffer {
      if(n===1) return leafHash(leaf);
      const k=splitSize(n),left=i<k;
      const branch=rebuild(left?i:i-k,left?k:n-k);
      const hash=proof[cursor++];
      if(!hash||!HEX.test(hash)) throw new Error('Malformed proof');
      const sibling=Buffer.from(hash,'hex');
      return left?parent(branch,sibling):parent(sibling,branch);
    }
    const result=rebuild(index,count).toString('hex');
    return cursor===proof.length&&result===root;
  } catch {return false;}
}
export function drawWinner(seed:string,root:string,count:number):number {
  // Follow MDTL-DRAW-1 exactly; external entropy is a separate future protocol.
  if(!HEX.test(seed)||!HEX.test(root)||!Number.isSafeInteger(count)||count<=0) throw new Error('Invalid draw inputs');
  const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(count));
  const digest=sha256(Buffer.concat([Buffer.from(seed,'hex'),Buffer.from(root,'hex'),n]));
  return Number(BigInt('0x'+digest)%BigInt(count));
}
