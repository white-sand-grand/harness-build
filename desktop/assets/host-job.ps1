$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DesktopHostJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long ProcessTime; public long JobTime; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Counters {
    public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations;
    public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Limits {
    public Basic Basic; public Counters Counters; public UIntPtr ProcessMemory;
    public UIntPtr JobMemory; public UIntPtr PeakProcessMemory; public UIntPtr PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Attach(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    try {
      var limits = new Limits(); limits.Basic.LimitFlags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
      IntPtr process = OpenProcess(0x101, false, pid);
      if (process == IntPtr.Zero) throw new Win32Exception();
      try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); }
      finally { CloseHandle(process); }
      return job;
    } catch { CloseHandle(job); throw; }
  }
}
'@
$desktopJobHandle = [DesktopHostJob]::Attach([int]$env:MH_DESKTOP_HOST_PID)
try {
  [Console]::Out.WriteLine('MH_JOB_READY')
  [Console]::Out.Flush()
  # EOF on this private pipe also handles an unexpected desktop-main crash.
  [Console]::In.ReadLine() | Out-Null
} finally {
  [void][DesktopHostJob]::CloseHandle($desktopJobHandle)
}
