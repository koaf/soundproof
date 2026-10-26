"""Headless UI regression test. Inline worker data URL bypasses local URL policy of this test container.
Production app uses ./analyzer-worker.js and ./soundproof.wasm unchanged."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import base64
import shutil
root=Path(__file__).parent.parent
html=(root/'index.html').read_text().replace('<script type="module" src="./app.js"></script>','').replace('<link rel="stylesheet" href="./styles.css" />','')
js=(root/'app.js').read_text().replace("new URL('./analyzer-worker.js',import.meta.url)","'test-worker'")
wasm=base64.b64encode((root/'soundproof.wasm').read_bytes()).decode()
shim=r"""(() => {
 window.Worker=class LocalTestWorker {
  constructor(){this.onmessage=null;this.onerror=null;this.ready=WebAssembly.instantiate(Uint8Array.from(atob('WASM_BYTES'),c=>c.charCodeAt(0)),{env:{log10:Math.log10,cos:Math.cos,sin:Math.sin}}).then(obj=>obj.instance.exports);}
  postMessage({id,pcm,channels,sampleRate,action,mode,strength,clickIndex}){
   this.ready.then(wasm=>{wasm.reset_alloc();const ptr=wasm.allocate(pcm.byteLength);if(!ptr)throw Error('alloc failed');new Float32Array(wasm.memory.buffer,ptr,pcm.length).set(pcm);
    if(action==='repair'){
     const code=wasm.repair_pcm(ptr,pcm.length/channels,channels,sampleRate,mode,strength,clickIndex||0);
     if(code)throw Error('repair '+code);
     const repaired=new Float32Array(new Float32Array(wasm.memory.buffer,ptr,pcm.length));
     this.onmessage?.({data:{id,action:'repair',pcm:repaired}});return;
    }
    const code=wasm.analyze(ptr,pcm.length/channels,channels,sampleRate,Math.pow(10,-50/20),350);if(code)throw Error('analyze '+code);
    const metrics=Array.from({length:28},(_,i)=>wasm.metric(i));
    const waveform=Array.from({length:720},(_,i)=>[wasm.waveform_min(i),wasm.waveform_max(i)]);
    const spectrum=Array.from({length:8},(_,i)=>wasm.band_value(i));
    const events=[0,1,2,3,4].map(kind=>Array.from({length:wasm.event_count(kind)},(_,i)=>({start:wasm.event_start(kind,i),end:wasm.event_end(kind,i)})));
    this.onmessage?.({data:{id,metrics,waveform,spectrum,events}});
   }).catch(error=>this.onmessage?.({data:{id,error:String(error)}}));
  }
 };})()""".replace('WASM_BYTES',wasm)
with sync_playwright() as p:
 browser_binary=shutil.which('chromium') or shutil.which('chromium-browser') or shutil.which('google-chrome')
 launch_options={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']}
 if browser_binary:launch_options['executable_path']=browser_binary
 b=p.chromium.launch(**launch_options)
 page=b.new_page(accept_downloads=True,viewport={'width':1280,'height':960})
 errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.on('console',lambda m: errors.append('console error: '+m.text) if m.type=='error' else None)
 page.set_content(html)
 page.add_style_tag(content=(root/'styles.css').read_text())
 page.evaluate(shim)
 page.add_script_tag(content=js)
 print('load title',page.title(),'eq bands',page.locator('.param-row').count())
 assert page.locator('.param-row').count()==5
 assert page.locator('#fileInput').get_attribute('multiple') is not None
 page.locator('#fileInput').set_input_files([str(root/'tests/samples/hum.wav'),str(root/'tests/samples/vocals.wav'),str(root/'tests/samples/invalid.txt')])
 page.wait_for_function("document.getElementById('batchProgress').textContent.includes('3 / 3')",timeout=90000)
 print('batch progress',page.locator('#batchProgress').inner_text())
 print('batch table',page.locator('#batchRows').inner_text()[:800])
 assert page.locator('#batchRows tr').count()==3
 assert page.locator('#batchRows .batch-status.error').count()==1
 assert page.locator('#batchRows .batch-status.warn').count()>=1
 assert not page.locator('#results').is_hidden()
 page.locator('#tabDetailed').click()
 print('noise metrics',page.locator('#noiseMetrics').inner_text()[:400])
 path_before=page.locator('#eqPath').get_attribute('d')
 gain=page.locator('.param-row').nth(1).locator('input[type=range]').nth(1)
 gain.fill('8')
 gain.dispatch_event('input')
 path_after=page.locator('#eqPath').get_attribute('d')
 print('curve changed',path_before!=path_after)
 assert path_before!=path_after
 with page.expect_download(timeout=30000) as download:
  page.locator('#batchCsvButton').click()
 print('batch CSV',download.value.suggested_filename)
 with page.expect_download(timeout=30000) as download:
  page.locator('#exportWavButton').click()
 print('rendered WAV',download.value.suggested_filename)
 page.screenshot(path=str(root/'tests/soundproof-v03-desktop.png'),full_page=True)
 page.locator('.batch-open').first.click()
 page.wait_for_function("document.getElementById('fileName').textContent === 'hum.wav'",timeout=90000)
 print('hum detail:',page.locator('#issueList').inner_text()[:600])
 assert 'ハムノイズ候補' in page.locator('#issueList').inner_text()
 page.locator('#tabSimple').click()
 assert page.locator('#noiseCandidateList button').count()>0
 page.locator('#noiseCandidateList button').first.click()
 assert not page.locator('#listenOriginal').is_disabled()
 assert not page.locator('#listenRepaired').is_disabled()
 print('selected noise:',page.locator('#selectionTimes').inner_text())
 page.locator('#listenOriginal').click()
 page.wait_for_timeout(200)
 page.locator('#listenRepaired').click()
 page.wait_for_timeout(350)
 page.locator('#applyRepair').click()
 page.wait_for_function("document.getElementById('repairStatus').textContent.includes('適用しました')",timeout=90000)
 print('repair status:',page.locator('#repairStatus').inner_text())
 assert not page.locator('#undoRepair').is_disabled()
 with page.expect_download(timeout=30000) as repair_download:
  page.locator('#tabDetailed').click()
  page.locator('#exportWavButton').click()
 print('repaired WAV:',repair_download.value.suggested_filename)
 import wave
 with wave.open(str(root/'tests/samples/hum.wav'),'rb') as source, wave.open(str(repair_download.value.path()),'rb') as saved:
  assert saved.getnchannels()==source.getnchannels() and saved.getframerate()==source.getframerate()
  assert source.readframes(15000)!=saved.readframes(15000),'repair WAV must differ from original in target section'
 print('repair confirmed: WAV PCM changed in target section')
 page.locator('#tabSimple').click()
 page.locator('#undoRepair').click()
 assert page.locator('#undoRepair').is_disabled()
 page.locator('.waveform-wrap').scroll_into_view_if_needed()
 wrap=page.locator('.waveform-wrap').bounding_box()
 page.mouse.move(wrap['x']+wrap['width']*.28,wrap['y']+wrap['height']*.40)
 page.mouse.down()
 page.mouse.move(wrap['x']+wrap['width']*.37,wrap['y']+wrap['height']*.40,steps=8)
 page.mouse.up()
 assert not page.locator('#applyRepair').is_disabled()
 print('manual method:',page.locator('#repairMethod').input_value(),'times:',page.locator('#selectionTimes').inner_text())
 assert page.locator('#repairMethod').input_value()=='5'
 print('manual selection:',page.locator('#selectionTimes').inner_text())

 page.set_viewport_size({'width':390,'height':844})
 page.screenshot(path=str(root/'tests/soundproof-v03-mobile.png'),full_page=True)
 print('pageerrors:',errors)
 assert not errors
 b.close()
