export type Source = {
  id: string;
  label: string;
  kind: "freshrss" | "imap";
  endpoint: string;
  username: string;
  credentialRef?: string;
  mailbox?: string;
};
export type Item = {
  id: string;
  source: string;
  title: string;
  date?: string;
  url?: string;
  from?: string;
  unread?: boolean;
  text?: string;
};
export class SourceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new SourceError("invalid", "参数必须是对象。");
  return value;
}
export function string(value: unknown, key: string, max = 2048): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new SourceError("invalid", `${key} 必须是非空字符串。`);
  return value;
}
export function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new SourceError("invalid", `整数范围 ${min}–${max}。`);
  return value;
}
export function endpoint(kind: Source["kind"], raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("invalid", "地址不是有效 URL。");
  }
  if (u.username || u.password || u.search || u.hash)
    throw new SourceError("invalid", "地址不能含凭据、查询或片段。");
  if (kind === "freshrss") {
    if (u.protocol !== "https:")
      throw new SourceError("invalid", "FreshRSS 必须使用 HTTPS。");
    return u.href.replace(/\/+$/, "");
  }
  if (u.protocol !== "imaps:" || (u.pathname !== "" && u.pathname !== "/"))
    throw new SourceError("invalid", "邮箱地址格式为 imaps://已核实主机:993。");
  return `imaps://${u.hostname.toLowerCase()}:${u.port || "993"}`;
}
export function parseSource(value: unknown): Source {
  const v = object(value);
  const id = string(v["id"], "id", 48);
  if (!/^[a-z][a-z0-9-]*$/.test(id))
    throw new SourceError("invalid", "id 用小写字母、数字、连字符。");
  const kind = v["kind"];
  if (kind !== "freshrss" && kind !== "imap")
    throw new SourceError("invalid", "kind 必须是 freshrss 或 imap。");
  const result: Source = {
    id,
    kind,
    label: string(v["label"], "label", 100),
    endpoint: endpoint(kind, string(v["endpoint"], "endpoint")),
    username: string(v["username"], "username", 256),
  };
  if (v["mailbox"] !== undefined)
    result.mailbox = string(v["mailbox"], "mailbox", 256);
  if (v["credentialRef"] !== undefined) {
    const ref = string(v["credentialRef"], "credentialRef");
    if (!/^gwb-sources\/v1\/[a-f0-9-]{36}$/.test(ref) && !/^gwb-sources\/v2\/source-[a-z][a-z0-9-]*-[a-f0-9]{20}$/.test(ref))
      throw new SourceError("invalid", "凭据引用不属于此插件。");
    result.credentialRef = ref;
  }
  return result;
}
export function readSources(raw: unknown): Source[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string")
    throw new SourceError("config", "sources 配置必须是 JSON 字符串。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SourceError("config", "sources 配置 JSON 无效。");
  }
  if (!Array.isArray(parsed) || parsed.length > 50)
    throw new SourceError("config", "最多配置 50 个来源。");
  const sources = parsed.map(parseSource);
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    throw new SourceError("config", "来源 id 重复。");
  return sources;
}
export function binding(s: Source): string {
  return JSON.stringify([s.kind, s.endpoint, s.username]);
}
export function safeError(error: unknown): {
  ok: false;
  error: string;
  reason: string;
} {
  return error instanceof SourceError
    ? { ok: false, error: error.message, reason: error.code }
    : {
        ok: false,
        error:
          "来源请求失败；请检查网络、TLS 证书和授权。底层回包与异常不输出，避免泄露凭据。",
        reason: "connection",
      };
}
export function taskHints(items: Item[]) {
  return items.flatMap((item) => {
    const lines = `${item.title}\n${item.text ?? ""}`
      .split(/\n|(?<=[.!?。！？])\s+/)
      .filter((line) =>
        /截止|请.*回复|需要.*回复|变更|延期|deadline|please.*reply|action required|due (?:by|on)|revision/i.test(
          line,
        ),
      )
      .slice(0, 5);
    return lines.length
      ? [
          {
            id: item.id,
            source: item.source,
            title: item.title,
            evidence: lines.map((l) => l.slice(0, 400)),
            note: "关键词候选，需结合原文确认；不推断截止时区或已完成状态。",
          },
        ]
      : [];
  });
}
export interface Adapter {
  dispose?(): void;
  list(): Promise<unknown>;
  query(
    args: Record<string, unknown>,
  ): Promise<{ items: Item[]; continuation?: string; truncated: boolean }>;
  read(args: Record<string, unknown>): Promise<Item>;
}
