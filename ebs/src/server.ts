import {readFile} from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type {Config} from './config.ts';

export async function buildServer(config:Config,checkDatabase:()=>Promise<void>) {
  // Configure bounded requests, scoped origins, redacted logs and safe errors.
  const app=Fastify({bodyLimit:65536,logger:{redact:['req.headers.authorization','req.headers.cookie']},requestTimeout:15000});
  await app.register(cors,{origin:`https://${config.extensionId}.ext-twitch.tv`,methods:['GET','POST'],allowedHeaders:['Authorization','Content-Type']});
  await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
  app.setErrorHandler((error,request,reply)=>{
    // Log internal diagnostics without exposing stack traces or database secrets.
    const failure=error instanceof Error?error as Error & {statusCode?:number}:new Error('Request failed');
    const status='statusCode' in failure?failure.statusCode:undefined;
    const code=typeof status==='number'&&status>=400&&status<500?status:500;
    request.log.warn({code},'Request failed');
    reply.code(code).send({error:code===500?'Internal server error':failure.message});
  });
  app.get('/health',async(_request,reply)=>{
    // Readiness includes a real database query, not only process availability.
    try {await checkDatabase();return {status:'ok',service:'md-twitch-trust',version:'0.1.0'};}
    catch {return reply.code(503).send({status:'unavailable',reason:'database'});}
  });
  app.get('/extension/*',async(request,reply)=>{
    // Serve only known public build paths; credentials and source files cannot be requested.
    const path=(request.params as {'*':string})['*']||'panel.html';
    if(!/^(?:(?:index|panel|mobile|config)\.html|assets\/[a-zA-Z0-9._-]+\.(?:js|css))$/.test(path))return reply.code(404).send({error:'Asset not found'});
    try {
      const content=await readFile(new URL('../../panel/dist/'+path,import.meta.url));
      const mime=path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8';
      return reply.header('X-Content-Type-Options','nosniff').header('Cache-Control',path.startsWith('assets/')?'public, max-age=31536000, immutable':'no-cache').type(mime).send(content);
    } catch {return reply.code(404).send({error:'Asset unavailable'});}
  });
  return app;
}
