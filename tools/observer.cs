// SPDX-License-Identifier: GPL-3.0-or-later
// Watches the real screen from another process: when does the text of MochiReader appear on the desktop?
// Starts the app the way a double click does and writes one JSON line per run, with times in ms from the
// creation of the process. Compiled by tools/measure.ps1 with the csc of .NET Framework, so C# 5 only.
//   observer.exe <exe> <file> <results.jsonl> <png prefix> <hold ms>
using System; using System.Collections.Generic; using System.Diagnostics; using System.Drawing; using System.Drawing.Imaging;
using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;
using System.Globalization;
static class O {
  const long EPOCH = 116444736000000000L;
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long ft);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr h, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [StructLayout(LayoutKind.Sequential)] struct BMI { public int size,w,h; public short planes,bits; public int comp,img,xp,yp,used,imp; }
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI b, uint u, out IntPtr bits, IntPtr s, uint o);
  const string APP_TITLE = "MochiReader";
  const uint SRCCOPY = 0x00CC0020, WM_CLOSE = 0x10;
  static string N1(double v) { return v.ToString("F1", CultureInfo.InvariantCulture); }
  static double Now() { long f; GetSystemTimePreciseAsFileTime(out f); return (f-EPOCH)/10000.0; }
  // The window of the app, whichever of its two titles it has by now. The process has other windows, not these.
  static IntPtr Find(uint pid, string fileName) {
    IntPtr found = IntPtr.Zero; var sb = new StringBuilder(260);
    EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid){ sb.Length=0; GetWindowText(h,sb,260); string t=sb.ToString(); if(t==APP_TITLE||t==fileName){found=h;return false;} } return true; }, IntPtr.Zero);
    return found;
  }
  class F { public double t0,t1; public int[] px; }
  static void Save(int[] px,int w,int h,string path){
    using(var b=new Bitmap(w,h,PixelFormat.Format32bppRgb)){
      var d=b.LockBits(new Rectangle(0,0,w,h),ImageLockMode.WriteOnly,PixelFormat.Format32bppRgb);
      for(int y=0;y<h;y++) Marshal.Copy(px,(h-1-y)*w,new IntPtr(d.Scan0.ToInt64()+y*d.Stride),w);
      b.UnlockBits(d); b.Save(path,ImageFormat.Png);
    }
  }
  static int Main(string[] a) {
    SetProcessDPIAware();
    string exe=a[0], file=a[1], outp=a[2], pngPrefix=a[3]; int holdMs=int.Parse(a[4]);
    string fileName=Path.GetFileName(file);
    // Warm the capture path so JIT does not delay the first capture.
    int W=700,H=400; IntPtr scr=GetDC(IntPtr.Zero), mem=CreateCompatibleDC(scr); IntPtr bits;
    var bmi=new BMI{size=40,w=W,h=H,planes=1,bits=32};
    IntPtr dib=CreateDIBSection(scr,ref bmi,0,out bits,IntPtr.Zero,0); SelectObject(mem,dib);
    var buf=new int[W*H]; BitBlt(mem,0,0,W,H,scr,0,0,SRCCOPY); Marshal.Copy(bits,buf,0,buf.Length); Now(); Find(0,fileName);
    var psi=new ProcessStartInfo(exe,"\""+file+"\""){UseShellExecute=false};
    double tStart=Now(); var p=Process.Start(psi);
    long c,e,k,u; GetProcessTimes(p.Handle,out c,out e,out k,out u); double created=(c-EPOCH)/10000.0;
    uint pid=(uint)p.Id; IntPtr hwnd=IntPtr.Zero; double limit=tStart+15000;
    while(hwnd==IntPtr.Zero && Now()<limit){ hwnd=Find(pid,fileName); }
    double tHwnd=Now();
    while(!IsWindowVisible(hwnd) && Now()<limit){ Thread.SpinWait(200); }
    double tVis=Now();
    RECT r; GetClientRect(hwnd,out r); POINT o=new POINT{X=100,Y=60}; ClientToScreen(hwnd,ref o);
    int cw=r.R-r.L, ch=r.B-r.T;
    var frames=new List<F>(); int polls=0; double sumDt=0; long lastHash=0; double end=tVis+holdMs;
    while(Now()<end){
      double t0=Now(); BitBlt(mem,0,0,W,H,scr,o.X,o.Y,SRCCOPY); double t1=Now();
      Marshal.Copy(bits,buf,0,buf.Length); long hash=17; for(int i=0;i<buf.Length;i++) hash=hash*31+buf[i];
      polls++; sumDt+=t1-t0;
      if(polls==1||hash!=lastHash){ lastHash=hash; frames.Add(new F{t0=t0,t1=t1,px=(int[])buf.Clone()}); }
    }
    bool fg=GetForegroundWindow()==hwnd;
    var fin=frames[frames.Count-1].px;
    var counts=new Dictionary<int,int>(); foreach(var v in fin){int n; counts.TryGetValue(v,out n); counts[v]=n+1;}
    int bg=0,bgN=0; foreach(var kv in counts) if(kv.Value>bgN){bgN=kv.Value;bg=kv.Key;}
    int textPx=fin.Length-bgN;
    var sb=new StringBuilder();
    Func<double,string> S=(x)=>N1(x-created);
    sb.Append("{\"created\":"+created.ToString("F3",CultureInfo.InvariantCulture)+",\"pid\":"+pid+",\"launchToCreated\":"+N1(created-tStart)+",\"hwndSeen\":"+S(tHwnd)+",\"visibleSeen\":"+S(tVis)+",\"clientW\":"+cw+",\"clientH\":"+ch+",\"origin\":["+o.X+","+o.Y+"],\"polls\":"+polls+",\"avgCaptureMs\":"+(sumDt/polls).ToString("F2",CultureInfo.InvariantCulture)+",\"fg\":"+(fg?"true":"false")+",\"finalTextPx\":"+textPx+",\"frames\":[");
    double first50=-1,first99=-1; int fi=0; int idx50=-1;
    bool[] mask=new bool[fin.Length]; long ms=0,us=0; int mn=0,un=0;
    Func<int,int> L=(v)=>(((v>>16)&255)+((v>>8)&255)+(v&255))/3;
    int bgL=L(bg);
    for(int i=0;i<fin.Length;i++){ int d=Math.Abs(L(fin[i])-bgL); if(d>=60){mask[i]=true;ms+=L(fin[i]);mn++;} else if(d==0){us+=L(fin[i]);un++;} }
    double finalContrast=(mn==0||un==0)?1:(double)ms/mn-(double)us/un;
    double firstA5=-1,firstA25=-1,firstA50=-1,firstA90=-1;
    foreach(var f in frames){
      int match=0,nonBg=0; long fm=0,fu=0;
      for(int i=0;i<fin.Length;i++){ if(fin[i]!=bg&&f.px[i]==fin[i]) match++; if(f.px[i]!=bg) nonBg++; if(mask[i]) fm+=L(f.px[i]); else if(L(fin[i])==bgL) fu+=L(f.px[i]); }
      double alpha=(mn==0||un==0)?0:100.0*((double)fm/mn-(double)fu/un)/finalContrast;
      if(firstA5<0&&alpha>=5) firstA5=f.t1; if(firstA25<0&&alpha>=25) firstA25=f.t1; if(firstA50<0&&alpha>=50) firstA50=f.t1; if(firstA90<0&&alpha>=90) firstA90=f.t1;
      double pct= textPx==0?0:100.0*match/textPx;
      if(first50<0&&pct>=50){first50=f.t1;idx50=fi;}
      if(first99<0&&pct>=99) first99=f.t1;
      if(fi>0) sb.Append(",");
      sb.Append("{\"t0\":"+S(f.t0)+",\"t1\":"+S(f.t1)+",\"textContrastPct\":"+N1(alpha)+",\"matchPct\":"+N1(pct)+",\"nonBgPx\":"+nonBg+"}"); fi++;
    }
    Func<double,string> Q=(x)=>x<0?"null":S(x);
    sb.Append("],\"contrast5\":"+Q(firstA5)+",\"contrast25\":"+Q(firstA25)+",\"contrast50\":"+Q(firstA50)+",\"contrast90\":"+Q(firstA90)+",\"text50Ms\":"+(first50<0?"null":S(first50))+",\"text99Ms\":"+(first99<0?"null":S(first99))+"}");
    File.AppendAllText(outp,sb.ToString()+"\n");
    Save(frames[0].px,W,H,pngPrefix+"-first.png");
    if(idx50>=0) Save(frames[idx50].px,W,H,pngPrefix+"-text.png");
    Save(fin,W,H,pngPrefix+"-final.png");
    PostMessage(hwnd,WM_CLOSE,IntPtr.Zero,IntPtr.Zero);
    if(!p.WaitForExit(4000)){ p.Kill(); Console.WriteLine("killed"); }
    return 0;
  }
}
