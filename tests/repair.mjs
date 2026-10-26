import fs from 'node:fs';
import assert from 'node:assert/strict';
const wasmBytes=fs.readFileSync(new URL('../soundproof.wasm',import.meta.url));
const {instance}=await WebAssembly.instantiate(wasmBytes,{env:{log10:Math.log10,cos:Math.cos,sin:Math.sin}});
const w=instance.exports,sr=48000,N=sr,pi=Math.PI;
function run(mode,strength,input,clickIndex=0,channels=1){
  const original=new Float32Array(input);w.reset_alloc();const ptr=w.allocate(original.byteLength);
  assert(ptr>0);new Float32Array(w.memory.buffer,ptr,original.length).set(original);
  assert.equal(w.repair_pcm(ptr,original.length/channels,channels,sr,mode,strength,clickIndex),0);
  return Float32Array.from(new Float32Array(w.memory.buffer,ptr,original.length));
}
function component(pcm,f){let sin=0,cos=0;for(let i=0;i<pcm.length;i++){sin+=pcm[i]*Math.sin(i*2*pi*f/sr);cos+=pcm[i]*Math.cos(i*2*pi*f/sr);}return 2*Math.hypot(sin,cos)/pcm.length;}
const hum=Float32Array.from({length:N},(_,i)=>.1*Math.sin(i*2*pi*50/sr));
const removed=run(1,1,hum);
const before=component(hum,50),after=component(removed,50);
assert(after<before*.35,`50Hz must be attenuated, got ${(20*Math.log10(after/before)).toFixed(1)} dB`);
assert.equal(run(1,0,hum)[N/2],hum[N/2]);
const clicked=new Float32Array(4800);clicked[2400]=.9;
const smoothed=run(4,1,clicked,2400);
assert(Math.abs(smoothed[2400])<.01,'short click should interpolate');
assert.equal(smoothed[100],clicked[100]);
const clipped=Float32Array.from({length:N},()=>.4);
const attenuated=run(5,1,clipped);
assert(attenuated[N/2]<.06,'region attenuation should work');
assert(Math.abs(attenuated[0]-.4)<1e-6,'start boundary should not have a hard cut');
console.log('WASM region repairs passed:', {humAttenuationDb:(20*Math.log10(after/before)).toFixed(1),clicked:smoothed[2400],gain:attenuated[N/2]});
