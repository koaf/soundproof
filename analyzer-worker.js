/* Dedicated worker: audio PCM never leaves the browser. */
let wasmPromise;
async function loadEngine(){
  if(!wasmPromise){
    wasmPromise=(async()=>{
      const response=await fetch(new URL('./soundproof.wasm',import.meta.url));
      if(!response.ok)throw new Error('解析エンジンを読み込めません（HTTP '+response.status+'）');
      const bytes=await response.arrayBuffer();
      const {instance}=await WebAssembly.instantiate(bytes,{env:{log10:Math.log10,sin:Math.sin,cos:Math.cos}});
      return instance.exports;
    })();
  }
  return wasmPromise;
}

self.onmessage=async(event)=>{
  const {id,pcm,channels,sampleRate,action}=event.data;
  try{
    if(!(pcm instanceof Float32Array)||!pcm.length||pcm.length%channels!==0)throw new Error('音声データが正しくありません');
    const wasm=await loadEngine();
    wasm.reset_alloc();
    const ptr=wasm.allocate(pcm.byteLength);
    if(!ptr)throw new Error('WebAssemblyのメモリを確保できませんでした');
    new Float32Array(wasm.memory.buffer,ptr,pcm.length).set(pcm);
    const frames=pcm.length/channels;
    if(action==='repair'){
      const {mode,strength,clickIndex}=event.data;
      if(typeof mode!=='number'||typeof strength!=='number')throw new Error('修復条件が不正です');
      const code=wasm.repair_pcm(ptr,frames,channels,sampleRate,mode,strength,clickIndex||0);
      if(code)throw new Error('区間修復に失敗しました ('+code+')');
      const repaired=new Float32Array(new Float32Array(wasm.memory.buffer,ptr,pcm.length));
      self.postMessage({id,action:'repair',pcm:repaired},[repaired.buffer]);
      return;
    }
    const result=wasm.analyze(ptr,frames,channels,sampleRate,Math.pow(10,-50/20),350);
    if(result!==0)throw new Error('WebAssemblyによる解析に失敗しました ('+result+')');
    const metrics=Array.from({length:28},(_,i)=>wasm.metric(i));
    const waveform=Array.from({length:720},(_,i)=>[wasm.waveform_min(i),wasm.waveform_max(i)]);
    const spectrum=Array.from({length:8},(_,i)=>wasm.band_value(i));
    const events=[0,1,2,3,4].map(kind=>Array.from({length:wasm.event_count(kind)},(_,i)=>({start:wasm.event_start(kind,i),end:wasm.event_end(kind,i)})));
    self.postMessage({id,metrics,waveform,spectrum,events});
  }catch(error){self.postMessage({id,error:error.message||String(error)})}
};
