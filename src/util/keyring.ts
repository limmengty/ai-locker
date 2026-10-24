import fs from 'node:fs';
import path from 'node:path';
import { run, resolveExecutable } from './exec.js';
import { LockerError } from './errors.js';

/**
 * OS credential-store access shared by providers whose logins live in the system keyring
 * rather than a file. Secrets are only ever passed to helper processes over stdin.
 */
export interface KeyringRef {
  service: string;
  account: string;
  /** Exact Windows Credential Manager target; defaults to `<account>.<service>` (keytar). */
  windowsTarget?: string;
  /** libsecret attributes; defaults to `service` + `username` (go-keyring). */
  linux?: Record<string, string>;
}

export interface KeyringItem extends KeyringRef {
  secret: Buffer;
  comment?: string;
  /** Windows persistence: 2 = local machine, 3 = enterprise. */
  persist?: number;
  label?: string;
}

export interface KeyringEntry extends KeyringRef {
  secret: Buffer;
  comment?: string;
  persist?: number;
}

export interface KeyringAvailability {
  ok: boolean;
  detail: string;
}

export interface KeyringBackend {
  readonly kind: string;
  available(): Promise<KeyringAvailability>;
  read(ref: KeyringRef): Promise<KeyringEntry | null>;
  write(item: KeyringItem): Promise<void>;
  delete(ref: KeyringRef): Promise<boolean>;
}

export function keyringBackend(platform: NodeJS.Platform = process.platform): KeyringBackend {
  if (platform === 'win32') return new WindowsKeyring();
  if (platform === 'darwin') return new MacKeyring();
  return new LinuxKeyring(platform);
}

function assertSafe(value: string, what: string): void {
  if (!value || /[\0\r\n]/.test(value)) {
    throw new LockerError(`Invalid keyring ${what}.`, 'E_KEYRING');
  }
}

function base64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function decode64(s: string | undefined): string {
  return s ? Buffer.from(s, 'base64').toString('utf8') : '';
}

function decodeError(backend: string, action: string, res: { stderr: string; stdout: string }): LockerError {
  const detail = (res.stderr || res.stdout).trim();
  return new LockerError(
    `Could not ${action} the ${backend} item.`,
    'E_KEYRING',
    detail ? detail.slice(0, 400) : undefined,
  );
}

const POWERSHELL_CS = `
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;

public class LockerCred
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);

    public static string ReadJson(string target)
    {
        IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p))
        {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return "{\\"found\\":false}";
            throw new Win32Exception(err);
        }
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            byte[] blob = new byte[c.CredentialBlobSize];
            if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);
            return "{\\"found\\":true,\\"user64\\":\\"" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(c.UserName ?? ""))
                + "\\",\\"comment64\\":\\"" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(c.Comment ?? ""))
                + "\\",\\"persist\\":" + c.Persist
                + ",\\"blob64\\":\\"" + Convert.ToBase64String(blob) + "\\"}";
        }
        finally
        {
            CredFree(p);
        }
    }

    public static int Write(string target, string userName, string comment, byte[] blob, uint persist)
    {
        IntPtr ptr = Marshal.AllocHGlobal(blob.Length == 0 ? 1 : blob.Length);
        try
        {
            if (blob.Length > 0) Marshal.Copy(blob, 0, ptr, blob.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1;
            c.TargetName = target;
            c.UserName = userName;
            c.Comment = comment ?? "";
            c.Persist = persist;
            c.CredentialBlobSize = (uint)blob.Length;
            c.CredentialBlob = ptr;
            if (!CredWrite(ref c, 0)) return Marshal.GetLastWin32Error();
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public static int Delete(string target)
    {
        if (CredDelete(target, 1, 0)) return 0;
        return Marshal.GetLastWin32Error();
    }
}
`;

class WindowsKeyring implements KeyringBackend {
  readonly kind = 'Windows Credential Manager';

  async available(): Promise<KeyringAvailability> {
    const ps = this.powershell();
    return fs.existsSync(ps) ? { ok: true, detail: ps } : { ok: false, detail: `PowerShell not found at ${ps}` };
  }

  async read(ref: KeyringRef): Promise<KeyringEntry | null> {
    const target = ref.windowsTarget ?? `${ref.account}.${ref.service}`;
    assertSafe(target, 'target');
    const script = this.script(`$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(target)}'))
[LockerCred]::ReadJson($target)`);
    const res = await this.exec(script, 'read');
    let data: { found?: boolean; user64?: string; comment64?: string; persist?: number; blob64?: string };
    try {
      data = JSON.parse(res.stdout.trim());
    } catch {
      throw new LockerError(`Unexpected output from ${this.kind}.`, 'E_KEYRING');
    }
    if (!data.found) return null;
    return {
      ...ref,
      secret: Buffer.from(data.blob64 ?? '', 'base64'),
      comment: decode64(data.comment64) || undefined,
      persist: data.persist,
    };
  }

  async write(item: KeyringItem): Promise<void> {
    const target = item.windowsTarget ?? `${item.account}.${item.service}`;
    assertSafe(target, 'target');
    assertSafe(item.account, 'account');
    const script = this.script(`$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(target)}'))
$user=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(item.account)}'))
$comment=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(item.comment ?? '')}'))
$blob=[Convert]::FromBase64String('${item.secret.toString('base64')}')
$err=[LockerCred]::Write($target,$user,$comment,$blob,[uint32]${item.persist ?? 2})
if ($err -ne 0) { throw "CredWrite failed with error $err" }
'{"ok":true}'`);
    await this.exec(script, 'write');
  }

  async delete(ref: KeyringRef): Promise<boolean> {
    const target = ref.windowsTarget ?? `${ref.account}.${ref.service}`;
    assertSafe(target, 'target');
    const script = this.script(`$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(target)}'))
$err=[LockerCred]::Delete($target)
if ($err -eq 1168) { '{"deleted":false}' } elseif ($err -ne 0) { throw "CredDelete failed with error $err" } else { '{"deleted":true}' }`);
    const res = await this.exec(script, 'delete');
    try {
      return Boolean(JSON.parse(res.stdout.trim()).deleted);
    } catch {
      throw new LockerError(
        `Unexpected output from ${this.kind}.`,
        'E_KEYRING',
        (res.stdout || res.stderr).trim().slice(0, 400) || undefined,
      );
    }
  }

  private powershell(): string {
    return path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  }

  private script(body: string): string {
    // `-Command -` executes stdin line by line, so no here-strings: they would swallow
    // everything after them. The static C# source travels as one base64 line instead.
    const cs = Buffer.from(POWERSHELL_CS, 'utf8').toString('base64');
    return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cs}')))
${body}
`;
  }

  private async exec(script: string, action: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const res = await run(this.powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: script,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) throw decodeError(this.kind, action, res);
    return res;
  }
}

class MacKeyring implements KeyringBackend {
  readonly kind = 'macOS Keychain';
  private static readonly SECURITY = '/usr/bin/security';
  private static readonly ITEM_NOT_FOUND = 44;
  /** `security -i` reads commands with a fixed-size line buffer; stay well under it. */
  private static readonly MAX_INTERACTIVE_LINE = 3800;

  async available(): Promise<KeyringAvailability> {
    const exists = fs.existsSync(MacKeyring.SECURITY);
    return { ok: exists, detail: exists ? MacKeyring.SECURITY : `${MacKeyring.SECURITY} not found` };
  }

  async read(ref: KeyringRef): Promise<KeyringEntry | null> {
    assertSafe(ref.service, 'service');
    assertSafe(ref.account, 'account');
    const res = await run(
      MacKeyring.SECURITY,
      ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'],
      { timeoutMs: 60_000 },
    );
    if (res.code === MacKeyring.ITEM_NOT_FOUND) return null;
    if (res.code !== 0) throw decodeError(this.kind, 'read', res);
    // `security` prints the password followed by a newline; no credential ends with one.
    return { ...ref, secret: Buffer.from(res.stdout.replace(/\n$/, ''), 'utf8') };
  }

  async write(item: KeyringItem): Promise<void> {
    assertSafe(item.service, 'service');
    assertSafe(item.account, 'account');
    const hex = item.secret.toString('hex');
    const line = `add-generic-password -U -s "${item.service}" -a "${item.account}" -X ${hex}\n`;
    const res =
      line.length <= MacKeyring.MAX_INTERACTIVE_LINE
        ? await run(MacKeyring.SECURITY, ['-i'], { input: line, timeoutMs: 60_000 })
        : await run(
            MacKeyring.SECURITY,
            ['add-generic-password', '-U', '-s', item.service, '-a', item.account, '-X', hex],
            { timeoutMs: 60_000 },
          );
    if (res.code !== 0 || /error/i.test(res.stderr)) throw decodeError(this.kind, 'write', res);
  }

  async delete(ref: KeyringRef): Promise<boolean> {
    assertSafe(ref.service, 'service');
    assertSafe(ref.account, 'account');
    const res = await run(
      MacKeyring.SECURITY,
      ['delete-generic-password', '-s', ref.service, '-a', ref.account],
      { timeoutMs: 30_000 },
    );
    if (res.code === MacKeyring.ITEM_NOT_FOUND) return false;
    if (res.code !== 0) throw decodeError(this.kind, 'delete', res);
    return true;
  }
}

class LinuxKeyring implements KeyringBackend {
  readonly kind: string;
  private readonly platform: NodeJS.Platform;
  private bin: string | null;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
    this.kind = 'libsecret';
    this.bin = resolveExecutable('secret-tool', process.env, platform);
  }

  async available(): Promise<KeyringAvailability> {
    if (!this.bin) this.bin = resolveExecutable('secret-tool', process.env, this.platform);
    return this.bin
      ? { ok: true, detail: this.bin }
      : { ok: false, detail: 'secret-tool not found; install libsecret-tools' };
  }

  async read(ref: KeyringRef): Promise<KeyringEntry | null> {
    const bin = await this.require();
    const res = await run(bin, ['lookup', ...this.attributes(ref)], { timeoutMs: 30_000 });
    if (res.code !== 0) {
      if (!res.stdout.trim() && !res.stderr.trim()) return null;
      throw decodeError(this.kind, 'read', res);
    }
    return { ...ref, secret: Buffer.from(res.stdout.replace(/\n$/, ''), 'utf8') };
  }

  async write(item: KeyringItem): Promise<void> {
    const bin = await this.require();
    const args = [
      'store',
      '--label',
      item.label ?? `${item.service} (${item.account})`,
      ...this.attributes(item),
    ];
    // secret-tool reads the secret from stdin, keeping it out of argv.
    const res = await run(bin, args, { input: item.secret.toString('utf8'), timeoutMs: 30_000 });
    if (res.code !== 0) throw decodeError(this.kind, 'write', res);
  }

  async delete(ref: KeyringRef): Promise<boolean> {
    const bin = await this.require();
    const res = await run(bin, ['clear', ...this.attributes(ref)], { timeoutMs: 30_000 });
    if (res.code !== 0) throw decodeError(this.kind, 'delete', res);
    return true;
  }

  private attributes(ref: KeyringRef): string[] {
    const attrs = ref.linux ?? { service: ref.service, username: ref.account };
    const out: string[] = [];
    for (const [key, value] of Object.entries(attrs)) {
      assertSafe(key, 'attribute');
      assertSafe(value, 'attribute');
      out.push(key, value);
    }
    return out;
  }

  private async require(): Promise<string> {
    if (!this.bin) this.bin = resolveExecutable('secret-tool', process.env, this.platform);
    if (!this.bin) {
      throw new LockerError('No libsecret credential store on this system.', 'E_KEYRING', 'Install libsecret-tools.');
    }
    return this.bin;
  }
}
