param(
  [Parameter(Mandatory = $true)][ValidateSet('Crop','Compare')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$ReferencePath,
  [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
  [ValidateRange(0,255)][int]$Tolerance = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class ZoneBaselineImage {
  static Bitmap Load(string path) {
    if (new FileInfo(path).Length > 33554432) throw new Exception("Image exceeds input limit");
    using (var source = new Bitmap(path)) {
      if ((long)source.Width * source.Height > 16000000) throw new Exception("Image exceeds pixel limit");
      var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
      using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImageUnscaled(source, 0, 0);
      return bitmap;
    }
  }
  public static long[] Crop(string input, string output, int x, int y, int width, int height) {
    using (var image = Load(input)) {
      if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.Width || y + height > image.Height) throw new Exception("Crop escapes screenshot bounds");
      using (var crop = image.Clone(new Rectangle(x,y,width,height), PixelFormat.Format32bppArgb)) crop.Save(output, ImageFormat.Png);
      return new long[] {width,height};
    }
  }
  public static long[] Compare(string input, string reference, string output, int tolerance) {
    using (var current = Load(input)) using (var baseline = Load(reference)) {
      if (current.Size != baseline.Size) throw new Exception("Image dimensions differ");
      var rectangle = new Rectangle(0,0,current.Width,current.Height);
      var a = current.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var b = baseline.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      long changed=0, totalDelta=0, maximum=0;
      byte[] pixels, other, diff;
      try {
        if (a.Stride <= 0 || a.Stride != b.Stride) throw new Exception("Unsupported image stride");
        pixels = new byte[a.Stride*current.Height]; other = new byte[pixels.Length]; diff = new byte[pixels.Length];
        Marshal.Copy(a.Scan0,pixels,0,pixels.Length); Marshal.Copy(b.Scan0,other,0,other.Length);
        for (int y=0;y<current.Height;y++) for (int x=0;x<current.Width;x++) {
          int offset=y*a.Stride+x*4, delta=0;
          for (int c=0;c<4;c++) { int d=Math.Abs((int)pixels[offset+c]-other[offset+c]); totalDelta+=d; delta=Math.Max(delta,d); }
          maximum=Math.Max(maximum,delta);
          if (delta>tolerance) { changed++; diff[offset]=128; diff[offset+1]=0; diff[offset+2]=255; }
          else { byte grey=(byte)((pixels[offset]+pixels[offset+1]+pixels[offset+2])/6); diff[offset]=grey; diff[offset+1]=grey; diff[offset+2]=grey; }
          diff[offset+3]=255;
        }
      } finally { current.UnlockBits(a); baseline.UnlockBits(b); }
      using (var image = new Bitmap(current.Width,current.Height,PixelFormat.Format32bppArgb)) {
        var data=image.LockBits(rectangle,ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
        try { Marshal.Copy(diff,0,data.Scan0,diff.Length); } finally { image.UnlockBits(data); }
        image.Save(output,ImageFormat.Png);
      }
      return new long[] {current.Width,current.Height,changed,maximum,totalDelta};
    }
  }
}
'@
if ($Action -eq 'Crop') {
  $result = [ZoneBaselineImage]::Crop($InputPath,$OutputPath,$X,$Y,$Width,$Height)
  @{ width = $result[0]; height = $result[1] } | ConvertTo-Json -Compress
} else {
  if (-not $ReferencePath) { throw 'Compare requires a reference PNG' }
  $result = [ZoneBaselineImage]::Compare($InputPath,$ReferencePath,$OutputPath,$Tolerance)
  @{ width = $result[0]; height = $result[1]; changedPixels = $result[2]; changedRatio = $result[2] / [double]($result[0]*$result[1]); maxChannelDelta = $result[3]; meanChannelDelta = $result[4] / [double]($result[0]*$result[1]*4) } | ConvertTo-Json -Compress
}
