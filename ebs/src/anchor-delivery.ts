interface SavedAnchor {tx_signature:string;raw_tx:string;last_valid_height:string}
interface DeliveryRpc {
  getSignatureStatuses(signatures:string[],config:{searchTransactionHistory:boolean}):Promise<{value:({err:unknown;confirmationStatus?:string|null}|null)[]}>;
  getBlockHeight(commitment:'finalized'):Promise<bigint|number>;
  sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:boolean;preflightCommitment:'confirmed';maxRetries:bigint}):Promise<string>;
}
export function encodeSignature(bytes:Uint8Array):string {
  // Base58 encodes the existing Ed25519 signature without altering signed content.
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number=0n,result='';
  for(const byte of bytes)number=number*256n+BigInt(byte);
  while(number>0n){result=alphabet[Number(number%58n)]+result;number/=58n;}
  for(const byte of bytes){if(byte!==0)break;result='1'+result;}
  return result;
}
export async function deliverAnchor(record:SavedAnchor,rpc:DeliveryRpc):Promise<{status:string;reason?:string}> {
  // Durable bytes survive restarts; RPC uncertainty never authorizes a fresh signature.
  try {
    const status=(await rpc.getSignatureStatuses([record.tx_signature],{searchTransactionHistory:true})).value[0];
    if(status?.err)return {status:'FAILED',reason:'transaction_failed'};
    if(status?.confirmationStatus==='finalized')return {status:'FINALIZED'};
    if(status)return {status:'SUBMITTED'};
    if(BigInt(await rpc.getBlockHeight('finalized'))>BigInt(record.last_valid_height))return {status:'EXPIRED_UNKNOWN',reason:'manual_reconciliation_required'};
    const signature=await rpc.sendRawTransaction(Buffer.from(record.raw_tx,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2n});
    if(signature!==record.tx_signature)return {status:'PENDING',reason:'rpc_signature_mismatch'};
    return {status:'SUBMITTED'};
  } catch {return {status:'PENDING',reason:'rpc_unavailable_or_response_lost'};}
}
