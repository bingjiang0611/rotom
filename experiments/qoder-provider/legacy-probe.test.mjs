import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeBody,legacyHeaders,LEGACY_PATH,LEGACY_URL} from './legacy-probe.mjs';
test('legacy encoding is lossless for UTF-8 and signature covers exact encoded bytes/path',()=>{
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
  assert.equal(custom.length,65);
  for(const input of ['', 'hello', JSON.stringify({content:'合成内容',model:'dfmodel'})]){
    const encoded=encodeBody(input);const shuffled=[...encoded].map(c=>alphabet[custom.indexOf(c)]).join('');const n=shuffled.length,a=Math.floor(n/3);
    assert.equal(Buffer.from(shuffled.slice(n-a)+shuffled.slice(a,n-a)+shuffled.slice(0,a),'base64').toString('utf8'),input);
  }
  const body=encodeBody('synthetic');const h=legacyHeaders({uid:'fixture',accessToken:'PRIVATE_TOKEN',machineId:'fixture-machine'},body);
  const [payload,signature]=h.Authorization.slice('Bearer COSY.'.length).split('.');
  assert.equal(signature,createHash('md5').update(`${payload}\n${h['Cosy-Key']}\n${h['Cosy-Date']}\n${body}\n${LEGACY_PATH}`).digest('hex'));
  assert.equal(h['Cosy-Bodylength'],String(body.length));assert.equal(h['X-Model-Key'],'dfmodel');assert.equal(new URL(LEGACY_URL).hostname,'api2.qoder.sh');assert.doesNotMatch(JSON.stringify(h),/PRIVATE_TOKEN/);
});
