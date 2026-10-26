// SoundProof v0.3 — static, account-free, on-device audio QC tool.
// All file reading, analysis and rendering happen on the user's own device.
const $=id=>document.getElementById(id);
const refs={
  drop:$('dropZone'),fileInput:$('fileInput'),choose:$('chooseButton'),busy:$('processing'),busyMessage:$('processingMessage'),error:$('errorBox'),
  results:$('results'),engine:$('engineState'),fileName:$('fileName'),fileMeta:$('fileMeta'),
  simple:$('simplePanel'),detailed:$('detailedPanel'),simpleTab:$('tabSimple'),detailTab:$('tabDetailed'),preset:$('presetSelect'),
  verdict:$('verdict'),verdictIcon:$('verdictIcon'),verdictTitle:$('verdictTitle'),verdictDescription:$('verdictDescription'),verdictCount:$('verdictCount'),
  metrics:$('quickMetrics'),issues:$('issueList'),details:$('detailList'),spectrum:$('spectrumChart'),wave:$('waveCanvas'),playhead:$('playhead'),play:$('playButton'),playerTime:$('playerTime'),
  eqOn:$('eqToggle'),eqPath:$('eqPath'),report:$('reportButton'),export:$('exportWavButton'),
  batch:$('batchSection'),batchRows:$('batchRows'),batchProgress:$('batchProgress'),batchCSV:$('batchCsvButton'),noise:$('noiseMetrics'),
  selectionOverlay:$('selectedRange'),candidateList:$('noiseCandidateList'),candidateCount:$('repairCandidateCount'),selectionTimes:$('selectionTimes'),repairMethod:$('repairMethod'),repairStrength:$('repairStrength'),repairStrengthValue:$('repairStrengthValue'),listenOriginal:$('listenOriginal'),listenRepaired:$('listenRepaired'),applyRepair:$('applyRepair'),undoRepair:$('undoRepair'),repairStatus:$('repairStatus')
};
const MAX_SIZE=130*1024*1024;
const DEFAULTS={
 vocal:{name:'歌い手 / ボーカル',min:-22,max:-11,peak:-1},
 narration:{name:'ナレーション',min:-22,max:-14,peak:-1},
 video:{name:'動画編集',min:-20,max:-12,peak:-1},
 general:{name:'汎用',min:-24,max:-9,peak:-0.5}
};
const BAND_NAMES=['0–120','120–300','300–700','700–1.5k','1.5–3k','3–6k','6–12k','12–24k'];
let worker=new Worker(new URL('./analyzer-worker.js',import.meta.url),{type:'module'});
let analysisId=0,buffer=null,file=null,sourceFormat=null,result=null,issues=[],audioCtx=null,sourceNode=null,wetGain=null,dryGain=null,eqNodes=null;
let batchEntries=[],batchBusy=false,selectedEntryId=null,nextEntryId=0;
const pendingAnalyses=new Map();
let isPlaying=false,playOffset=0,startedAt=0,frameHandle=0;
const EQ_PRESETS=[
  {type:'lowshelf',freq:100,gain:0,q:.7,enabled:true},
  {type:'peaking',freq:350,gain:0,q:1,enabled:true},
  {type:'peaking',freq:1300,gain:0,q:1,enabled:true},
  {type:'peaking',freq:4200,gain:0,q:1,enabled:true},
  {type:'highshelf',freq:10000,gain:0,q:.7,enabled:true}
];
let eqBands=EQ_PRESETS.map(b=>({...b}));
const FILTER_LABELS={lowshelf:'Low shelf',peaking:'Bell',highshelf:'High shelf',highpass:'High pass',lowpass:'Low pass'};
const hzLabel=n=>n>=1000?(n/1000).toFixed(n%1000?1:0)+' kHz':Math.round(n)+' Hz';
const freqToSlider=f=>Math.round(Math.log(f/20)/Math.log(1000)*1000);
const sliderToFreq=v=>Math.round(20*Math.pow(1000,Number(v)/1000));
let exporting=false;
let selectedNoise=null,noiseCandidates=[],undoSnapshot=null,hasEdits=false,repairBusy=false,previewNode=null,previewLabel=null;
let selectionDrag=null;
const MAX_REPAIR_SECONDS=20;
const MODE_LABELS={1:'50Hzハム抑制',2:'60Hzハム抑制',3:'高域ノイズ軽減',4:'クリック補間',5:'選択区間減衰'};


function setBusy(value,message=''){
  refs.busy.hidden=!value;refs.choose.disabled=value;refs.fileInput.disabled=value;
  if(message)refs.busyMessage.textContent=message;
  refs.engine.innerHTML=value?'<span class="spinner"></span> ANALYZING':'<span class="status-pulse"></span> WASM ENGINE READY';
}
function showError(message){refs.error.hidden=false;refs.error.textContent=message;setBusy(false);}
function clearError(){refs.error.hidden=true;refs.error.textContent='';}
function fmt(value,digits=1){return Number.isFinite(value)?value.toFixed(digits):'—';}
function fmtDuration(seconds){if(!Number.isFinite(seconds))return '00:00';const s=Math.max(0,Math.floor(seconds));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function bytes(n){return n>=1024*1024?(n/1024/1024).toFixed(1)+' MB':(n/1024).toFixed(0)+' KB';}
function ext(name){return (name.split('.').pop()||'').toLowerCase();}

// Only WAV contains easily accessible, reliable source sample rate / depth in this version.
function parseWavInfo(bytes){
  const view=new DataView(bytes);
  if(view.byteLength<44||view.getUint32(0,true)!==0x46464952||view.getUint32(8,true)!==0x45564157)return null;
  let offset=12;
  while(offset+8<=view.byteLength){
    const id=view.getUint32(offset,true),size=view.getUint32(offset+4,true);
    if(id===0x20746d66&&size>=16&&offset+24<=view.byteLength){
      const tag=view.getUint16(offset+8,true),channels=view.getUint16(offset+10,true);
      const rate=view.getUint32(offset+12,true),bitDepth=view.getUint16(offset+22,true);
      const isFloat=tag===3||(tag===0xfffe&&view.byteLength>=offset+34&&view.getUint16(offset+32,true)===3);
      return {name:'WAV '+(isFloat?'Float':'PCM'),rate,bitDepth,channels};
    }
    offset+=8+size+(size&1);
  }
  return null;
}
async function ensureAudioContext(){
  if(!audioCtx){
    try{audioCtx=new AudioContext({sampleRate:48000,latencyHint:'playback'});}catch{throw new Error('このブラウザでは48 kHzのAudioContextを作成できませんでした。別のブラウザをお試しください。');}
  }
  return audioCtx;
}
function interleave(data){
  const channels=data.numberOfChannels,frames=data.length;
  if(channels<1||channels>2)throw new Error('現時点ではモノラルまたはステレオのみ対応しています。');
  if(frames*channels*4>250*1024*1024)throw new Error('解析用メモリが大きすぎます。短い音声に分割してください。');
  const pcm=new Float32Array(frames*channels);
  const a=data.getChannelData(0),b=channels===2?data.getChannelData(1):null;
  if(!b)pcm.set(a);
  else for(let i=0,j=0;i<frames;i++,j+=2){pcm[j]=a[i];pcm[j+1]=b[i];}
  return pcm;
}
async function analyzeFile(nextFile){
  if(nextFile.size>MAX_SIZE)throw new Error('130 MBを超えるファイルです。');
  if(!nextFile.size)throw new Error('ファイルが空です。');
  refs.busyMessage.textContent=`${nextFile.name} の形式を確認しています…`;
  const signature=await nextFile.slice(0,Math.min(nextFile.size,128*1024)).arrayBuffer();
  const originalFormat=parseWavInfo(signature);
  const data=await nextFile.arrayBuffer();
  refs.busyMessage.textContent=`${nextFile.name} をデコードしています…`;
  const ctx=await ensureAudioContext();
  const decoded=await ctx.decodeAudioData(data);
  if(decoded.sampleRate!==48000)throw new Error('48 kHzへのデコードに対応していないブラウザです。');
  if(decoded.duration>1800)throw new Error('30分を超える音声には未対応です。');
  const pcm=interleave(decoded),id=++analysisId;
  refs.busyMessage.textContent=`${nextFile.name} をWebAssemblyで解析しています…`;
  const metrics=await new Promise((resolve,reject)=>{
    pendingAnalyses.set(id,{resolve,reject});
    try{worker.postMessage({id,pcm,channels:decoded.numberOfChannels,sampleRate:decoded.sampleRate},[pcm.buffer]);}
    catch(error){pendingAnalyses.delete(id);reject(error);}
  });
  return {result:metrics,buffer:decoded,sourceFormat:originalFormat};
}
worker.onmessage=({data})=>{
  const pending=pendingAnalyses.get(data.id);
  if(!pending)return;
  pendingAnalyses.delete(data.id);
  if(data.error)pending.reject(new Error(data.error));
  else pending.resolve(data);
};
worker.onerror=event=>{
  const error=new Error('解析エンジンでエラーが発生しました。'+(event.message||''));
  for(const pending of pendingAnalyses.values())pending.reject(error);
  pendingAnalyses.clear();
};
function entryChecks(entry){
  if(!entry.analysis)return [];
  return assess(entry.analysis,{duration:entry.duration,numberOfChannels:entry.channels},entry.format);
}
function entryWarnings(entry){return entryChecks(entry).filter(x=>x.severity==='warn'||x.severity==='danger');}
function markActive(entry,analyzed){
  stopPlayback(true);stopPreview();selectedNoise=null;undoSnapshot=null;hasEdits=false;
  buffer=analyzed.buffer;file=entry.file;sourceFormat=analyzed.sourceFormat;result=analyzed.result;
  selectedEntryId=entry.id;
  renderResults();renderBatch();
}
function renderBatch(){
  if(!batchEntries.length){refs.batch.hidden=true;return;}
  refs.batch.hidden=false;
  const count=batchEntries.filter(e=>e.status==='done').length;
  const errors=batchEntries.filter(e=>e.status==='error').length;
  refs.batchProgress.textContent=`${count+errors} / ${batchEntries.length} 件処理済み（成功 ${count}・失敗 ${errors}）`;
  refs.batchCSV.disabled=count===0;
  refs.batchRows.replaceChildren(...batchEntries.map(entry=>{
    const row=document.createElement('tr');if(entry.id===selectedEntryId)row.classList.add('is-selected');
    const name=document.createElement('td');const strong=document.createElement('div');strong.className='batch-filename';strong.textContent=entry.file.name;
    const sub=document.createElement('div');sub.className='batch-subline';sub.textContent=entry.status==='error'?entry.error:bytes(entry.file.size)+(entry.duration?' · '+fmtDuration(entry.duration):'');name.append(strong,sub);
    const state=document.createElement('td');const status=document.createElement('span');status.className='batch-status';
    if(entry.status==='done'){
      const warn=entryWarnings(entry);const danger=warn.some(i=>i.severity==='danger');
      status.className+=' '+(danger?'danger':warn.length?'warn':'');
      status.textContent=danger?'要確認（重要）':warn.length?`注意 ${warn.length}件`:'指摘なし';
    }else if(entry.status==='error'){status.className+=' error';status.textContent='読み込み失敗';}
    else{status.className+=' busy';status.textContent=entry.status==='running'?'検査中':'待機中';}
    state.append(status);
    const lufs=document.createElement('td');lufs.textContent=entry.analysis?fmt(entry.analysis.metrics[5],1):'—';
    const peak=document.createElement('td');peak.textContent=entry.analysis?fmt(entry.analysis.metrics[0],1)+' dBFS':'—';
    const action=document.createElement('td');const b=document.createElement('button');b.className='batch-open';b.type='button';b.disabled=batchBusy||entry.status!=='done';b.textContent=entry.id===selectedEntryId?'表示中':'結果を開く';b.addEventListener('click',()=>openBatchEntry(entry));action.append(b);
    row.append(name,state,lufs,peak,action);return row;
  }));
}
async function openBatchEntry(entry){
  if(batchBusy||entry.status!=='done')return;
  if(entry.id===selectedEntryId){refs.results.scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(hasEdits&&!window.confirm('修正内容は別ファイルを開くと破棄されます。必要なら先にWAVを書き出してください。切り替えますか？'))return;
  batchBusy=true;setBusy(true,entry.file.name+' を再読み込み中…');clearError();renderBatch();
  try{
    const data=await analyzeFile(entry.file);
    entry.analysis=data.result;entry.format=data.sourceFormat;entry.duration=data.buffer.duration;entry.channels=data.buffer.numberOfChannels;
    markActive(entry,data);
    refs.results.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){showError('検査結果を開けませんでした：'+(err.message||String(err)));}
  finally{batchBusy=false;setBusy(false);renderBatch();}
}
async function loadFiles(files){
  if(batchBusy||!files?.length)return;
  if(hasEdits&&!window.confirm('修正中の内容が破棄されます。先にWAVを書き出しましたか？新しいファイルを検査しますか？'))return;
  clearError();batchBusy=true;setBusy(true,'解析の準備中…');stopPlayback(true);
  refs.results.hidden=true;selectedEntryId=null;file=null;result=null;buffer=null;selectedNoise=null;undoSnapshot=null;hasEdits=false;stopPreview();
  const list=Array.from(files);
  if(list.length>20){refs.error.hidden=false;refs.error.textContent='一度に検査できるファイルは20件までです。先頭20件を処理します。';}
  batchEntries=list.slice(0,20).map(nextFile=>({id:++nextEntryId,file:nextFile,status:'waiting'}));
  renderBatch();
  for(const entry of batchEntries){
    entry.status='running';renderBatch();
    try{
      const analyzed=await analyzeFile(entry.file);
      entry.status='done';entry.analysis=analyzed.result;entry.format=analyzed.sourceFormat;entry.duration=analyzed.buffer.duration;entry.channels=analyzed.buffer.numberOfChannels;
      markActive(entry,analyzed);
    }catch(err){entry.status='error';entry.error=err.message||String(err);}
    renderBatch();
  }
  batchBusy=false;setBusy(false);renderBatch();
  if(!batchEntries.some(e=>e.status==='done'))showError('ファイルを検査できませんでした。ファイル形式やサイズを確認してください。');
  else refs.batch.scrollIntoView({behavior:'smooth',block:'start'});
}

function newItem(severity,title,desc,time=null){return {severity,title,desc,time};}
function assess(data=result,audio=buffer,format=sourceFormat){
  const m=data.metrics,sl=data.events[0],clips=data.events[1],spikes=data.events[2],p=DEFAULTS[refs.preset.value];
  const problems=[],ok=[];
  if(m[9]>0)problems.push(newItem('danger','クリッピングが検出されました',`上限付近のサンプルが ${Math.round(m[9]).toLocaleString('ja-JP')} 個あります。歪みが生じていないか確認してください。`,clips[0]?.start??null));
  else ok.push(newItem('ok','デジタルクリッピングなし','解析したPCMで上限付近のサンプルは検出されませんでした。'));
  if(spikes.length)problems.push(newItem('warn','孤立したクリック音の候補があります',`${spikes.length} か所でごく短い突出したサンプルを検出。クリックノイズとは限らないため、該当箇所を試聴してください。`,spikes[0].start));
  if(m[0]>p.peak&&m[9]===0)problems.push(newItem('warn','ピークに余裕が少なめです',`Sample Peakは ${fmt(m[0])} dBFS。選択した用途の暫定目安 ${p.peak} dBFS 以下との比較です。`));
  else if(m[9]===0)ok.push(newItem('ok','ピークの余裕を確認',`Sample Peak ${fmt(m[0])} dBFS。`));
  if(m[1]>-0.1&&m[9]===0)problems.push(newItem('warn','True Peak近似値が高めです',`4倍補間による推定値が ${fmt(m[1])} dBTP相当でした。エンコード時の音割れに注意してください。`));
  if(m[0]>-100&&audio.duration>=.4){
    if(m[5]<p.min||m[5]>p.max)problems.push(newItem('warn','ラウドネスが選択した目安から外れています',`Integrated ${fmt(m[5])} LUFS。${p.name}の暫定目安は ${p.min} 〜 ${p.max} LUFS。納品先の指定が最優先です。`));
    else ok.push(newItem('ok','ラウドネスが目安の範囲内',`Integrated ${fmt(m[5])} LUFS。`));
  }
  if(sl.length){
    const lead=sl.find(s=>s.start<0.09&&s.end>=0.5);
    const trail=sl.find(s=>s.end>audio.duration-0.1&&s.end-s.start>=0.6);
    const inner=sl.find(s=>s.start>=0.09&&s.end<=audio.duration-0.1&&s.end-s.start>=1.0);
    if(lead)problems.push(newItem('warn','冒頭に長めの無音があります',`${fmt(lead.end-lead.start)}秒の低音量区間。意図した余白でなければカットを検討してください。`,lead.start));
    if(inner)problems.push(newItem('warn','途中に無音区間があります',`${fmt(inner.end-inner.start)}秒の低音量区間が ${fmtDuration(inner.start)} 付近にあります。演出上の無音なら問題ありません。`,inner.start));
    if(trail)problems.push(newItem('warn','末尾に長めの無音があります',`${fmt(trail.end-trail.start)}秒の低音量区間。意図したものか確認してください。`,trail.start));
  }
  if(!problems.some(i=>i.title.includes('無音')))ok.push(newItem('ok','長い無音区間は検出されませんでした','-50 dBFS以下・0.35秒以上の区間を対象にした簡易検査です。'));
  if(audio.numberOfChannels===2&&m[4]<-.15)problems.push(newItem('warn','ステレオ位相に注意してください',`L/R相関 ${fmt(m[4],2)}。モノラル再生で音が弱くなる場合があります。`));
  if(Math.abs(m[3])>.01)problems.push(newItem('warn','DCオフセットがあります',`平均値 ${fmt(m[3],4)}。不要な直流成分が含まれる可能性があります。`));
  if(m[21]<2){
    ok.push(newItem('info','ノイズ候補の判定保留','十分な低音量区間がありません。ハムや高域ノイズがないことを保証する判定ではありません。'));
  }else{
    if(data.events[3].length)problems.push(newItem('warn',`${Math.round(m[25])} Hz付近のハムノイズ候補`,`${data.events[3].length} 区間で低周波の狭帯域成分を検出。電源ハムとは限りません。音声を確認してください。`,data.events[3][0].start));
    if(data.events[4].length)problems.push(newItem('warn','高域の広帯域ノイズ候補',`${data.events[4].length} 区間で高域エネルギーの多い低音量区間を検出。ヒスノイズとは限りません。`,data.events[4][0].start));
    if(!data.events[3].length&&!data.events[4].length)ok.push(newItem('ok','静かな区間のノイズ傾向を確認','ハム・高域ノイズの強い兆候は見つかりませんでした。ノイズなしの保証ではありません。'));
  }
  ok.push(newItem('ok','音声形式を確認しました',`${format?`${format.rate.toLocaleString()} Hz / ${format.bitDepth}bit / `:'元形式の詳細は不明 / '}${audio.numberOfChannels===1?'Mono':'Stereo'}。解析は48 kHzで実行。`));
  return [...problems,...ok];
}
function renderResults(){
  if(!result||!buffer||!file)return;
  refs.results.hidden=false;
  refs.fileName.textContent=file.name;
  let rateInfo=sourceFormat?`${(sourceFormat.rate/1000).toFixed(1)} kHz · ${sourceFormat.bitDepth}-bit`:'元ファイルの詳細不明';
  refs.fileMeta.textContent=`${ext(file.name).toUpperCase()} · ${rateInfo} · ${buffer.numberOfChannels===1?'Mono':'Stereo'} · ${fmtDuration(buffer.duration)} · ${bytes(file.size)} · 解析レート48 kHz${hasEdits?' · 未保存の部分修正あり':''}`;
  issues=assess();const problems=issues.filter(i=>i.severity==='warn'||i.severity==='danger');
  refs.verdict.className='verdict'+(problems.some(i=>i.severity==='danger')?' has-danger':problems.length?' has-warnings':'');
  refs.verdictIcon.textContent=problems.some(i=>i.severity==='danger')?'!':problems.length?'!':'✓';
  refs.verdictTitle.textContent=problems.some(i=>i.severity==='danger')?'重要な問題を検出しました':problems.length?'確認したい項目があります':'目立つ問題は検出されませんでした';
  refs.verdictDescription.textContent=problems.length?'検出箇所と内容を確認してから納品してください。':'選択した暫定基準でのチェック結果です。聴感確認もおすすめします。';
  refs.verdictCount.textContent=`注意 ${problems.length} 件`;
  const m=result.metrics;
  refs.metrics.replaceChildren(...[
    ['Integrated Loudness',fmt(m[5]),'LUFS','ゲーティング測定'],
    ['Sample Peak',fmt(m[0]),'dBFS','サンプル最大値'],
    ['True Peak (推定)',fmt(m[1]),'dBTP','4×補間による近似'],
    ['検出した無音',String(result.events[0].length),'か所',`合計 ${fmt(m[8])} 秒`]
  ].map(([name,value,unit,description])=>{
    const card=document.createElement('div');card.className='metric-card';
    const top=document.createElement('div');top.className='metric-top';top.textContent=name;
    const val=document.createElement('div');val.className='metric-value';val.textContent=value;
    const unitNode=document.createElement('small');unitNode.textContent=unit;val.append(unitNode);
    const desc=document.createElement('div');desc.className='metric-desc';desc.textContent=description;
    card.append(top,val,desc);return card;
  }));
  refs.issues.replaceChildren(...issues.map(item=>{
    const row=document.createElement('div');row.className='issue-row'+(item.severity==='ok'?'':` ${item.severity}`);
    const symbol=document.createElement('span');symbol.className='issue-icon';symbol.textContent=item.severity==='ok'?'✓':item.severity==='info'?'i':'!';
    const content=document.createElement('div');content.className='issue-content';
    const strong=document.createElement('strong');strong.textContent=item.title;
    const desc=document.createElement('p');desc.textContent=item.desc;content.append(strong,desc);row.append(symbol,content);
    if(item.time!==null){const b=document.createElement('button');b.type='button';b.className='issue-jump';b.textContent=fmtDuration(item.time)+' ↗';b.addEventListener('click',()=>{
      const found=noiseCandidates.find(candidate=>Math.abs(candidate.event.start-item.time)<.002);
      if(found){selectRegion(candidateRegion(found.kind,found.event));refs.repairMethod.value=found.kind===2?'4':found.kind===3?(result.metrics[25]===60?'2':'1'):'3';}
      seekTo(item.time);
    });row.append(b);}
    return row;
  }));
  const list=[
    ['Integrated Loudness',`${fmt(m[5])} LUFS`],['Sample Peak',`${fmt(m[0],2)} dBFS`],['True Peak (4×推定)',`${fmt(m[1],2)} dBTP`],
    ['RMS',`${fmt(m[2],2)} dBFS`],['LRA',`${fmt(m[6],1)} LU`],['Crest Factor',`${fmt(m[15])} dB`],
    ['L/R 相関',buffer.numberOfChannels===2?fmt(m[4],3):'Mono（対象外）'],
    ['L/R レベル差',buffer.numberOfChannels===2?`${fmt(m[14],2)} dB`:'Mono（対象外）'],
    ['DCオフセット',fmt(m[3],5)],['低レベル区間 RMS（15%点）',`${fmt(m[7],1)} dBFS`],
    ['無音合計',`${fmt(m[8],2)} 秒`],['クリップ相当サンプル数',Math.round(m[9]).toLocaleString('ja-JP')],['孤立したスパイク候補数',String(result.events[2].length)],
    ['検出した無音区間数',`${result.events[0].length} か所`],['検出したクリップ区間数',`${result.events[1].length} か所`],
    ['デコード後の解析レート','48,000 Hz'],['元ファイルのサンプルレート',sourceFormat?`${sourceFormat.rate.toLocaleString('ja-JP')} Hz`:'解析できず'],
    ['元ファイルのビット深度',sourceFormat?`${sourceFormat.bitDepth} bit`:'解析できず'],
    ['静かな区間の解析対象数',`${Math.round(m[21])} 区間`],['50/60Hzハム候補数',`${result.events[3].length} 区間`],
    ['広帯域高域ノイズ候補数',`${result.events[4].length} 区間`],
    ['低音量解析区間の平均RMS',m[21]?`${fmt(m[24],1)} dBFS`:'判定保留'],
    ['低域ハム候補周波数',m[25]?`${fmt(m[25],0)} Hz`:'検出なし'],
    ['最も強い低域トーンの際立ち',m[21]?`${fmt(m[26],1)} dB`:'判定保留'],
  ];
  refs.details.replaceChildren(...list.map(([k,v])=>{const row=document.createElement('div');row.className='detail-row';const l=document.createElement('span');l.textContent=k;const r=document.createElement('span');r.textContent=v;row.append(l,r);return row;}));
  refs.spectrum.replaceChildren(...result.spectrum.map((db,i)=>{
    const col=document.createElement('div');col.className='spectrum-column';const bar=document.createElement('div');bar.className='spectrum-bar';
    bar.style.height=`${Math.max(2,((db+60)/60)*83)}%`;bar.title=`${BAND_NAMES[i]} Hz: ${fmt(db)} dB（相対）`;
    const label=document.createElement('div');label.className='spectrum-name';label.textContent=BAND_NAMES[i];col.append(bar,label);return col;
  }));
  const noiseCards=[
    ['解析対象区間',String(Math.round(m[21])),'低音量の短区間'],
    ['50/60 Hz候補',String(result.events[3].length),'電源ハムの可能性'],
    ['高域ノイズ候補',String(result.events[4].length),'広帯域ノイズの可能性'],
    ['対象区間の平均RMS',m[21]?fmt(m[24],1):'—','dBFS（十分な区間がない場合は保留）']
  ];
  refs.noise.replaceChildren(...noiseCards.map(([name,value,unit])=>{const n=document.createElement('div');n.className='noise-metric';const label=document.createElement('span');label.textContent=name;const number=document.createElement('strong');number.textContent=value;const note=document.createElement('small');note.textContent=unit;n.append(label,number,note);return n;}));
  $('timelineMid').textContent=fmtDuration(buffer.duration/2);$('timelineEnd').textContent=fmtDuration(buffer.duration);
  if(!isPlaying)playOffset=0;refreshTimeline();drawWaveform();renderRepairCandidates();
}

function drawWaveform(){
  if(!result||!buffer||refs.simple.hidden)return;
  const canvas=refs.wave,rect=canvas.getBoundingClientRect();
  if(rect.width<2||rect.height<2)return;
  const dpr=Math.min(window.devicePixelRatio||1,2),width=Math.round(rect.width*dpr),height=Math.round(rect.height*dpr);
  canvas.width=width;canvas.height=height;
  const c=canvas.getContext('2d');c.clearRect(0,0,width,height);
  for(const [kind,color] of [[0,'rgba(202,163,81,.17)'],[1,'rgba(235,103,101,.27)'],[2,'rgba(139,164,247,.55)'],[3,'rgba(219,157,242,.18)'],[4,'rgba(111,194,215,.15)']]){
    for(const ev of result.events[kind]){
      const x=Math.max(0,ev.start/buffer.duration*width),end=Math.min(width,ev.end/buffer.duration*width);
      c.fillStyle=color;c.fillRect(x,0,Math.max(kind===0?1:2*dpr,end-x),height);
    }
  }
  const data=result.waveform;
  c.strokeStyle='#abf4be';c.lineWidth=Math.max(1,dpr*.9);c.beginPath();
  const scale=height*.41;
  for(let px=0;px<width;px++){
    const idx=Math.min(data.length-1,Math.floor(px/width*data.length));const [lo,hi]=data[idx];
    const y1=height/2-(hi*scale),y2=height/2-(lo*scale);
    c.moveTo(px+.5,y1);c.lineTo(px+.5,Math.max(y1+1,y2));
  }
  c.stroke();refreshTimeline();refreshSelectionOverlay();
}
function configureFilter(node,band){
  const type=band.enabled?band.type:'peaking';
  node.type=type;
  node.frequency.value=band.freq;
  node.Q.value=band.q;
  node.gain.value=band.enabled?band.gain:0;
}
function makeFilters(ctx){return eqBands.map(b=>{const n=ctx.createBiquadFilter();configureFilter(n,b);return n;});}
function updateEqNodes(){
  if(!eqNodes)return;
  eqNodes.forEach((n,i)=>configureFilter(n,eqBands[i]));
  wetGain.gain.value=refs.eqOn.checked?1:0;dryGain.gain.value=refs.eqOn.checked?0:1;
}
function connectPlayback(ctx,sr){
  eqNodes=makeFilters(ctx);wetGain=ctx.createGain();dryGain=ctx.createGain();
  wetGain.gain.value=refs.eqOn.checked?1:0;dryGain.gain.value=refs.eqOn.checked?0:1;
  for(let i=0;i<eqNodes.length-1;i++)eqNodes[i].connect(eqNodes[i+1]);
  eqNodes.at(-1).connect(wetGain);wetGain.connect(ctx.destination);dryGain.connect(ctx.destination);
  sr.connect(eqNodes[0]);sr.connect(dryGain);
}
function stopPlayback(resetOffset=false){
  if(sourceNode){const n=sourceNode;sourceNode=null;n.onended=null;try{n.stop();}catch{}try{n.disconnect();}catch{}}
  if(wetGain){try{wetGain.disconnect();}catch{}wetGain=null;}
  if(dryGain){try{dryGain.disconnect();}catch{}dryGain=null;}
  if(eqNodes){for(const node of eqNodes)try{node.disconnect();}catch{}eqNodes=null;}
  isPlaying=false;refs.play.textContent='▶';refs.play.setAttribute('aria-label','再生');
  if(resetOffset)playOffset=0;
  if(frameHandle)cancelAnimationFrame(frameHandle);
  refreshTimeline();
}
async function startPlayback(){
  if(!buffer)return;
  stopPreview();
  try{
    const ctx=await ensureAudioContext();await ctx.resume();
    if(playOffset>=buffer.duration-.01)playOffset=0;
    sourceNode=ctx.createBufferSource();sourceNode.buffer=buffer;
    connectPlayback(ctx,sourceNode);
    startedAt=ctx.currentTime-playOffset;
    const startedNode=sourceNode;
    startedNode.onended=()=>{if(sourceNode===startedNode){sourceNode=null;try{startedNode.disconnect();}catch{}stopPlayback(true);}};
    startedNode.start(0,playOffset);
    isPlaying=true;refs.play.textContent='Ⅱ';refs.play.setAttribute('aria-label','一時停止');
    animationLoop();
  }catch(err){showError('音声を再生できません。'+(err?.message||String(err)));}
}
function animationLoop(){
  if(!isPlaying||!audioCtx||!buffer)return;
  playOffset=Math.min(buffer.duration,Math.max(0,audioCtx.currentTime-startedAt));refreshTimeline();
  frameHandle=requestAnimationFrame(animationLoop);
}
function refreshTimeline(){
  refs.playerTime.textContent=`${fmtDuration(playOffset)} / ${buffer?fmtDuration(buffer.duration):'00:00'}`;
  refs.playhead.style.left=buffer?`${Math.max(0,Math.min(100,playOffset/buffer.duration*100))}%`:'0%';
}
async function seekTo(time){
  if(!buffer)return;
  const wasPlaying=isPlaying;stopPlayback();playOffset=Math.max(0,Math.min(time,buffer.duration-.001));refreshTimeline();
  if(wasPlaying)await startPlayback();
}
function drawEq(){
  if(eqNodes)updateEqNodes();
  const off=new OfflineAudioContext(1,1,48000);
  const filters=eqNodes||makeFilters(off);
  const frequency=new Float32Array(160),mag=new Float32Array(160),phase=new Float32Array(160);
  const dbCurve=new Float64Array(160);
  for(let i=0;i<160;i++)frequency[i]=20*Math.pow(1000,i/159);
  if(refs.eqOn.checked){
    for(const node of filters){node.getFrequencyResponse(frequency,mag,phase);
      for(let i=0;i<frequency.length;i++)dbCurve[i]+=20*Math.log10(Math.max(1e-9,mag[i]));}
  }
  const path=[];
  for(let i=0;i<frequency.length;i++){
    const x=12+416*i/159,y=Math.max(12,Math.min(152,88-dbCurve[i]*4));
    path.push((i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2));
  }
  refs.eqPath.setAttribute('d',path.join(' '));
}
function buildEqControls(){
  const container=$('eqControls');container.replaceChildren();
  for(const [index,band] of eqBands.entries()){
    const row=document.createElement('div');row.className='param-row';
    const first=document.createElement('div');first.className='param-band';
    const top=document.createElement('div');top.className='param-band-top';
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.className='param-toggle';toggle.checked=band.enabled;toggle.setAttribute('aria-label',`バンド${index+1}を有効にする`);
    const name=document.createElement('span');name.className='param-band-name';name.textContent=`BAND ${index+1}`;
    top.append(toggle,name);
    const type=document.createElement('select');type.className='param-select';type.setAttribute('aria-label',`バンド${index+1} フィルターの種類`);
    for(const [value,label] of Object.entries(FILTER_LABELS)){const option=document.createElement('option');option.value=value;option.textContent=label;type.append(option);}
    type.value=band.type;first.append(top,type);row.append(first);
    const addRange=(label,min,max,step,value,transform,onChange)=>{
      const wrap=document.createElement('label');wrap.className='param-setting';
      const val=document.createElement('span');val.className='param-value';val.textContent=transform(value);
      const range=document.createElement('input');range.type='range';range.min=min;range.max=max;range.step=step;range.value=value;range.setAttribute('aria-label',`バンド${index+1} ${label}`);
      range.addEventListener('input',()=>{const current=Number(range.value);val.textContent=transform(current);onChange(current);drawEq();});
      wrap.append(val,range);row.append(wrap);return range;
    };
    const freq=addRange('周波数',0,1000,1,freqToSlider(band.freq),v=>hzLabel(sliderToFreq(v)),v=>{band.freq=sliderToFreq(v);});
    const gain=addRange('ゲイン',-18,18,.5,band.gain,v=>`${v>0?'+':''}${v.toFixed(1)} dB`,v=>{band.gain=v;});
    const q=addRange('Q',.3,10,.1,band.q,v=>v.toFixed(1),v=>{band.q=v;});
    const update=()=>{
      row.classList.toggle('is-disabled',!band.enabled);
      gain.disabled=!band.enabled||band.type==='highpass'||band.type==='lowpass';
      q.disabled=!band.enabled||band.type==='lowshelf'||band.type==='highshelf';
      freq.disabled=!band.enabled;type.disabled=!band.enabled;
    };
    toggle.addEventListener('change',()=>{band.enabled=toggle.checked;update();drawEq();});
    type.addEventListener('change',()=>{band.type=type.value;update();drawEq();});
    update();container.append(row);
  }
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}
function reportCSV(){
  if(!result||!file)return;
  const rows=[['項目','値'],['ファイル名',file.name],['用途',DEFAULTS[refs.preset.value].name],['解析サンプルレート','48000 Hz'],['長さ',fmt(result.metrics[10],3)+' s'],['Sample Peak',fmt(result.metrics[0],3)+' dBFS'],['True Peak 4x 推定',fmt(result.metrics[1],3)+' dBTP'],['Integrated',fmt(result.metrics[5],3)+' LUFS'],['RMS',fmt(result.metrics[2],3)+' dBFS'],['LRA',fmt(result.metrics[6],2)+' LU'],['DC Offset',fmt(result.metrics[3],6)],['L/R Correlation',fmt(result.metrics[4],4)],['クリップ相当サンプル',String(result.metrics[9])],['孤立したスパイク候補',String(result.events[2].length)],['50/60Hzハム候補',String(result.events[3].length)],['高域ノイズ候補',String(result.events[4].length)],['無音合計',fmt(result.metrics[8],3)+' s'],['部分修正の有無',hasEdits?'あり（編集中）':'オリジナルまたは未編集'],['判定',''],...issues.map(i=>[i.severity+': '+i.title,i.desc])];
  const quote=s=>'"'+String(s).replaceAll('"','""')+'"';
  const csv='\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
  downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),file.name.replace(/\.[^.]+$/,'')+'_soundproof_report.csv');
}

function wav16(b){
  const channels=b.numberOfChannels,n=b.length,total=44+n*channels*2;
  if(total>0xFFFFFFFF)throw new Error('WAVファイルが大きすぎます。');
  const bytes=new ArrayBuffer(total),v=new DataView(bytes);let p=0;
  const str=t=>{for(let i=0;i<t.length;i++)v.setUint8(p++,t.charCodeAt(i));};
  const u16=n=>{v.setUint16(p,n,true);p+=2;};const u32=n=>{v.setUint32(p,n,true);p+=4;};
  str('RIFF');u32(total-8);str('WAVE');str('fmt ');u32(16);u16(1);u16(channels);u32(b.sampleRate);u32(b.sampleRate*channels*2);u16(channels*2);u16(16);str('data');u32(n*channels*2);
  const arrays=Array.from({length:channels},(_,c)=>b.getChannelData(c));
  let peak=0;
  for(let i=0;i<n;i++)for(let c=0;c<channels;c++){
    const x=arrays[c][i];peak=Math.max(peak,Math.abs(x));
    const clipped=Math.max(-1,Math.min(1,x));v.setInt16(p,clipped<0?Math.round(clipped*32768):Math.round(clipped*32767),true);p+=2;
  }
  return {blob:new Blob([bytes],{type:'audio/wav'}),peak};
}
async function exportWav(){
  if(!buffer||exporting)return;
  exporting=true;refs.export.disabled=true;refs.export.textContent='書き出し中…';clearError();
  try{
    const offline=new OfflineAudioContext(buffer.numberOfChannels,buffer.length,buffer.sampleRate);
    const source=offline.createBufferSource();source.buffer=buffer;
    if(refs.eqOn.checked){
      const nodes=makeFilters(offline);source.connect(nodes[0]);for(let i=0;i<nodes.length-1;i++)nodes[i].connect(nodes[i+1]);nodes.at(-1).connect(offline.destination);
    }else source.connect(offline.destination);
    source.start();
    const processed=await offline.startRendering();
    const {blob,peak}=wav16(processed);
    downloadBlob(blob,file.name.replace(/\.[^.]+$/,'')+'_soundproof.wav');
    if(peak>=1)showError('書き出しは完了しましたが、EQ適用後に1.0を超えるピークがありました。出力ファイルの再検査をおすすめします。');
  }catch(err){showError('WAV書き出しに失敗しました。'+(err?.message||String(err)));}
  finally{exporting=false;refs.export.disabled=false;refs.export.textContent='WAVを書き出す ↓';}
}

// Candidate screening runs in WebAssembly, as do the region-only repair DSPs.
// The original File is never overwritten; only the in-memory decoded buffer changes.
function clamp01(n){return Math.max(0,Math.min(1,n));}
function candidateRegion(kind,event){
  if(kind===2){const p=event.start;return {start:Math.max(0,p-.045),end:Math.min(buffer.duration,p+.045),kind,clickTime:p};}
  return {start:Math.max(0,event.start),end:Math.min(buffer.duration,event.end),kind,clickTime:null};
}
function refreshSelectionOverlay(){
  if(!buffer||!selectedNoise){refs.selectionOverlay.hidden=true;return;}
  refs.selectionOverlay.hidden=false;
  refs.selectionOverlay.style.left=(100*selectedNoise.start/buffer.duration)+'%';
  refs.selectionOverlay.style.width=(100*(selectedNoise.end-selectedNoise.start)/buffer.duration)+'%';
}
function formatExact(t){return `${fmtDuration(t)}.${String(Math.floor((t%1)*1000)).padStart(3,'0')}`;}
function renderRepairCandidates(){
  if(!result||!buffer)return;
  noiseCandidates=[];
  for(const kind of [2,3,4])for(const event of result.events[kind])noiseCandidates.push({kind,event});
  noiseCandidates.sort((a,b)=>a.event.start-b.event.start||a.kind-b.kind);
  refs.candidateCount.textContent=`${noiseCandidates.length}件`;
  refs.candidateList.replaceChildren();
  const labels={2:'クリック候補',3:'50/60 Hzハム候補',4:'高域ノイズ候補'};
  if(!noiseCandidates.length){
    const empty=document.createElement('div');empty.className='noise-candidate empty';empty.textContent='候補なし。波形上をドラッグして手動選択できます。';refs.candidateList.append(empty);
  }
  for(const candidate of noiseCandidates.slice(0,80)){
    const button=document.createElement('button');button.type='button';button.className='noise-candidate';
    const text=document.createElement('span');const name=document.createElement('strong');name.textContent=labels[candidate.kind];
    const time=document.createElement('small');time.textContent=formatExact(candidate.event.start);text.append(name,time);
    const arrow=document.createElement('span');arrow.textContent='↗';button.append(text,arrow);
    const r=candidateRegion(candidate.kind,candidate.event);
    if(selectedNoise&&r.kind===selectedNoise.kind&&Math.abs(r.start-selectedNoise.start)<.0005)button.classList.add('active');
    button.addEventListener('click',()=>{
      const newRegion=candidateRegion(candidate.kind,candidate.event);
      selectRegion(newRegion);
      refs.repairMethod.value=candidate.kind===2?'4':candidate.kind===3?(result.metrics[25]===60?'2':'1'):'3';
      seekTo(newRegion.start);
    });
    refs.candidateList.append(button);
  }
  if(noiseCandidates.length>80){const more=document.createElement('p');more.className='small-note';more.textContent=`ほか ${noiseCandidates.length-80}件。波形からも範囲指定できます。`;refs.candidateList.append(more);}
  updateRepairControls();
}
function selectRegion(region){
  stopPreview();
  selectedNoise={start:clamp01(region.start/buffer.duration)*buffer.duration,end:clamp01(region.end/buffer.duration)*buffer.duration,kind:region.kind||0,clickTime:region.clickTime??null};
  if(selectedNoise.end-selectedNoise.start<.0001){selectedNoise=null;}
  if(selectedNoise&&selectedNoise.end-selectedNoise.start>MAX_REPAIR_SECONDS){
    selectedNoise.end=selectedNoise.start+MAX_REPAIR_SECONDS;
    refs.repairStatus.textContent='1回の修正範囲は20秒までです。先頭20秒を選択しました。';
  }else refs.repairStatus.textContent='修正案を試聴し、問題がなければ「修正を適用」を押してください。';
  refreshSelectionOverlay();renderRepairCandidates();
}
function updateRepairControls(){
  const enabled=Boolean(selectedNoise&&!repairBusy&&!batchBusy);
  refs.listenOriginal.disabled=!enabled;refs.listenRepaired.disabled=!enabled;refs.applyRepair.disabled=!enabled;
  refs.undoRepair.disabled=!undoSnapshot||repairBusy||batchBusy;
  refs.selectionTimes.textContent=selectedNoise?`${formatExact(selectedNoise.start)} 〜 ${formatExact(selectedNoise.end)}（${fmt(selectedNoise.end-selectedNoise.start,3)} 秒）`:'区間を選んでください';
}
function stopPreview(){
  if(previewNode){const node=previewNode;previewNode=null;node.onended=null;try{node.stop();}catch{}try{node.disconnect();}catch{}}
  if(previewLabel){previewLabel.textContent=previewLabel===refs.listenOriginal?'▶ 元音':'▶ 修正案';previewLabel=null;}
}
async function analyzeBuffer(b){
  const pcm=interleave(b),id=++analysisId;
  return new Promise((resolve,reject)=>{pendingAnalyses.set(id,{resolve,reject});
    try{worker.postMessage({id,pcm,channels:b.numberOfChannels,sampleRate:b.sampleRate},[pcm.buffer]);}
    catch(err){pendingAnalyses.delete(id);reject(err);}
  });
}
function regionSlice(b,selection){
  const start=Math.max(0,Math.floor(selection.start*b.sampleRate));
  const end=Math.min(b.length,Math.ceil(selection.end*b.sampleRate));
  const frames=end-start,channels=b.numberOfChannels;
  if(frames<8||frames>b.sampleRate*MAX_REPAIR_SECONDS+2)throw new Error('修復できる区間は20秒以内です。');
  const pcm=new Float32Array(frames*channels);
  const channelsData=Array.from({length:channels},(_,i)=>b.getChannelData(i));
  for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++)pcm[i*channels+ch]=channelsData[ch][i+start];
  return {start,frames,channels,pcm};
}
async function repairSelection(){
  if(!buffer||!selectedNoise)throw new Error('区間を選択してください。');
  const selection={...selectedNoise},sliced=regionSlice(buffer,selection);
  const id=++analysisId,method=Number(refs.repairMethod.value),strength=Number(refs.repairStrength.value)/100;
  let clickTime=selection.clickTime;
  if(clickTime===null)clickTime=(selection.start+selection.end)/2;
  const clickIndex=Math.max(4,Math.min(sliced.frames-5,Math.round(clickTime*buffer.sampleRate)-sliced.start));
  const updated=await new Promise((resolve,reject)=>{
    pendingAnalyses.set(id,{resolve,reject});
    try{worker.postMessage({id,action:'repair',pcm:sliced.pcm,channels:sliced.channels,sampleRate:buffer.sampleRate,mode:method,strength,clickIndex},[sliced.pcm.buffer]);}
    catch(err){pendingAnalyses.delete(id);reject(err);}
  });
  return {start:sliced.start,frames:sliced.frames,channels:sliced.channels,pcm:updated.pcm,mode:method};
}
function snippetBuffer(ctx,patch){
  const b=ctx.createBuffer(patch.channels,patch.frames,buffer.sampleRate);
  for(let ch=0;ch<patch.channels;ch++){
    const arr=b.getChannelData(ch);
    for(let i=0;i<patch.frames;i++)arr[i]=patch.pcm[i*patch.channels+ch];
  }
  return b;
}
async function listenSelection(repaired){
  if(!selectedNoise||repairBusy||batchBusy)return;
  stopPlayback();stopPreview();
  const requested=refs[repaired?'listenRepaired':'listenOriginal'];
  try{
    requested.disabled=true;requested.textContent='準備中…';
    const ctx=await ensureAudioContext();await ctx.resume();
    const selection={...selectedNoise};
    let clip;
    if(repaired){const patch=await repairSelection();clip=snippetBuffer(ctx,patch);}
    else{
      const region=regionSlice(buffer,selection);
      clip=snippetBuffer(ctx,region);
    }
    // If another region was selected during asynchronous WASM processing, do not play stale audio.
    if(!selectedNoise||selectedNoise.start!==selection.start||selectedNoise.end!==selection.end)return;
    const node=ctx.createBufferSource();node.buffer=clip;node.connect(ctx.destination);previewNode=node;previewLabel=requested;
    requested.textContent='■ 停止';
    node.onended=()=>{if(previewNode===node)stopPreview();};
    node.start();
  }catch(err){showError('区間の試聴に失敗しました。'+(err.message||String(err)));}
  finally{updateRepairControls();if(previewNode!==null&&previewLabel===requested){requested.textContent='■ 停止';}else requested.textContent=repaired?'▶ 修正案':'▶ 元音';}
}
// In-place decoded-PCM edit: store ONLY the previous segment for one-step undo.
// This avoids doubling the entire uncompressed file in memory for small repairs.
function pasteSnippet(b,patch){
  for(let ch=0;ch<patch.channels;ch++){
    const destination=b.getChannelData(ch);
    for(let i=0;i<patch.frames;i++)destination[patch.start+i]=patch.pcm[i*patch.channels+ch];
  }
}
async function applyNoiseRepair(){
  if(!selectedNoise||repairBusy||batchBusy||!buffer)return;
  repairBusy=true;batchBusy=true;stopPreview();stopPlayback();updateRepairControls();
  setBusy(true,'選択した区間をWebAssemblyで修正しています…');clearError();
  let original=null,wasApplied=false;
  const beforeResult=result,hadEdits=hasEdits;
  try{
    const patch=await repairSelection();
    original=regionSlice(buffer,{start:patch.start/buffer.sampleRate,end:(patch.start+patch.frames)/buffer.sampleRate});
    pasteSnippet(buffer,patch);wasApplied=true;
    setBusy(true,'修正後の音声をWebAssemblyで再検査しています…');
    const rescanned=await analyzeBuffer(buffer);
    undoSnapshot={patch:original,result:beforeResult,hadEdits};
    hasEdits=true;result=rescanned;
    renderResults();
    refs.repairStatus.textContent=`${MODE_LABELS[patch.mode]}を適用しました。修正後の数値に更新済みです。直前の操作は取り消せます。`;
  }catch(err){
    if(wasApplied&&original)pasteSnippet(buffer,original);
    result=beforeResult;showError('部分修正に失敗しました。'+(err.message||String(err)));
  }
  finally{repairBusy=false;batchBusy=false;setBusy(false);renderBatch();updateRepairControls();}
}
function undoNoiseRepair(){
  if(!undoSnapshot||repairBusy||batchBusy)return;
  stopPreview();stopPlayback();pasteSnippet(buffer,undoSnapshot.patch);result=undoSnapshot.result;hasEdits=undoSnapshot.hadEdits;undoSnapshot=null;
  renderResults();refs.repairStatus.textContent='直前の修正を取り消しました。';updateRepairControls();
}
function pointerTime(e){const rect=refs.wave.parentElement.getBoundingClientRect();return clamp01((e.clientX-rect.left)/rect.width)*buffer.duration;}
const waveformArea=refs.wave.parentElement;
waveformArea.addEventListener('pointerdown',e=>{
  if(!buffer||e.button!==0||repairBusy)return;
  selectionDrag={id:e.pointerId,x:e.clientX,start:pointerTime(e)};
  waveformArea.setPointerCapture(e.pointerId);
});
waveformArea.addEventListener('pointermove',e=>{
  if(!selectionDrag||e.pointerId!==selectionDrag.id||!buffer)return;
  if(Math.abs(e.clientX-selectionDrag.x)>6){
    const a=selectionDrag.start,b=pointerTime(e);
    selectedNoise={start:Math.min(a,b),end:Math.max(a,b),kind:0,clickTime:null};
    refreshSelectionOverlay();
  }
});
waveformArea.addEventListener('pointerup',e=>{
  if(!selectionDrag||e.pointerId!==selectionDrag.id||!buffer)return;
  const drag=selectionDrag;selectionDrag=null;
  if(Math.abs(e.clientX-drag.x)>6){
    const other=pointerTime(e);const start=Math.min(drag.start,other),end=Math.max(drag.start,other);
    selectRegion({start,end,kind:0,clickTime:null});
    refs.repairMethod.value='5';
  }else seekTo(pointerTime(e));
});
waveformArea.addEventListener('pointercancel',()=>{selectionDrag=null;});
refs.repairStrength.addEventListener('input',()=>{refs.repairStrengthValue.textContent=refs.repairStrength.value+'%';stopPreview();});
refs.repairMethod.addEventListener('change',stopPreview);
refs.listenOriginal.addEventListener('click',()=>{if(previewLabel===refs.listenOriginal)stopPreview();else listenSelection(false);});
refs.listenRepaired.addEventListener('click',()=>{if(previewLabel===refs.listenRepaired)stopPreview();else listenSelection(true);});
refs.applyRepair.addEventListener('click',applyNoiseRepair);
refs.undoRepair.addEventListener('click',undoNoiseRepair);

refs.choose.addEventListener('click',e=>{e.stopPropagation();refs.fileInput.click();});
refs.drop.addEventListener('click',()=>{if(!batchBusy)refs.fileInput.click();});
refs.drop.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!batchBusy){e.preventDefault();refs.fileInput.click();}});
refs.fileInput.addEventListener('change',e=>{const chosen=Array.from(e.target.files||[]);if(chosen.length)loadFiles(chosen);e.target.value='';});
for(const kind of ['dragenter','dragover'])refs.drop.addEventListener(kind,e=>{e.preventDefault();if(!batchBusy)refs.drop.classList.add('dragging');});
for(const kind of ['dragleave','drop'])refs.drop.addEventListener(kind,e=>{e.preventDefault();refs.drop.classList.remove('dragging');});
refs.drop.addEventListener('drop',e=>{if(!batchBusy&&e.dataTransfer.files?.length)loadFiles(e.dataTransfer.files);});
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
function switchTab(detail){refs.simple.hidden=detail;refs.detailed.hidden=!detail;refs.simpleTab.classList.toggle('is-active',!detail);refs.detailTab.classList.toggle('is-active',detail);refs.simpleTab.setAttribute('aria-selected',String(!detail));refs.detailTab.setAttribute('aria-selected',String(detail));if(!detail)requestAnimationFrame(drawWaveform);}
refs.simpleTab.addEventListener('click',()=>switchTab(false));refs.detailTab.addEventListener('click',()=>switchTab(true));
refs.preset.addEventListener('change',()=>{if(result)renderResults();renderBatch();});
refs.play.addEventListener('click',async()=>{if(isPlaying){playOffset=audioCtx.currentTime-startedAt;stopPlayback();}else await startPlayback();});

refs.report.addEventListener('click',reportCSV);
refs.batchCSV.addEventListener('click',()=>{
  const rows=[['ファイル名','状態','注意件数','Integrated LUFS','Sample Peak dBFS','ハム候補区間','高域ノイズ候補区間','エラー']];
  for(const entry of batchEntries)rows.push([entry.file.name,entry.status,entry.status==='done'?entryWarnings(entry).length:'',entry.analysis?fmt(entry.analysis.metrics[5],2):'',entry.analysis?fmt(entry.analysis.metrics[0],2):'',entry.analysis?entry.analysis.events[3].length:'',entry.analysis?entry.analysis.events[4].length:'',entry.error||'']);
  const quote=x=>'"'+String(x).replaceAll('"','""')+'"';
  downloadBlob(new Blob(['\ufeff'+rows.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),'soundproof_batch_report.csv');
});
$('resetButton').addEventListener('click',()=>{if(batchBusy)return;if(hasEdits&&!window.confirm('修正中の内容を破棄します。先にWAVを書き出しましたか？'))return;stopPlayback(true);stopPreview();selectedNoise=null;undoSnapshot=null;hasEdits=false;result=null;file=null;buffer=null;refs.results.hidden=true;selectedEntryId=null;renderBatch();refs.drop.scrollIntoView({behavior:'smooth',block:'center'});refs.fileInput.click();});
refs.eqOn.addEventListener('change',drawEq);
$('resetEqButton').addEventListener('click',()=>{eqBands=EQ_PRESETS.map(b=>({...b}));buildEqControls();drawEq();});
refs.export.addEventListener('click',exportWav);
window.addEventListener('resize',()=>{if(result)drawWaveform();});
buildEqControls();drawEq();
