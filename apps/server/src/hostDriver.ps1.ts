// The host driver's script. beebotd writes it to its runtime folder and runs it in Windows
// PowerShell, which every Windows has, so nothing extra ships or installs. One JSON request per
// stdin line, one JSON answer per stdout line.
//
// Coordinates are physical pixels of the primary display. Every input op carries `at`, where the
// pointer should be. Any other position means the owner moved the mouse, and the op is refused
// as `moved`. Input aimed at a window of `BEE_GUARD_EXE` (Bee Bot's own) is refused as `own_window`.
export const hostDriverScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BeeHost {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

  const uint MOUSE = 0, KEYBOARD = 1;
  const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40;
  const uint WHEEL = 0x800, HWHEEL = 0x1000;
  const uint EXTENDED = 0x1, KEYUP = 0x2, UNICODE = 0x4;
  public static string Guard = "";

  public static void Init() {
    // Physical pixels, so the screenshot and the pointer agree at any display scaling.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }

  public static int Width() { return GetSystemMetrics(0); }
  public static int Height() { return GetSystemMetrics(1); }

  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }

  static string ExeOf(IntPtr window) {
    if (window == IntPtr.Zero) return "";
    uint pid; GetWindowThreadProcessId(GetAncestor(window, 2), out pid);
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      var name = new StringBuilder(1024); int size = name.Capacity;
      return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString() : "";
    } finally { CloseHandle(process); }
  }

  static bool Guarded(string exe) {
    return Guard.Length > 0 && string.Equals(exe, Guard, StringComparison.OrdinalIgnoreCase);
  }

  // Null when the op may go on, else why not.
  public static string Check(int atX, int atY, bool pointer, bool keyboard) {
    POINT p = Cursor();
    if (Math.Abs(p.X - atX) > 2 || Math.Abs(p.Y - atY) > 2) return "moved";
    if (pointer && Guarded(ExeOf(WindowFromPoint(p)))) return "own_window";
    if (keyboard && Guarded(ExeOf(GetForegroundWindow()))) return "own_window";
    return null;
  }

  static INPUT Mouse(uint flags, int data) {
    var input = new INPUT { type = MOUSE };
    input.u.mi.dwFlags = flags; input.u.mi.mouseData = unchecked((uint)data);
    return input;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var input = new INPUT { type = KEYBOARD };
    input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags;
    return input;
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) {
      throw new Exception("blocked");
    }
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  public static void Button(int button, bool down) {
    uint flags = button == 3 ? (down ? RIGHTDOWN : RIGHTUP) : button == 2 ? (down ? MIDDLEDOWN : MIDDLEUP) : (down ? LEFTDOWN : LEFTUP);
    Send(Mouse(flags, 0));
  }

  public static void Scroll(string direction, int amount) {
    bool horizontal = direction == "left" || direction == "right";
    int sign = direction == "up" || direction == "right" ? 1 : -1;
    for (int i = 0; i < amount; i++) { Send(Mouse(horizontal ? HWHEEL : WHEEL, sign * 120)); Thread.Sleep(15); }
  }

  // Down in order, up in reverse: a chord such as ctrl+shift+Tab.
  public static void Keys(int[] vks, bool[] extended) {
    for (int i = 0; i < vks.Length; i++) Send(Key((ushort)vks[i], 0, extended[i] ? EXTENDED : 0));
    for (int i = vks.Length - 1; i >= 0; i--) Send(Key((ushort)vks[i], 0, (extended[i] ? EXTENDED : 0) | KEYUP));
  }

  // Paced, and checked between characters, so the owner's own window never gets the rest.
  public static string Type(string text) {
    foreach (char c in text) {
      if (Guarded(ExeOf(GetForegroundWindow()))) return "own_window";
      if (c == '\r') continue;
      if (c == '\n') { Keys(new[] { 0x0D }, new[] { false }); }
      else if (c == '\t') { Keys(new[] { 0x09 }, new[] { false }); }
      else { Send(Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP)); }
      Thread.Sleep(8);
    }
    return null;
  }

  // The primary display with the pointer drawn in, scaled to width x height.
  public static string Shot(int width, int height, string format, long quality) {
    int w = Width(), h = Height();
    using (var full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) {
        g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        var info = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
        if (GetCursorInfo(ref info) && info.flags == 1) {
          ICONINFO icon;
          int hx = 0, hy = 0;
          if (GetIconInfo(info.hCursor, out icon)) {
            hx = icon.xHotspot; hy = icon.yHotspot;
            if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
            if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
          }
          IntPtr dc = g.GetHdc();
          try { DrawIconEx(dc, info.pt.X - hx, info.pt.Y - hy, info.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
          finally { g.ReleaseHdc(dc); }
        }
      }
      using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(scaled)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.DrawImage(full, 0, 0, width, height);
        }
        using (var stream = new MemoryStream()) {
          if (format == "jpeg") {
            ImageCodecInfo codec = null;
            foreach (var candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == "image/jpeg") codec = candidate;
            var options = new EncoderParameters(1);
            options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            scaled.Save(stream, codec, options);
          } else {
            scaled.Save(stream, ImageFormat.Png);
          }
          return Convert.ToBase64String(stream.ToArray());
        }
      }
    }
  }
}
'@

[BeeHost]::Init()
[BeeHost]::Guard = [string]$env:BEE_GUARD_EXE
$stdin = [Console]::In
$stdout = [Console]::Out
$stdout.WriteLine((@{ ready = $true; width = [BeeHost]::Width(); height = [BeeHost]::Height() } | ConvertTo-Json -Compress))
$stdout.Flush()

while ($null -ne ($line = $stdin.ReadLine())) {
  $answer = @{}
  try {
    $request = $line | ConvertFrom-Json
    $answer.id = $request.id
    $refusal = $null
    switch ($request.op) {
      'size' { $answer.width = [BeeHost]::Width(); $answer.height = [BeeHost]::Height() }
      'cursor' { $p = [BeeHost]::Cursor(); $answer.x = $p.X; $answer.y = $p.Y }
      'shot' {
        $answer.width = [BeeHost]::Width(); $answer.height = [BeeHost]::Height()
        $answer.data = [BeeHost]::Shot([int]$request.w, [int]$request.h, [string]$request.format, [long]$request.quality)
      }
      'move' {
        $refusal = [BeeHost]::Check([int]$request.at[0], [int]$request.at[1], $false, $false)
        if (-not $refusal) { [BeeHost]::Move([int]$request.x, [int]$request.y) }
      }
      'button' {
        $refusal = [BeeHost]::Check([int]$request.at[0], [int]$request.at[1], [bool]$request.down, $false)
        if (-not $refusal) { [BeeHost]::Button([int]$request.button, [bool]$request.down) }
      }
      'scroll' {
        $refusal = [BeeHost]::Check([int]$request.at[0], [int]$request.at[1], $true, $false)
        if (-not $refusal) { [BeeHost]::Scroll([string]$request.direction, [int]$request.amount) }
      }
      'keys' {
        $refusal = [BeeHost]::Check([int]$request.at[0], [int]$request.at[1], $false, $true)
        if (-not $refusal) { [BeeHost]::Keys([int[]]$request.vks, [bool[]]$request.extended) }
      }
      'type' {
        $refusal = [BeeHost]::Check([int]$request.at[0], [int]$request.at[1], $false, $true)
        if (-not $refusal) { $refusal = [BeeHost]::Type([string]$request.text) }
      }
      default { throw "unknown op" }
    }
    if ($refusal) { $answer.refused = $refusal } else { $answer.ok = $true }
  } catch {
    $answer.error = $_.Exception.Message
  }
  $stdout.WriteLine(($answer | ConvertTo-Json -Compress))
  $stdout.Flush()
}
`;
