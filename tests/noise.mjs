import fs from 'node:fs';
import assert from 'node:assert/strict';
const bytes=fs.readFileSync(new URL('../soundproof.wasm',import.meta.url));
const {instance}=await WebAssembly.instantiate(bytes,{env:{log10:Math.log10,cos:Math.cos,sin:Math.sin}});
const w=instance.exports;
const sr=48000,channels=1;
function scan(name,fill){
  const pcm=new Float32Array(sr*4);
  for(let i=0;i<pcm.length;i++)pcm[i]=fill(i);
  w.reset_alloc();const pointer=w.allocate(pcm.byteLength);
  assert(pointer>0);new Float32Array(w.memory.buffer,pointer,pcm.length).set(pcm);
  assert.equal(w.analyze(pointer,pcm.length,channels,sr,Math.pow(10,-50/20),350),0);
  const vals=Array.from({length:28},(_,i)=>w.metric(i));
  const out={quiet:vals[21],hum:w.event_count(3),hiss:w.event_count(4),freq:vals[25]};
  console.log(name,out);return out;
}
const hum=scan('50 Hz hum',i=>.003*Math.sin(i*2*Math.PI*50/sr));
assert(hum.quiet>=2&&hum.hum>=2,'quiet pure 50Hz tone should be a hum candidate');
assert.equal(hum.freq,50);
let seed=1234;const noise=scan('wideband noise',()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return ((seed/4294967296)*2-1)*.004;});
assert(noise.hiss>=2,'quiet white noise should trigger hiss candidate');
const silence=scan('digital silence',()=>0);
assert.equal(silence.hum,0);assert.equal(silence.hiss,0);
console.log('Noise screening tests passed.');
