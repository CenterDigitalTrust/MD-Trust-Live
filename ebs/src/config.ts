export interface Config {port:number;host:string;databaseUrl:string;extensionId:string;extensionSecret:string;requireTwitchLive:boolean}

export function loadConfig(env:NodeJS.ProcessEnv=process.env):Config {
  // Fail at startup rather than running with missing authentication credentials.
  const port=Number(env.PORT??8080),host=env.HOST??'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be 1–65535');
  const databaseUrl=env.DATABASE_URL??'',extensionId=env.TWITCH_EXTENSION_ID??'',extensionSecret=env.TWITCH_EXTENSION_SECRET??'';
  if(!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must use PostgreSQL');
  if(!/^[a-zA-Z0-9]{10,64}$/.test(extensionId)) throw new Error('TWITCH_EXTENSION_ID is required');
  if(Buffer.from(extensionSecret,'base64').length<32||Buffer.from(extensionSecret,'base64').toString('base64')!==extensionSecret) throw new Error('TWITCH_EXTENSION_SECRET must be canonical base64, at least 32 bytes');
  return {port,host,databaseUrl,extensionId,extensionSecret,requireTwitchLive:env.REQUIRE_TWITCH_LIVE!=='false'};
}
