param(
  [string]$Target = 'gemini:antigravity'
)

# 从 Windows 凭据管理器读取 agy(Antigravity CLI) 的 OAuth 凭据。
# 输出单行 JSON 到 stdout；失败时 ok=false 且退出码非 0。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class AgyCredApi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@

$ptr = [IntPtr]::Zero
if (-not [AgyCredApi]::CredRead($Target, 1, 0, [ref]$ptr)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "CredRead('$Target') failed: $([ComponentModel.Win32Exception]::new($code).Message)"
}

try {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][AgyCredApi+CREDENTIAL])
  $blob = New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
} finally {
  [AgyCredApi]::CredFree($ptr)
}

$raw = [Text.Encoding]::UTF8.GetString($blob)
$outer = $raw | ConvertFrom-Json
$token = $outer.token
if ($token -is [string]) { $token = $token | ConvertFrom-Json }

[ordered]@{
  ok          = $true
  source      = 'windows-credential-manager'
  target      = $Target
  userName    = $cred.UserName
  email       = $outer.id_token_email
  authMethod  = $outer.auth_method
  accessToken = $token.access_token
  tokenType   = $token.token_type
  refreshToken= $token.refresh_token
  expiry      = $token.expiry
  expiresIn   = $token.expires_in
} | ConvertTo-Json -Compress
