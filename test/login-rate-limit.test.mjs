import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginLimiter,loginAddress} from '../login-rate-limit.mjs';
import {runtimeConfig} from '../runtime-config.mjs';
const req = (ip='127.0.0.1',xff='')=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':xff}});
test('login limits isolate accounts behind one proxy and ignore forged forwarding headers',()=>{
 let clock=0;const limiter=createLoginLimiter({now:()=>clock}),config=runtimeConfig({});
 for(let i=0;i<10;i++)limiter.fail(limiter.check(req(),'Admin',true,config),true);
 assert.throws(()=>limiter.check(req('127.0.0.1','203.0.113.9'),'ＡＤＭＩＮ',true,config),e=>e.status===429);
 assert.doesNotThrow(()=>limiter.check(req(),'Other-User',true,config));
 clock=15*60_000;limiter.prune();assert.doesNotThrow(()=>limiter.check(req(),'admin',true,config));
 assert.equal(loginAddress(req('192.168.1.8','203.0.113.9'),runtimeConfig({WORKBENCH_TRUST_PROXY:'true'})),'192.168.1.8');
 const trusted=runtimeConfig({WORKBENCH_TRUST_PROXY:'true',WORKBENCH_TRUSTED_PROXIES:'192.168.1.8'});
 assert.equal(loginAddress(req('192.168.1.8','198.51.100.1, 203.0.113.9'),trusted),'203.0.113.9');
 assert.equal(loginAddress(req('192.168.1.8','invalid'),trusted),'192.168.1.8');
 assert.throws(()=>runtimeConfig({WORKBENCH_TRUSTED_PROXIES:'*'}),/反代 IP/);
});
test('distributed guesses remain account-limited and request bursts have a short global bound',()=>{
 let clock=0;const config=runtimeConfig({WORKBENCH_TRUST_PROXY:'true',WORKBENCH_TRUSTED_PROXIES:'127.0.0.1'}),limiter=createLoginLimiter({now:()=>clock});
 for(let i=0;i<30;i++)limiter.fail(limiter.check(req('127.0.0.1',`203.0.113.${i+1}`),'admin',true,config),true);
 assert.throws(()=>limiter.check(req('127.0.0.1','203.0.113.99'),'admin',true,config),e=>e.status===429);
 for(let i=31;i<120;i++)limiter.check(req(),`unknown-${i}`,false,config);
 assert.throws(()=>limiter.check(req(),'other',true,config),e=>e.status===429);
 clock=60_000;assert.doesNotThrow(()=>limiter.check(req(),'other',true,config));
 assert.throws(()=>limiter.check(req(),'admin',true,config),e=>e.status===429);
});
