import fs from 'node:fs';
import assert from 'node:assert/strict';
const bytes=fs.readFileSync(new URL('../soundproof.wasm',import.meta.url));
const {instance}=await WebAssembly.instantiate(bytes,{env:{log10:Math.log10,cos:Math.cos,sin:Math.sin}});
const w=instance.exports;
assert.equal(w.wasm_version(),2);
const sr=48000,seconds=6,channels=2;
const pcm=new Float32Array(sr*seconds*channels);
for(let i=0;i<sr*seconds;i++){
  const x=i<sr*4?Math.sin(2*Math.PI*1000*i/sr)*.25:0;
  pcm[i*2]=x;pcm[i*2+1]=x;
}
for(let i=sr*2-3;i<=sr*2+3;i++){pcm[i*2]=0;pcm[i*2+1]=0;}
pcm[sr*2*2]=1;pcm[sr*2*2+1]=1;
w.reset_alloc();
const pointer=w.allocate(pcm.byteLength);
assert(pointer>0);
new Float32Array(w.memory.buffer,pointer,pcm.length).set(pcm);
assert.equal(w.analyze(pointer,pcm.length/channels,channels,sr,Math.pow(10,-50/20),350),0);
const metrics=Array.from({length:28},(_,i)=>w.metric(i));
console.log('SamplePeak:',metrics[0].toFixed(2),'TruePeak:',metrics[1].toFixed(2),'LUFS:',metrics[5].toFixed(2),'RMS:',metrics[2].toFixed(2));
console.log('Silences:',w.event_count(0),'Clips:',w.event_count(1),'Channels:',metrics[19]);
console.log('Silence details:',Array.from({length:w.event_count(0)},(_,i)=>[w.event_start(0,i).toFixed(2),w.event_end(0,i).toFixed(2)]));
assert(metrics[0]>-.01 && metrics[0]<.01,'Peak is close to 0 dBFS');
assert(metrics[5]<-10 && metrics[5]>-35,'loudness expected reasonable');
assert.equal(w.event_count(0),1);
assert(Math.abs(w.event_start(0,0)-4)<.15);
assert.equal(w.event_count(1),1);
assert.equal(w.event_count(3),0,'no hum should be claimed without suitable quiet passages');
assert.equal(w.event_count(4),0,'no hiss should be claimed without suitable quiet passages');
assert(w.event_count(2)>=1,'isolated impulse is reported as spike candidate');
assert(metrics[9]>=2);
assert(metrics[4]>.99);
for(let i=0;i<720;i++)assert(Number.isFinite(w.waveform_min(i))&&Number.isFinite(w.waveform_max(i)));
for(let i=0;i<8;i++)assert(Number.isFinite(w.band_value(i)));
console.log('All WebAssembly smoke tests passed.');
