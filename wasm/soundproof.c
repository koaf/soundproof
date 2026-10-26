/* SoundProof audio analysis core (C11, freestanding WebAssembly).
 * Audio input: interleaved 32-bit float PCM. Main app resamples to 48 kHz.
 * Results: BS.1770-style K weighted integrated loudness with EBU R128 gating,
 * sample peak, approximate 4x oversampled true peak, RMS, stereo correlation,
 * DC offset, silence segments and spectrum. Not a certified compliance meter.
 */
#include <stdint.h>

__attribute__((import_module("env"),import_name("log10"))) extern double js_log10(double);
__attribute__((import_module("env"),import_name("sin"))) extern double js_sin(double);
__attribute__((import_module("env"),import_name("cos"))) extern double js_cos(double);

void *memset(void *ptr, int value, unsigned long count) { unsigned char *out=(unsigned char*)ptr; for(unsigned long i=0;i<count;i++)out[i]=(unsigned char)value; return ptr; }

#define WAVEBINS 720
#define MAXEVENTS 160
#define FFT_N 2048
#define NOISE_N 16384
#define MAX_NOISE_CHECKS 32
#define PI 3.14159265358979323846

extern unsigned char __heap_base;
static uint32_t cursor=0;
static float wave_min[WAVEBINS], wave_max[WAVEBINS];
static double stats[28], bands[8];
static double silence_start[MAXEVENTS], silence_end[MAXEVENTS];
static double clip_start[MAXEVENTS], clip_end[MAXEVENTS];
static double spike_start[MAXEVENTS];
static double hum_start[MAXEVENTS],hum_end[MAXEVENTS],hiss_start[MAXEVENTS],hiss_end[MAXEVENTS];
static int hum_count,hiss_count;
static double noise_window[NOISE_N];
static int silence_count, clip_group_count, spike_count;
static double fft_real[FFT_N],fft_imag[FFT_N];

uint32_t allocate(uint32_t length) {
  if (!cursor) cursor=(uint32_t)(uintptr_t)&__heap_base;
  if (length>0x7fffffffU-16U || cursor>0x7fffffffU-length-16U) return 0;
  uint32_t p=(cursor+7U)&~7U;
  uint32_t end=p+length;
  if(end<p) return 0;
  uint32_t current=__builtin_wasm_memory_size(0);
  uint32_t required=(end+65535U)/65536U;
  if (required>current && __builtin_wasm_memory_grow(0,required-current)==(uint32_t)-1) return 0;
  cursor=end;
  return p;
}

void reset_alloc(void) {cursor=(uint32_t)(uintptr_t)&__heap_base;}

static double absd(double x) {return x<0?-x:x;}
static double clamp(double x,double lo,double hi) {return x<lo?lo:(x>hi?hi:x);}
static double db(double x){return x>1e-12?20.0*js_log10(x):-120.0;}
static double lufs(double x){return x>1e-16?(-0.691+10.0*js_log10(x)):-120.0;}

typedef struct {double x1,x2,y1,y2;} Biquad;
static double process_biquad(Biquad *s,double x,double b0,double b1,double b2,double a1,double a2){
  double y=b0*x+b1*s->x1+b2*s->x2-a1*s->y1-a2*s->y2;
  s->x2=s->x1;s->x1=x;s->y2=s->y1;s->y1=y;
  return y;
}

/* 4x interpolation coefficients, windowed sinc (generated offline). */
static const double kernel[3][16] = {
  {-0.000668266526330217, 0.00408641919001914, -0.0113288965575608, 0.0238795660120898, -0.0446703395667323, 0.0817318117286316, -0.169398090851901, 0.897966588714257, 0.293584684850336, -0.113996186294872, 0.0602024505550737, -0.0329454107739373, 0.0168115457603719, -0.00715423818508266, 0.00196827146500292, -6.99095193654345e-05},
  {-0.000407593185174138, 0.00412495285836369, -0.0128556658723949, 0.0284569769350241, -0.054323383450322, 0.0989928303942254, -0.194250696469581, 0.630262578789859, 0.630262578789859, -0.194250696469581, 0.0989928303942254, -0.054323383450322, 0.0284569769350241, -0.0128556658723949, 0.00412495285836369, -0.000407593185174138},
  {-6.99095193654345e-05, 0.00196827146500292, -0.00715423818508266, 0.0168115457603719, -0.0329454107739373, 0.0602024505550737, -0.113996186294872, 0.293584684850336, 0.897966588714257, -0.169398090851901, 0.0817318117286316, -0.0446703395667323, 0.0238795660120898, -0.0113288965575608, 0.00408641919001914, -0.000668266526330217},
};

static void record_silence(double start,double end){
  if(silence_count<MAXEVENTS){silence_start[silence_count]=start;silence_end[silence_count]=end;silence_count++;}
}
static void record_clip(double start,double end){
  if(clip_group_count<MAXEVENTS){clip_start[clip_group_count]=start;clip_end[clip_group_count]=end;clip_group_count++;}
}

/* Percentile from half-dB histogram covering [-120, 0] dB. */
static double hist_percentile(const uint32_t *hist,int bins,double pct){
  uint32_t total=0,run=0;
  for(int i=0;i<bins;i++) total+=hist[i];
  if(!total)return -120;
  double target=(total-1)*pct;
  for(int i=0;i<bins;i++){
    run+=hist[i];
    if(run>target)return -120.0+((double)i+0.5)*0.5;
  }
  return 0;
}
static void hist_add(uint32_t *hist,double value){
  int bin=(int)((clamp(value,-120,0)+120.0)*2.0);
  if(bin>239)bin=239;
  hist[bin]++;
}

static void compute_spectrum(const float *data,uint32_t frames,uint32_t channels,uint32_t sr){
  const double edges[9]={0,120,300,700,1500,3000,6000,12000,24000};
  double power[8]={0,0,0,0,0,0,0,0};
  if(frames<FFT_N){for(int b=0;b<8;b++)bands[b]=-60;return;}
  const int snaps=18;
  for(int snap=0;snap<snaps;snap++){
    uint32_t start=(uint32_t)(((uint64_t)(frames-FFT_N)*(uint64_t)(snap+1))/(snaps+1));
    for(int i=0;i<FFT_N;i++){
      double s=0;
      for(uint32_t ch=0;ch<channels;ch++)s+=data[((uint64_t)start+i)*channels+ch];
      double win=0.5-0.5*js_cos(2*PI*i/(FFT_N-1));
      fft_real[i]=(s/channels)*win;fft_imag[i]=0;
    }
    for(int i=1,j=0;i<FFT_N;i++){
      int bit=FFT_N>>1;
      for(;j&bit;bit>>=1)j^=bit;
      j^=bit;
      if(i<j){double t=fft_real[i];fft_real[i]=fft_real[j];fft_real[j]=t;}
    }
    for(int len=2;len<=FFT_N;len<<=1){
      double angle=-2.0*PI/len;
      double wr=js_cos(angle),wi=js_sin(angle);
      for(int i=0;i<FFT_N;i+=len){
        double pr=1,pi=0;
        for(int k=0;k<len/2;k++){
          int a=i+k,c=a+len/2;
          double tr=fft_real[c]*pr-fft_imag[c]*pi;
          double ti=fft_real[c]*pi+fft_imag[c]*pr;
          fft_real[c]=fft_real[a]-tr;fft_imag[c]=fft_imag[a]-ti;
          fft_real[a]+=tr;fft_imag[a]+=ti;
          double nr=pr*wr-pi*wi;
          pi=pr*wi+pi*wr;pr=nr;
        }
      }
    }
    double local[8]={0,0,0,0,0,0,0,0};
    uint32_t counts[8]={0,0,0,0,0,0,0,0};
    for(int k=1;k<FFT_N/2;k++){
      double freq=(double)k*sr/FFT_N;
      double mag=fft_real[k]*fft_real[k]+fft_imag[k]*fft_imag[k];
      for(int b=0;b<8;b++)if(freq>=edges[b]&&freq<edges[b+1]){
        local[b]+=mag;counts[b]++;break;
      }
    }
    for(int b=0;b<8;b++) if(counts[b]) power[b]+=local[b]/counts[b];
  }
  double maxpower=0;
  for(int b=0;b<8;b++)if(power[b]>maxpower)maxpower=power[b];
  for(int b=0;b<8;b++){
    bands[b]=maxpower>1e-12?clamp(10.0*js_log10((power[b]+1e-15)/maxpower),-60,0):-60;
  }
}

/* Sound quality screening only, NOT proof that a given noise source exists.
 * Inspect short quiet passages for narrow 50/60 Hz tonal energy and broad high-frequency energy.
 * Avoid speech / music passages and report candidates only when multiple windows agree.
 */
static double tone_power(const double *samples,int length,double frequency,double sr){
  double coeff=2*js_cos(2*PI*frequency/sr);
  double a=0,b=0;
  for(int i=0;i<length;i++){
    double next=samples[i]+coeff*a-b;
    b=a;a=next;
  }
  return (a*a+b*b-coeff*a*b);
}
static void analyze_noise(const float *data,uint32_t frames,uint32_t channels,uint32_t sr){
  hum_count=hiss_count=0;
  for(int i=21;i<28;i++)stats[i]=0;
  if(frames<NOISE_N||sr!=48000)return;
  uint32_t steps=frames/NOISE_N;
  if(steps<1)return;
  uint32_t stride=steps>MAX_NOISE_CHECKS?(steps+MAX_NOISE_CHECKS-1)/MAX_NOISE_CHECKS:1;
  double level_sum=0,best_hum=0,hi_share_sum=0;
  int inspected=0,hum_votes=0,hiss_votes=0, freq50=0,freq60=0;
  for(uint32_t k=0;k<steps&&inspected<MAX_NOISE_CHECKS;k+=stride){
    uint32_t start=k*NOISE_N;
    if(start+NOISE_N>frames)break;
    double power=0,mean=0,hi_power=0,lp=0;
    const double a=0.71; /* First-order >~2.6 kHz high-pass for a rough noise-energy fraction */
    for(int i=0;i<NOISE_N;i++){
      double x=0;
      for(uint32_t ch=0;ch<channels;ch++)x+=data[((uint64_t)start+i)*channels+ch];
      x/=channels;
      mean+=x;power+=x*x;
      lp=a*lp+(1-a)*x;
      double hp=x-lp;hi_power+=hp*hp;
      noise_window[i]=x;
    }
    double rms=__builtin_sqrt(power/NOISE_N);
    if(rms<.0001 || rms>.0316228)continue; /* -80 < window RMS < -30 dBFS */
    inspected++;
    level_sum+=db(rms);
    double hi_share=hi_power/(power+1e-20);
    hi_share_sum+=hi_share;
    double dc=mean/NOISE_N;
    for(int i=0;i<NOISE_N;i++){
      /* Hann window; guard against DC leaking into 50/60 Hz energy. */
      double window=0.5-0.5*js_cos(2*PI*i/(NOISE_N-1));
      noise_window[i]=(noise_window[i]-dc)*window;
    }
    double p50=tone_power(noise_window,NOISE_N,50,sr),p60=tone_power(noise_window,NOISE_N,60,sr);
    double near50=tone_power(noise_window,NOISE_N,30,sr)+tone_power(noise_window,NOISE_N,78,sr);
    double near60=tone_power(noise_window,NOISE_N,35,sr)+tone_power(noise_window,NOISE_N,88,sr);
    double t50=10*js_log10((p50+1e-18)/(near50*.5+1e-18));
    double t60=10*js_log10((p60+1e-18)/(near60*.5+1e-18));
    int mains=p50>p60?50:60;
    double contrast=t50>t60?t50:t60;
    double amp=2*__builtin_sqrt(p50>p60?p50:p60)/(NOISE_N*.5); /* approximate sine amplitude */
    if(contrast>=9&&amp>.00016){
      hum_votes++;if(mains==50)freq50++;else freq60++;
      if(contrast>best_hum)best_hum=contrast;
      if(hum_count<MAXEVENTS){hum_start[hum_count]=(double)start/sr;hum_end[hum_count]=(double)(start+NOISE_N)/sr;hum_count++;}
    }
    /* Broadband HF energy can be hiss OR intentional ambience / consonants. */
    if(hi_share>.28 && __builtin_sqrt(hi_power/NOISE_N)>.00017){
      hiss_votes++;
      if(hiss_count<MAXEVENTS){hiss_start[hiss_count]=(double)start/sr;hiss_end[hiss_count]=(double)(start+NOISE_N)/sr;hiss_count++;}
    }
  }
  stats[21]=inspected;
  stats[22]=hum_votes;
  stats[23]=hiss_votes;
  stats[24]=inspected?level_sum/inspected:-120;
  stats[25]=hum_votes?(freq50>=freq60?50:60):0;
  stats[26]=best_hum;
  stats[27]=inspected?hi_share_sum/inspected:0;
  /* Do not publish one-off detections. */
  if(hum_votes<2){hum_count=0;stats[22]=0;stats[25]=0;}
  if(hiss_votes<2){hiss_count=0;stats[23]=0;}
}

int analyze(uint32_t data_ptr,uint32_t frames,uint32_t channels,uint32_t sr,double silence_amp,uint32_t minimum_silence_ms){
  if(!data_ptr||!frames||channels<1||channels>2||sr<8000||sr>192000)return -1;
  const float *data=(const float*)(uintptr_t)data_ptr;
  for(int i=0;i<28;i++)stats[i]=0;
  for(int i=0;i<WAVEBINS;i++){wave_min[i]=1;wave_max[i]=-1;}
  silence_count=clip_group_count=spike_count=0;
  double maxpeak=0,truepeak=0,sumSquares=0,sumDc=0,leftSquares=0,rightSquares=0,cross=0;
  double clipSamples=0, maxClipStart=-1, lastClip=-1;
  uint32_t step=(sr/20U)>0?sr/20U:1; /* 50ms */
  uint32_t windows=(frames+step-1)/step;
  uint32_t *hist=(uint32_t*)(uintptr_t)allocate(240*sizeof(uint32_t));
  if(!hist)return -2;
  for(int i=0;i<240;i++)hist[i]=0;
  double silenceBegin=-1,silentSec=0;
  double amp2=silence_amp*silence_amp;
  Biquad stage1[2]={{0},{0}},stage2[2]={{0},{0}};
  uint32_t hop=(sr/10U)>0?sr/10U:1;
  uint32_t hops=(frames+hop-1)/hop;
  double *kenergy=(double*)(uintptr_t)allocate((hops+1)*sizeof(double));
  if(!kenergy)return -2;
  for(uint32_t i=0;i<=hops;i++)kenergy[i]=0;
  double windowSum=0;uint32_t withinWindow=0,windowIdx=0;
  double weightedEnergy=0;
  for(uint32_t frame=0;frame<frames;frame++){
    double maxAbs=0,frameEnergy=0;
    for(uint32_t ch=0;ch<channels;ch++){
      double x=data[(uint64_t)frame*channels+ch];
      if(x!=x||x>100||x< -100)x=0; /* avoid non-finite input */
      double ax=absd(x);if(ax>maxAbs)maxAbs=ax;
      if(ax>maxpeak)maxpeak=ax;
      if(ax>=0.999969){clipSamples+=1;
        double t=(double)frame/sr;
        if(maxClipStart<0)maxClipStart=t;
        lastClip=t;
      }
      sumSquares+=x*x;sumDc+=x;frameEnergy+=x*x;
      if(ch==0)leftSquares+=x*x;
      else {rightSquares+=x*x;cross+=x*data[(uint64_t)frame*channels];}
      double y=process_biquad(&stage1[ch],x,1.53512485958697,-2.69169618940638,1.19839281085285,-1.69065929318241,0.73248077421585);
      y=process_biquad(&stage2[ch],y,1.,-2.,1.,-1.99004745483398,0.99007225036621);
      weightedEnergy+=y*y;
      kenergy[frame/hop]+=y*y;
    }
    frameEnergy/=channels;
    int wb=(int)((uint64_t)frame*WAVEBINS/frames);
    if(wb>=WAVEBINS)wb=WAVEBINS-1;
    if(-maxAbs<wave_min[wb])wave_min[wb]=(float)(-maxAbs);
    if(maxAbs>wave_max[wb])wave_max[wb]=(float)maxAbs;
    windowSum+=frameEnergy; withinWindow++;
    if(withinWindow==step||frame==frames-1){
      double rms2=windowSum/withinWindow;
      hist_add(hist,db(__builtin_sqrt(rms2)));
      double tStart=(double)(frame+1-withinWindow)/sr;
      double tEnd=(double)(frame+1)/sr;
      if(rms2<amp2){if(silenceBegin<0)silenceBegin=tStart;}
      else if(silenceBegin>=0){
        if((tStart-silenceBegin)*1000.0>=minimum_silence_ms){record_silence(silenceBegin,tStart);silentSec+=tStart-silenceBegin;}
        silenceBegin=-1;
      }
      windowSum=0;withinWindow=0;windowIdx++;
    }
    if(maxClipStart>=0&&lastClip>=0&&((double)frame/sr-lastClip)>0.02){
      record_clip(maxClipStart,lastClip+1.0/sr);
      maxClipStart=-1;lastClip=-1;
    }
  }
  if(silenceBegin>=0){double end=(double)frames/sr;
    if((end-silenceBegin)*1000.0>=minimum_silence_ms){record_silence(silenceBegin,end);silentSec+=end-silenceBegin;}
  }
  if(maxClipStart>=0)record_clip(maxClipStart,lastClip+1.0/sr);
  for(int i=0;i<WAVEBINS;i++)if(wave_min[i]>wave_max[i]){wave_min[i]=0;wave_max[i]=0;}

  /* Gated integrated loudness: 400ms blocks at 100ms hop. */
  double pregateSum=0,preCount=0;
  for(uint32_t b=0;b+4<=hops;b++){
    double energy=0;
    for(int i=0;i<4;i++)energy+=kenergy[b+i];
    double l=lufs(energy/(4.0*hop));
    if(l>=-70){pregateSum+=energy/(4.0*hop);preCount++;}
  }
  double relativeGate=preCount?lufs(pregateSum/preCount)-10:-70;
  double gate=relativeGate>-70?relativeGate:-70;
  double postSum=0,postCount=0;
  for(uint32_t b=0;b+4<=hops;b++){
    double energy=0;
    for(int i=0;i<4;i++)energy+=kenergy[b+i];
    double value=energy/(4.0*hop);
    if(lufs(value)>=gate){postSum+=value;postCount++;}
  }
  double integrated=postCount?lufs(postSum/postCount):-120;
  /* Loudness range: short-term 3s blocks at 1s hop, -70 LUFS absolute and -20 LU relative gate. */
  double stSum=0,stCount=0;
  for(uint32_t b=0;b+30<=hops;b+=10){
    double energy=0;for(int i=0;i<30;i++)energy+=kenergy[b+i];
    double v=energy/(30.0*hop);
    if(lufs(v)>=-70){stSum+=v;stCount++;}
  }
  double stGate=stCount?lufs(stSum/stCount)-20:-70;
  if(stGate< -70)stGate=-70;
  uint32_t lraHist[240]={0};
  for(uint32_t b=0;b+30<=hops;b+=10){
    double energy=0;for(int i=0;i<30;i++)energy+=kenergy[b+i];
    double l=lufs(energy/(30.0*hop));
    if(l>=stGate)hist_add(lraHist,l);
  }
  double lra=hist_percentile(lraHist,240,.95)-hist_percentile(lraHist,240,.10);
  if(lra<0)lra=0;

  /* True-peak estimate: interpolation near prominent sample peaks. */
  truepeak=maxpeak;
  for(uint32_t i=7;i+9<frames;i++){
    for(uint32_t ch=0;ch<channels;ch++){
      double p=absd(data[(uint64_t)i*channels+ch]);
      double pn=absd(data[((uint64_t)i+1)*channels+ch]);
      if(p<.30&&pn<.30)continue;
      for(int phase=0;phase<3;phase++){
        double y=0;
        for(int j=0;j<16;j++)y+=kernel[phase][j]*data[((uint64_t)(i+j-7))*channels+ch];
        double val=absd(y);if(val>truepeak)truepeak=val;
      }
    }
  }
  /* Conservative, isolated single-sample spike candidates (NOT a definitive noise diagnosis).
   * Only flag isolated impulses surrounded by almost-silent adjacent samples. */
  double lastSpike=-1;
  for(uint32_t frame=2;frame+2<frames;frame++){
    for(uint32_t ch=0;ch<channels;ch++){
      double x=absd(data[(uint64_t)frame*channels+ch]);
      if(x<.14)continue;
      double a=absd(data[((uint64_t)frame-2)*channels+ch]);
      double b=absd(data[((uint64_t)frame-1)*channels+ch]);
      double c=absd(data[((uint64_t)frame+1)*channels+ch]);
      double d=absd(data[((uint64_t)frame+2)*channels+ch]);
      if(a<.035&&b<.035&&c<.035&&d<.035){
        double t=(double)frame/sr;
        if(lastSpike<0 || t-lastSpike>.08){
          if(spike_count<MAXEVENTS)spike_start[spike_count++]=t;
          lastSpike=t;
        }
      }
    }
  }
  double duration=(double)frames/sr;
  stats[0]=db(maxpeak);
  stats[1]=db(truepeak);
  stats[2]=db(__builtin_sqrt(sumSquares/((double)frames*channels)));
  stats[3]=sumDc/(frames*channels);
  stats[4]=channels==2&&leftSquares>1e-12&&rightSquares>1e-12?cross/__builtin_sqrt(leftSquares*rightSquares):0;
  stats[5]=integrated;
  stats[6]=lra;
  stats[7]=hist_percentile(hist,240,.15); /* Low-level portion RMS, not noise floor */
  stats[8]=silentSec;
  stats[9]=clipSamples;
  stats[10]=duration;
  stats[11]=duration>0?silentSec/duration:0;
  stats[12]=maxpeak;
  stats[13]=truepeak;
  stats[14]=channels==2?db(__builtin_sqrt(leftSquares/frames))-db(__builtin_sqrt(rightSquares/frames)):0;
  stats[15]=stats[0]-stats[2]; /* crest factor */
  stats[16]=weightedEnergy/(frames*channels);
  stats[17]=silence_count;
  stats[18]=clip_group_count;
  stats[19]=channels;
  stats[20]=spike_count;
  compute_spectrum(data,frames,channels,sr);
  analyze_noise(data,frames,channels,sr);
  return 0;
}

double metric(int index){return index>=0&&index<28?stats[index]:0;}

/* Local, non-destructive region repair. Operates only on the caller-provided
 * interleaved snippet, not the full file. Effect is faded in/out at boundaries.
 * mode: 1=50Hz hum notches, 2=60Hz hum notches, 3=gentle hiss lowpass,
 *       4=short click interpolation, 5=region attenuation.
 * strength: 0..1. This is an auditionable suggestion, not restoration proof.
 */
static double limited(double x,double a,double b){return x<a?a:(x>b?b:x);}
int repair_pcm(uint32_t address,uint32_t frames,uint32_t channels,uint32_t sr,
               uint32_t mode,double strength,uint32_t click_index){
  if(!address||frames<8||channels<1||channels>2||sr!=48000||mode<1||mode>5)return -1;
  if(strength<0||strength>1)return -2;
  float *pcm=(float*)(uintptr_t)address;
  if(mode==4){
    if(click_index<4||click_index+4>=frames)return -3;
    /* Restrict the edit to just five samples around the candidate. */
    for(uint32_t ch=0;ch<channels;ch++){
      double left=pcm[(click_index-3)*channels+ch];
      double right=pcm[(click_index+3)*channels+ch];
      for(int d=-2;d<=2;d++){
        uint32_t i=(uint32_t)((int)click_index+d);
        double t=(d+3)/6.0;
        double corrected=left*(1-t)+right*t;
        double original=pcm[i*channels+ch];
        pcm[i*channels+ch]=(float)(original*(1-strength)+corrected*strength);
      }
    }
    return 0;
  }
  double coefficients[3][5]={{0}};
  int count=0;
  if(mode==1||mode==2){
    double f=(mode==1)?50.0:60.0;
    count=3;
    for(int h=0;h<count;h++){
      double w=2*PI*(h+1)*f/sr;
      double cosw=js_cos(w);
      double alpha=js_sin(w)/(2.0*25.0); /* Narrow notch Q=25 */
      double a0=1+alpha;
      coefficients[h][0]=1/a0;
      coefficients[h][1]=-2*cosw/a0;
      coefficients[h][2]=1/a0;
      coefficients[h][3]=-2*cosw/a0;
      coefficients[h][4]=(1-alpha)/a0;
    }
  }else if(mode==3){
    /* Lowpass is an intentional broadband compromise; may dull consonants. */
    double w=2*PI*8500.0/sr;
    double cosw=js_cos(w),alpha=js_sin(w)/(2*0.70710678118);
    double a0=1+alpha;
    coefficients[0][0]=(1-cosw)/(2*a0);
    coefficients[0][1]=(1-cosw)/a0;
    coefficients[0][2]=(1-cosw)/(2*a0);
    coefficients[0][3]=-2*cosw/a0;
    coefficients[0][4]=(1-alpha)/a0;
    count=1;
  }
  Biquad states[3][2]={0};
  uint32_t ramp=(uint32_t)(sr*0.018);
  if(ramp>frames/2)ramp=frames/2;
  for(uint32_t i=0;i<frames;i++){
    double edge=1.0;
    if(ramp>0){
      if(i<ramp)edge=(double)i/ramp;
      if(frames-1-i<ramp)edge=limited((double)(frames-1-i)/ramp,0,edge);
    }
    double mix=strength*limited(edge,0,1);
    for(uint32_t ch=0;ch<channels;ch++){
      uint32_t off=i*channels+ch;
      double x=pcm[off],y=x;
      if(mode==5){y=x*0.12589254117941673; /* -18 dB maximum */}
      else for(int f=0;f<count;f++){
        double *k=coefficients[f];
        y=process_biquad(&states[f][ch],y,k[0],k[1],k[2],k[3],k[4]);
      }
      pcm[off]=(float)(x+(y-x)*mix);
    }
  }
  return 0;
}

int event_count(int kind){return kind==0?silence_count:(kind==1?clip_group_count:(kind==2?spike_count:(kind==3?hum_count:(kind==4?hiss_count:0))));}
double event_start(int kind,int index){if(index<0||index>=MAXEVENTS)return 0;return kind==0?silence_start[index]:(kind==1?clip_start[index]:(kind==2?spike_start[index]:(kind==3?hum_start[index]:hiss_start[index])));}
double event_end(int kind,int index){if(index<0||index>=MAXEVENTS)return 0;return kind==0?silence_end[index]:(kind==1?clip_end[index]:(kind==2?spike_start[index]:(kind==3?hum_end[index]:hiss_end[index])));}
double waveform_min(int index){return index>=0&&index<WAVEBINS?wave_min[index]:0;}
double waveform_max(int index){return index>=0&&index<WAVEBINS?wave_max[index]:0;}
double band_value(int index){return index>=0&&index<8?bands[index]:-60;}
int wasm_version(void){return 2;}
