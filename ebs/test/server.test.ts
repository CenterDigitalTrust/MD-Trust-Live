import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../src/server.ts';
import type {Config} from '../src/config.ts';

test('readiness fails when database is unavailable and CORS is scoped',async()=>{
  // Exercise real Fastify routing without opening an external listener.
  const config:Config={host:'127.0.0.1',port:8080,databaseUrl:'postgresql://localhost/test',extensionId:'testextension123',extensionSecret:Buffer.alloc(32,1).toString('base64'),requireTwitchLive:true};
  let healthy=true;
  const app=await buildServer(config,async()=>{if(!healthy) throw new Error('Database unavailable');});
  try {
    const good=await app.inject({url:'/health',headers:{origin:'https://testextension123.ext-twitch.tv'}});
    assert.equal(good.statusCode,200);
    assert.equal(good.headers['access-control-allow-origin'],'https://testextension123.ext-twitch.tv');
    healthy=false;
    const bad=await app.inject({url:'/health'});
    assert.equal(bad.statusCode,503);
    assert.equal(bad.json().reason,'database');
  } finally {await app.close();}
});
