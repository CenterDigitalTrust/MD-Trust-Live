import {jwtVerify} from 'jose';
import {canonicalize,sha256,verifySignature} from './mdtl/core.ts';

export interface TwitchIdentity {channelId:string;role:string;userId?:string;opaqueId:string}

export async function authenticateTwitch(authorization:string|undefined,secret:string,broadcaster=false):Promise<TwitchIdentity> {
  // Verify signature and expiration before trusting any channel or role claim.
  try {
    if(!authorization?.startsWith('Bearer ')) throw new Error('Missing bearer token');
    const key=Buffer.from(secret,'base64');
    if(key.length<32||key.toString('base64')!==secret) throw new Error('Invalid extension secret configuration');
    const {payload}=await jwtVerify(authorization.slice(7),key,{algorithms:['HS256'],requiredClaims:['exp','channel_id','role','opaque_user_id']});
    if(typeof payload.channel_id!=='string'||!/^\d+$/.test(payload.channel_id)) throw new Error('Invalid channel');
    if(!['viewer','moderator','broadcaster'].includes(String(payload.role))) throw new Error('Invalid role');
    if(broadcaster&&payload.role!=='broadcaster') throw new Error('Broadcaster role required');
    if(typeof payload.opaque_user_id!=='string') throw new Error('Invalid viewer identity');
    const userId=typeof payload.user_id==='string'&&/^\d+$/.test(payload.user_id)?payload.user_id:undefined;
    return {channelId:payload.channel_id,role:String(payload.role),opaqueId:payload.opaque_user_id,userId};
  } catch {throw Object.assign(new Error('Twitch authorization rejected'),{statusCode:401});}
}

export function deviceMessage(method:string,path:string,timestamp:number,body:unknown):string {
  // Canonical bodies let Dart and Node produce identical request commitments.
  return `MDTL1-REQ\n${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256(body===undefined?'':canonicalize(body))}`;
}

export function authenticateDevice(authorization:string|undefined,method:string,path:string,body:unknown,spki:string,now=Date.now()):string {
  // The caller must resolve the device key and apply operation replay protection.
  try {
    const match=/^MDTL1 device_id=([a-zA-Z0-9_-]{1,128}),ts=(\d{1,16}),sig=([A-Za-z0-9+/]+=*)$/.exec(authorization??'');
    if(!match) throw new Error('Malformed device authorization');
    const timestamp=Number(match[2]);
    if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>60000) throw new Error('Expired device request');
    if(!verifySignature(deviceMessage(method,path,timestamp,body),match[3],spki)) throw new Error('Invalid request signature');
    return match[1];
  } catch {throw Object.assign(new Error('Device authorization rejected'),{statusCode:401});}
}
