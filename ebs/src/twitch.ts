export interface LiveResult {live:boolean|null;checkedAt:number;reason?:string}

export class TwitchLiveClient {
  private token='';
  private expires=0;
  private cache=new Map<string,LiveResult>();
  private pending=new Map<string,Promise<LiveResult>>();
  private clientId:string;
  private clientSecret:string;
  constructor(clientId:string,clientSecret:string) {
    // Keep app OAuth credentials separate from the extension signing secret.
    this.clientId=clientId;this.clientSecret=clientSecret;
  }
  async status(channelId:string):Promise<LiveResult> {
    // Coalesce viewer polling and never reuse stale positive status on errors.
    const cached=this.cache.get(channelId);
    if(cached&&Date.now()-cached.checkedAt<10000) return cached;
    const inflight=this.pending.get(channelId);
    if(inflight) return inflight;
    const task=this.fetchStatus(channelId);
    this.pending.set(channelId,task);
    try {const result=await task;this.cache.set(channelId,result);return result;}
    finally {this.pending.delete(channelId);if(this.cache.size>10000)this.cache.clear();}
  }
  private async fetchStatus(channelId:string):Promise<LiveResult> {
    // Bound OAuth and Helix calls; failures produce unknown, not live.
    try {
      if(!this.clientId||!this.clientSecret) throw new Error('twitch_credentials_missing');
      if(Date.now()>=this.expires) {
        const response=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,grant_type:'client_credentials'}),signal:AbortSignal.timeout(5000)});
        if(!response.ok) throw new Error('twitch_oauth_unavailable');
        const data=await response.json() as {access_token?:string;expires_in?:number};
        if(!data.access_token||typeof data.expires_in!=='number') throw new Error('twitch_oauth_invalid');
        this.token=data.access_token;this.expires=Date.now()+Math.max(0,data.expires_in-60)*1000;
      }
      const response=await fetch('https://api.twitch.tv/helix/streams?user_id='+encodeURIComponent(channelId),{headers:{Authorization:'Bearer '+this.token,'Client-Id':this.clientId},signal:AbortSignal.timeout(5000)});
      if(response.status===401)this.expires=0;
      if(!response.ok) throw new Error(response.status===429?'twitch_rate_limited':'twitch_unavailable');
      const data=await response.json() as {data?:Array<{user_id:string;type:string}>};
      if(!Array.isArray(data.data)) throw new Error('twitch_invalid_response');
      return {live:data.data.some(stream=>stream.user_id===channelId&&stream.type==='live'),checkedAt:Date.now()};
    } catch(error) {return {live:null,checkedAt:Date.now(),reason:error instanceof Error?error.message:'twitch_unavailable'};}
  }
}
