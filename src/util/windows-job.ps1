$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class MHProcessJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IOCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IOCounters IO;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr job;
    static string Quote(string value) {
        var s = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            s.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            s.Append(c); slashes = 0;
        }
        return s.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Run(string executable, string[] args) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        int size = Marshal.SizeOf(limits); IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size)) throw new Win32Exception();
        } finally { Marshal.FreeHGlobal(buffer); }
        // Assign the helper before starting the shell, so even short-lived fork parents are covered.
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
        var quoted = new string[args.Length];
        for (int i=0; i<args.Length; i++) quoted[i] = Quote(args[i]);
        var start = new ProcessStartInfo(executable, String.Join(" ", quoted));
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.RedirectStandardInput = true;
        using (var child = Process.Start(start)) {
            child.StandardInput.Close();
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit(); System.Threading.Tasks.Task.WaitAll(output, error); return child.ExitCode;
        }
        // Keep the job handle alive until helper exit. OS handle cleanup kills remaining descendants.
    }
}
'@
$jobExecutable = $env:MH_JOB_EXECUTABLE
$jobArguments = [string[]](ConvertFrom-Json -InputObject $env:MH_JOB_ARGUMENTS)
Remove-Item Env:MH_JOB_EXECUTABLE, Env:MH_JOB_ARGUMENTS
$jobExitCode = [MHProcessJob]::Run($jobExecutable, $jobArguments)
exit $jobExitCode
