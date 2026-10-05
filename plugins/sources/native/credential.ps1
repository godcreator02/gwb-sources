$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.target -notmatch '^gwb-sources/v1/[a-f0-9-]{36}$') { throw 'Invalid target' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GwbSourcesVault {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags; public uint Type;
    public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
  switch ($request.operation) {
    'read' {
      $ptr=[IntPtr]::Zero
      if (-not [GwbSourcesVault]::Read($request.target,1,0,[ref]$ptr)) { throw 'Missing credential' }
      try {
        $cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][GwbSourcesVault+Credential])
        $bytes=New-Object byte[] $cred.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$bytes.Length)
        $payload=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        if ($payload.binding -cne $request.binding) { throw 'Binding mismatch' }
        [Console]::Write(($payload | ConvertTo-Json -Compress))
        [Array]::Clear($bytes,0,$bytes.Length)
      } finally { [GwbSourcesVault]::CredFree($ptr) }
    }
    default { throw 'Invalid operation' }
  }
} catch { [Console]::Error.Write('Windows credential operation failed.'); exit 1 }
