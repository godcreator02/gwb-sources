import { randomUUID } from "node:crypto";
import {
  SourceError,
  binding,
  object,
  parseSource,
  readSources,
  string,
  taskHints,
  type Adapter,
  type Source,
} from "./model.js";
import { FreshRss, type Subscription } from "./rss.js";
import { ImapMail } from "./mail.js";
import type { Credentials } from "./credentials.js";
type Settings = {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
};
type Rss = Omit<Adapter, "list"> & {
  list(): Promise<Subscription[]>;
  mutate(change: Change): Promise<void>;
};
type Change = {
  action: "add" | "unsubscribe";
  id?: string;
  title?: string;
  url?: string;
  category?: string;
};
type Plan = {
  source: Source;
  before: Subscription[];
  changes: Change[];
  expires: number;
};
export class Sources {
  private plans = new Map<string, Plan>();
  private busy = new Set<string>();
  private active = new Set<Adapter>();
  constructor(
    private settings: Settings,
    private vault: Credentials,
    private factory: (s: Source, p: string) => Adapter = (s, p) =>
      s.kind === "freshrss" ? new FreshRss(s, p) : new ImapMail(s, p),
  ) {}
  private all() {
    return readSources(this.settings.get("sources"));
  }
  private source(args: Record<string, unknown>) {
    const id = string(args["source"], "source", 48);
    const s = this.all().find((v) => v.id === id);
    if (!s) throw new SourceError("not-found", "来源不存在；先 configure。");
    return s;
  }
  private async use<T>(
    s: Source,
    fn: (adapter: Adapter) => Promise<T>,
  ): Promise<T> {
    const adapter = this.factory(s, await this.vault.read(s));
    this.active.add(adapter);
    try {
      return await fn(adapter);
    } finally {
      adapter.dispose?.();
      this.active.delete(adapter);
    }
  }
  status() {
    return {
      sources: this.all().map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        endpoint: s.endpoint,
        username: s.username,
        configured: this.vault.configured(s),
        credentialKey: this.vault.prepare(s),
        migrationRequired: s.credentialRef?.startsWith("gwb-sources/v1/") ?? false,
        connection: "not-checked",
        capabilities:
          s.kind === "imap"
            ? ["list", "query", "read", "tasks"]
            : ["list", "query", "read", "tasks", "preview", "execute"],
      })),
      credentials: "当前 home 的 credentials.json；命令只返回凭据状态。",
      monitoring: false,
    };
  }
  async configure(args: Record<string, unknown>) {
    if ("credentialRef" in args || "password" in args || "token" in args)
      throw new SourceError("invalid", "配置命令不接受凭据或引用。");
    const source = parseSource(args);
    const all = this.all();
    const old = all.find((s) => s.id === source.id);
    if (old?.credentialRef) {
      if (binding(old) !== binding(source))
        throw new SourceError("credential", "改地址或用户名之前先断开凭据。");
      source.credentialRef = old.credentialRef;
    }
    await this.settings.set(
      "sources",
      JSON.stringify([...all.filter((s) => s.id !== source.id), source]),
    );
    return { id: source.id, configured: this.vault.configured(source), credentialKey: this.vault.prepare(source) };
  }
  async connect(args: Record<string, unknown>) {
    if (Object.keys(args).some((key) => key !== "source" && key !== "migrateLegacy"))
      throw new SourceError("invalid", "connect 只接受 source 与 migrateLegacy；凭据用 credentials.import/copy 或设置界面配置。");
    if (args["migrateLegacy"] !== undefined && typeof args["migrateLegacy"] !== "boolean")
      throw new SourceError("invalid", "migrateLegacy 必须是布尔值。");
    const s = this.source(args);
    const ref = await this.vault.connect(s, args["migrateLegacy"] === true);
    const all = this.all();
    const current = all.find((v) => v.id === s.id);
    if (!current || binding(current) !== binding(s) || current.credentialRef !== s.credentialRef)
      throw new SourceError("stale", "配置已改变，取消关联。");
    current.credentialRef = ref;
    await this.settings.set("sources", JSON.stringify(all));
    return {
      source: s.id,
      stored: true,
      authenticated: false,
      note: "凭据已保存；请调用 diagnose 验证，不代表已连接。",
    };
  }
  async disconnect(args: Record<string, unknown>) {
    const s = this.source(args);
    await this.vault.forget(s);
    const all = this.all();
    const current = all.find((v) => v.id === s.id);
    if (current) delete current.credentialRef;
    await this.settings.set("sources", JSON.stringify(all));
    return {
      source: s.id,
      removed: true,
      note: "移除了当前 home 的凭据与关联；旧 Windows 条目和其他 home 保留，服务端授权未撤销。",
    };
  }
  async list(args: Record<string, unknown>) {
    return this.use(this.source(args), (adapter) => adapter.list());
  }
  async query(args: Record<string, unknown>) {
    return this.use(this.source(args), (adapter) => adapter.query(args));
  }
  async read(args: Record<string, unknown>) {
    return this.use(this.source(args), (adapter) => adapter.read(args));
  }
  async tasks(args: Record<string, unknown>) {
    return this.use(this.source(args), async (adapter) => {
      const result = await adapter.query({
        ...args,
        limit: Math.min(
          typeof args["limit"] === "number" ? args["limit"] : 10,
          10,
        ),
      });
      const items = [];
      for (const item of result.items)
        items.push(await adapter.read({ id: item.id }));
      return {
        candidates: taskHints(items),
        truncated: result.truncated,
        note: "最多读取 10 篇正文；候选不是最终待办结论。",
      };
    });
  }
  async preview(args: Record<string, unknown>) {
    const s = this.source(args);
    if (s.kind !== "freshrss")
      throw new SourceError("read-only", "邮件适配器不提供写入。");
    const before = await this.use(s, (adapter) => (adapter as Rss).list());
    const changes: Change[] = [];
    if (args["action"] === "unsubscribe") {
      if (
        !Array.isArray(args["feeds"]) ||
        !args["feeds"].length ||
        args["feeds"].length > 100
      )
        throw new SourceError(
          "invalid",
          "feeds 必须是 1–100 个精确 id/title 对象。",
        );
      for (const value of args["feeds"]) {
        const row = object(value);
        const id = string(row["id"], "id", 100);
        const title = string(row["title"], "title");
        if (!before.some((f) => f.id === id && f.title === title))
          throw new SourceError(
            "stale",
            "订阅 id/title 不匹配，整个预览取消。",
          );
        if (changes.some((c) => c.id === id))
          throw new SourceError("invalid", "重复 id。");
        changes.push({ action: "unsubscribe", id, title });
      }
    } else if (args["action"] === "add") {
      const raw = string(args["url"], "url");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new SourceError("invalid", "订阅地址无效。");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new SourceError("invalid", "订阅地址不能携带凭据。");
      if (before.some((f) => f.url === raw))
        throw new SourceError("duplicate", "已有同地址订阅。");
      changes.push({
        action: "add",
        url: raw,
        category:
          args["category"] === undefined
            ? undefined
            : string(args["category"], "category", 100),
      });
    } else
      throw new SourceError("invalid", "action 必须是 add 或 unsubscribe。");
    for (const [id, plan] of this.plans)
      if (plan.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 20)
      throw new SourceError("limit", "待执行预览过多，请等待十分钟过期。");
    const id = randomUUID();
    this.plans.set(id, {
      source: s,
      before,
      changes,
      expires: Date.now() + 600000,
    });
    return {
      plan: id,
      source: s.id,
      changes,
      before: before.length,
      expiresInSeconds: 600,
      confirm: `APPLY ${id}`,
      warning: "退订可能永久删除历史和收藏；执行前须用户明确授权。",
    };
  }
  async execute(args: Record<string, unknown>) {
    const id = string(args["plan"], "plan");
    const plan = this.plans.get(id);
    if (!plan || plan.expires < Date.now())
      throw new SourceError("stale", "预览不存在或已过期，重新预览。");
    if (args["confirm"] !== `APPLY ${id}`)
      throw new SourceError("consent", "confirm 必须与已审阅预览完全一致。");
    if (this.busy.has(plan.source.id))
      throw new SourceError("busy", "该来源正在执行变更。");
    const current = this.source({ source: plan.source.id });
    if (JSON.stringify(current) !== JSON.stringify(plan.source))
      throw new SourceError("stale", "来源配置已变，重新预览。");
    this.plans.delete(id);
    this.busy.add(current.id);
    const completed: Change[] = [];
    try {
      return await this.use(current, async (raw) => {
        const adapter = raw as Rss;
        const before = await adapter.list();
        const fingerprint = (rows: Subscription[]) =>
          JSON.stringify(
            rows
              .map((r) => [r.id, r.title, r.url])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );
        if (fingerprint(before) !== fingerprint(plan.before))
          throw new SourceError("stale", "订阅列表已改变，重新预览。");
        let failed = false;
        for (const change of plan.changes) {
          try {
            await adapter.mutate(change);
            completed.push(change);
          } catch {
            failed = true;
            break;
          }
        }
        const after = await adapter.list();
        const afterIds = new Set(after.map((s) => s.id));
        const targeted = new Set(
          plan.changes
            .filter((c) => c.action === "unsubscribe")
            .map((c) => c.id),
        );
        return {
          completed,
          failed,
          total: after.length,
          remaining: plan.changes.filter(
            (c) => c.action === "unsubscribe" && afterIds.has(c.id ?? ""),
          ),
          added: plan.changes
            .filter((c) => c.action === "add")
            .map((c) => ({
              url: c.url,
              verified: after.some((s) => s.url === c.url),
            })),
          unexpectedMissing: before
            .filter((s) => !targeted.has(s.id) && !afterIds.has(s.id))
            .map((s) => s.id),
          note: failed
            ? "服务器调用失败，已停止；先核对实际列表，勿盲目重试。"
            : "已重新读取订阅列表核验。",
        };
      });
    } finally {
      this.busy.delete(current.id);
    }
  }
  dispose() {
    this.plans.clear();
    for (const adapter of this.active) adapter.dispose?.();
    this.active.clear();
  }
}
