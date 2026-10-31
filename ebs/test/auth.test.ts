import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {SignJWT} from 'jose';
import {authenticateTwitch,authenticateDevice,deviceMessage} from '../src/auth.ts';

test('Twitch accepts signed scoped tokens and rejects expired, forged and viewer-as-owner',async()=>{
  // Use ephemeral secrets so tests never depend on user credentials.
  const key=randomBytes(32),secret=key.toString('base64');
  async function token(role:string,expiration:number,signingKey=key):Promise<string> {
    // Mirror documented Twitch claims with a short test lifetime.
    return 'Bearer '+await new SignJWT({channel_id:'123',role,opaque_user_id:'Utest',user_id:'456'}).setProtectedHeader({alg:'HS256'}).setExpirationTime(expiration).sign(signingKey);
  }
  const expiry=Math.floor(Date.now()/1000)+60;
  assert.equal((await authenticateTwitch(await token('broadcaster',expiry),secret,true)).channelId,'123');
  await assert.rejects(authenticateTwitch(await token('viewer',expiry),secret,true));
  await assert.rejects(authenticateTwitch(await token('viewer',1),secret));
  await assert.rejects(authenticateTwitch(await token('viewer',expiry,randomBytes(32)),secret));
});

test('device authorization binds time, method, path and canonical body',()=>{
  // Independently sign one request, then test each modified component.
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=publicKey.export({type:'spki',format:'der'}).toString('base64'),now=Date.now(),body={session_id:'test'};
  const signature=sign('sha256',Buffer.from(deviceMessage('POST','/v1/events',now,body)),privateKey).toString('base64');
  const auth=`MDTL1 device_id=test,ts=${now},sig=${signature}`;
  assert.equal(authenticateDevice(auth,'POST','/v1/events',body,spki,now),'test');
  assert.throws(()=>authenticateDevice(auth,'POST','/v1/events',body,spki,now+60001));
  assert.throws(()=>authenticateDevice(auth,'GET','/v1/events',body,spki,now));
  assert.throws(()=>authenticateDevice(auth,'POST','/v1/session/start',body,spki,now));
  assert.throws(()=>authenticateDevice(auth,'POST','/v1/events',{session_id:'other'},spki,now));
});
