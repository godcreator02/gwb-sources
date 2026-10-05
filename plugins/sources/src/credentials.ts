import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { GwbSettingsApi } from "@godcreator/gwb-settings";
import { SourceError, binding, object, string, type Source } from "./model.js";
export interface Credentials {
  prepare(source: Source): string;
  configured(source: Source): boolean;
  read(source: Source): Promise<string>;
  connect(source: Source, migrateLegacy: boolean): Promise<string>;
  forget(source: Source): Promise<void>;
}
/** Key names encode the destination binding. A changed endpoint cannot reuse a password. */
export function credentialKey(source: Source): string {
  const hash = createHash("sha256").update(binding(source)).digest("hex").slice(0, 20);
  return `source-${source.id}-${hash}`;
}
export function credentialRef(source: Source): string {
  return `gwb-sources/v2/${credentialKey(source)}`;
}
export class HomeCredentials implements Credentials {
  private declared = new Set<string>();
  constructor(
    private settings: Pick<GwbSettingsApi, "define" | "get" | "set" | "delete">,
    private legacy: Pick<WindowsCredentials, "read">,
  ) {}
  prepare(source: Source): string {
    const key = credentialKey(source);
    if (!this.declared.has(key)) {
      this.settings.define({ key, type: "secret",
        title: `${source.label} 凭据`, description: "当前 home 独立保存；仅用于已绑定的来源地址与用户名。" });
      this.settings.define({ key: `${key}-legacy-migrated`, type: "boolean", default: false,
        title: `${source.label} 旧凭据已迁移`, description: "迁移标记；清除凭据后不从旧系统条目自动恢复。" });
      this.declared.add(key);
    }
    return key;
  }
  configured(source: Source): boolean {
    return source.credentialRef === credentialRef(source) && typeof this.settings.get(this.prepare(source)) === "string" && this.settings.get(credentialKey(source)) !== "";
  }
  async read(source: Source): Promise<string> {
    if (source.credentialRef !== credentialRef(source))
      throw new SourceError("not-connected", "来源尚未关联当前 home 凭据；旧 Windows 引用需 sources.connect migrateLegacy:true 显式迁移。");
    return string(this.settings.get(this.prepare(source)), "credential", 1024);
  }
  async connect(source: Source, migrateLegacy: boolean): Promise<string> {
    const key = this.prepare(source);
    if (migrateLegacy) {
      if (!source.credentialRef?.startsWith("gwb-sources/v1/"))
        throw new SourceError("credential", "此来源没有旧 Windows 凭据引用。");
      if (this.settings.get(`${key}-legacy-migrated`) === true)
        throw new SourceError("credential", "旧凭据已迁移；清除后的值请通过 credentials.import/copy 重新配置。");
      if (this.settings.get(key) === undefined || this.settings.get(key) === "")
        await this.settings.set(key, await this.legacy.read(source));
      await this.settings.set(`${key}-legacy-migrated`, true);
    }
    string(this.settings.get(key), "credential", 1024);
    return credentialRef(source);
  }
  async forget(source: Source): Promise<void> {
    const key = this.prepare(source);
    // Mark first: a failed delete can be retried without importing a legacy value again.
    await this.settings.set(`${key}-legacy-migrated`, true);
    await this.settings.delete(key);
  }
}
/** Read-only bridge retained solely for explicit migration of legacy references. */
export class WindowsCredentials {
  private children = new Set<ReturnType<typeof spawn>>();
  private async call(
    source: Source,
    target: string,
  ): Promise<unknown> {
    if (process.platform !== "win32")
      throw new SourceError("platform", "此版凭据管理器仅支持 Windows。");
    if (!/^gwb-sources\/v1\/[a-f0-9-]{36}$/.test(target))
      throw new SourceError("credential", "凭据引用无效。");
    const script = fileURLToPath(
      new URL("../native/credential.ps1", import.meta.url),
    );
    return new Promise((resolve, reject) => {
      const child = spawn(
        "pwsh.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.children.add(child);
      let output = "";
      const timer = setTimeout(
        () => {
          child.kill();
          reject(new SourceError("credential", "凭据操作超时。"));
        },
        15000,
      );
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (output.length > 16384) {
          child.kill();
          reject(new SourceError("credential", "凭据回执异常。"));
        }
      });
      child.stderr.resume(); // Never log native errors or payloads.
      child.on("error", () => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(new SourceError("credential", "无法启动 Windows 凭据桥。"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (code !== 0) {
          reject(
            new SourceError("credential", "凭据操作取消或失败；未输出秘密。"),
          );
          return;
        }
        try {
          resolve(JSON.parse(output) as unknown);
        } catch {
          reject(new SourceError("credential", "凭据回执无效。"));
        }
      });
      child.stdin.end(
        JSON.stringify({
          operation: "read",
          target,
          binding: binding(source),
          username: source.username,
          label: source.label,
          endpoint: source.endpoint,
        }),
      );
    });
  }
  async read(source: Source): Promise<string> {
    if (!source.credentialRef)
      throw new SourceError(
        "not-connected",
        "来源尚未连接；需用户本地授权凭据保存。",
      );
    const result = object(
      await this.call(source, source.credentialRef),
    );
    if (result["binding"] !== binding(source))
      throw new SourceError(
        "credential",
        "地址或用户名与凭据绑定不符，不发送凭据。",
      );
    return string(result["password"], "credential", 1024);
  }
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.kill();
          }),
      ),
    );
    this.children.clear();
  }
}
