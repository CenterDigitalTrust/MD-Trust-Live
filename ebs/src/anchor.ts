import {Connection,Keypair,PublicKey,Transaction,TransactionInstruction} from '@solana/web3.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {merkleRoot} from './mdtl/core.ts';
import {readEvents,checkJournal} from './live.ts';
import {verifyGiveawayRecords} from './giveaway.ts';
import {deliverAnchor,encodeSignature} from './anchor-delivery.ts';

const MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export function anchorCoversEvents(anchor:{from_seq:number;to_seq:number;merkle_root:string},events:{event_hash:string}[],expectedFrom:number):boolean {
  // Require contiguous coverage and recompute the commitment from this export.
  try {
    if(!Number.isSafeInteger(anchor.from_seq)||!Number.isSafeInteger(anchor.to_seq)||anchor.from_seq!==expectedFrom||anchor.from_seq<0||anchor.to_seq<anchor.from_seq||anchor.to_seq>=events.length)return false;
    return merkleRoot(events.slice(anchor.from_seq,anchor.to_seq+1).map(event=>Buffer.from(event.event_hash,'hex')))===anchor.merkle_root;
  } catch {return false;}
}
export function anchorMemo(sessionId:string,from:number,to:number,root:string):string {
  // Commit range and session identity together with the root, not only a bare hash.
  if(!/^[0-9a-f-]{36}$/.test(sessionId)||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||!/^[0-9a-f]{64}$/.test(root))throw new Error('Invalid anchor commitment');
  return `MDTL1|${sessionId}|${from}|${to}|${root}`;
}
export function connection(requestedCluster?:string):Connection {
  // RPC waits and provider retries are bounded; the cluster is explicit.
  const cluster=requestedCluster??process.env.SOLANA_CLUSTER??'devnet';
  if(!['devnet','mainnet-beta'].includes(cluster))throw new Error('Unsupported Solana cluster');
  const endpoint=cluster===(process.env.SOLANA_CLUSTER??'devnet')?process.env.SOLANA_RPC_URL:undefined;
  return new Connection(endpoint??`https://api.${cluster}.solana.com`,{commitment:'confirmed',disableRetryOnRateLimit:true,confirmTransactionInitialTimeout:30000,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(10000)})});
}

export async function verifyAnchor(anchor:Record<string,any>,expectedSigner:string):Promise<{verified:boolean;reason?:string}> {
  // Inspect finalized transaction instructions and signer, not just an explorer URL.
  try {
    if(!['devnet','mainnet-beta'].includes(anchor.cluster))return {verified:false,reason:'cluster_mismatch'};
    if(!anchor.tx_signature)return {verified:false,reason:'not_submitted'};
    const tx=await connection(anchor.cluster).getParsedTransaction(anchor.tx_signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(!tx||!tx.meta||tx.meta.err)return {verified:false,reason:'not_finalized_or_failed'};
    const signer=tx.transaction.message.accountKeys.some(key=>key.signer&&key.pubkey.toBase58()===expectedSigner);
    const expected=anchorMemo(anchor.session_id,anchor.from_seq,anchor.to_seq,anchor.merkle_root);
    const memo=tx.transaction.message.instructions.some(instruction=>instruction.programId.toBase58()===MEMO&&'parsed' in instruction&&instruction.parsed===expected);
    return {verified:signer&&memo,reason:signer&&memo?undefined:'memo_or_signer_mismatch'};
  } catch {return {verified:false,reason:'rpc_unavailable'};}
}

export async function anchorOnce(pool:Pool,sessionId?:string):Promise<Record<string,unknown>> {
  // Only this project's configured key signs; daily and per-transaction caps bound fees.
  if(!process.env.SOLANA_SECRET_KEY_JSON)return {status:'disabled',reason:'wallet_not_configured'};
  const db=await pool.connect();
  let locked=false;
  try {
    locked=(await db.query('SELECT pg_try_advisory_lock(71420261029) AS locked')).rows[0].locked;
    if(!locked)return {status:'busy'};
    const cluster=process.env.SOLANA_CLUSTER??'devnet',rpc=connection();
    const key=await Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY_JSON)));
    if(process.env.SOLANA_PUBLIC_KEY!==key.publicKey.toBase58())throw new Error('Configured signer public key mismatch');
    // Recover the oldest durable transaction before allocating another range or fee.
    const pending=await db.query("SELECT * FROM anchors WHERE cluster=$1 AND raw_tx IS NOT NULL AND status<>'FINALIZED' ORDER BY created_at LIMIT 1",[cluster]);
    if(pending.rowCount) {
      const row=pending.rows[0];
      if(row.signer!==key.publicKey.toBase58())return {status:'signer_changed',signature:row.tx_signature};
      const result=await deliverAnchor(row,rpc);
      await db.query('UPDATE anchors SET status=$2,updated_at=$3 WHERE id=$1',[row.id,result.status,Date.now()]);
      return {...result,signature:row.tx_signature,session_id:row.session_id,cluster};
    }
    const daily=await db.query('SELECT COUNT(*)::int AS count FROM anchors WHERE created_at>$1 AND cluster=$2',[Date.now()-86400000,cluster]);
    const maxDaily=Number(process.env.MAX_ANCHORS_PER_DAY??24);
    if(!Number.isSafeInteger(maxDaily)||maxDaily<1||daily.rows[0].count>=maxDaily)return {status:'daily_limit'};
    const rows=await db.query("SELECT s.*,COALESCE((SELECT MAX(a.to_seq)+1 FROM anchors a WHERE a.session_id=s.session_id AND a.cluster=$2),0) AS from_seq FROM sessions s WHERE ($1::uuid IS NULL OR s.session_id=$1) AND s.event_count>COALESCE((SELECT MAX(a.to_seq)+1 FROM anchors a WHERE a.session_id=s.session_id AND a.cluster=$2),0) ORDER BY s.started_at LIMIT 1",[sessionId??null,cluster]);
    if(!rows.rowCount)return {status:'no_new_events'};
    const session=rows.rows[0],events=await readEvents(db,session.session_id);
    // A concurrent append is retried next tick rather than anchoring a mixed snapshot.
    const verification=checkJournal(events,session);
    if(!verification.ok||!await verifyGiveawayRecords(db,events))return {status:'journal_changed_or_invalid'};
    const from=Number(session.from_seq),to=events.length-1;
    const root=merkleRoot(events.slice(from).map(event=>Buffer.from(event.event_hash,'hex')));
    const recent=await rpc.getLatestBlockhash('confirmed');
    const tx=new Transaction({feePayer:key.publicKey,...recent});
    tx.add(new TransactionInstruction({programId:new PublicKey(MEMO),keys:[{pubkey:key.publicKey,isSigner:true,isWritable:false}],data:Buffer.from(anchorMemo(session.session_id,from,to,root))}));
    const fee=await tx.getEstimatedFee(rpc);
    const limit=BigInt(process.env.MAX_ANCHOR_FEE_LAMPORTS??'10000');
    if(fee===null||fee>limit||limit<1n||limit>50000n)throw new Error('Anchor fee exceeds configured limit');
    const balance=await rpc.getBalance(key.publicKey);
    if(balance<BigInt(fee)+1000000n)return {status:'insufficient_balance'};
    await tx.sign(key);
    if(!tx.signature)throw new Error('Transaction signature missing');
    const signature=encodeSignature(tx.signature),raw=Buffer.from(await tx.serialize()).toString('base64'),id=randomUUID();
    // Autocommit completes before any broadcast: a lost response cannot lose transaction identity.
    await db.query("INSERT INTO anchors(id,session_id,from_seq,to_seq,merkle_root,tx_signature,cluster,created_at,raw_tx,last_valid_height,status,signer,fee_lamports,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED',$11,$12,$8)",[id,session.session_id,from,to,root,signature,cluster,Date.now(),raw,String(recent.lastValidBlockHeight),key.publicKey.toBase58(),String(fee)]);
    const result=await deliverAnchor({tx_signature:signature,raw_tx:raw,last_valid_height:String(recent.lastValidBlockHeight)},rpc);
    await db.query('UPDATE anchors SET status=$2,updated_at=$3 WHERE id=$1',[id,result.status,Date.now()]);
    return {...result,signature,root,session_id:session.session_id,cluster,fee_lamports:String(fee)};
  } finally {if(locked)await db.query('SELECT pg_advisory_unlock(71420261029)');db.release();}
}
