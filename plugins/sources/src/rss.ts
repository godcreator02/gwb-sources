import {
  SourceError,
  integer,
  object,
  record,
  string,
  type Adapter,
  type Item,
  type Source,
} from "./model.js";
export type Subscription = {
  id: string;
  title: string;
  url?: string;
  categories: string[];
};
type Fetch = typeof fetch;
export class FreshRss implements Adapter {
  private auth = "";
  private controller = new AbortController();
  dispose(): void {
    this.controller.abort();
    this.auth = "";
    this.password = "";
  }
  constructor(
    private source: Source,
    private password: string,
    private transport: Fetch = fetch,
  ) {}
  private async request(
    path: string,
    data?: Record<string, string>,
  ): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.auth) headers["Authorization"] = `GoogleLogin auth=${this.auth}`;
    if (data) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await this.transport(
      `${this.source.endpoint}/api/greader.php/${path}`,
      {
        method: data ? "POST" : "GET",
        headers,
        body: data ? new URLSearchParams(data).toString() : undefined,
        redirect: "error",
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(20000),
        ]),
      },
    );
    if (!response.ok)
      throw new SourceError(
        response.status === 401 || response.status === 403
          ? "auth"
          : "upstream",
        `FreshRSS HTTP ${response.status}，不输出错误正文。`,
      );
    // Bound decompressed response bytes, including chunked responses.
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new SourceError("limit", "回包超过 4 MiB，请缩小范围。");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  private async login(): Promise<void> {
    if (this.auth) return;
    const response = await this.request("accounts/ClientLogin", {
      Email: this.source.username,
      Passwd: this.password,
    });
    this.auth =
      response
        .split(/\r?\n/)
        .find((line) => line.startsWith("Auth="))
        ?.slice(5) ?? "";
    this.password = "";
    if (!this.auth || /\s/.test(this.auth))
      throw new SourceError("auth", "FreshRSS 没有返回有效授权。");
  }
  async list(): Promise<Subscription[]> {
    await this.login();
    const data = object(
      JSON.parse(
        await this.request("reader/api/0/subscription/list?output=json"),
      ) as unknown,
    );
    if (!Array.isArray(data["subscriptions"]))
      throw new SourceError("protocol", "订阅列表格式无效。");
    return data["subscriptions"].map((value) => {
      const row = object(value);
      return {
        id: string(row["id"], "id"),
        title: string(row["title"], "title"),
        url: typeof row["url"] === "string" ? row["url"] : undefined,
        categories: Array.isArray(row["categories"])
          ? row["categories"]
              .filter(record)
              .map((c) => String(c["label"] ?? ""))
          : [],
      };
    });
  }
  private item(value: unknown, full = false): Item {
    const row = object(value);
    const origin = record(row["origin"]) ? row["origin"] : {};
    const summary = record(row["summary"]) ? row["summary"] : {};
    const links = Array.isArray(row["alternate"])
      ? row["alternate"].filter(record)
      : [];
    const published =
      typeof row["published"] === "number"
        ? new Date(row["published"] * 1000).toISOString()
        : undefined;
    return {
      id: string(row["id"], "item id"),
      source: this.source.id,
      title: String(row["title"] ?? ""),
      date: published,
      url:
        typeof links[0]?.["href"] === "string" ? links[0]["href"] : undefined,
      from: typeof origin["title"] === "string" ? origin["title"] : undefined,
      unread: Array.isArray(row["categories"])
        ? !row["categories"].some(
            (v) =>
              typeof v === "string" && v.endsWith("/state/com.google/read"),
          )
        : undefined,
      ...(full
        ? { text: String(summary["content"] ?? "").slice(0, 16000) }
        : {}),
    };
  }
  async query(args: Record<string, unknown>) {
    await this.login();
    const days = integer(args["days"], 7, 1, 365);
    const limit = integer(args["limit"], 30, 1, 100);
    const q = new URLSearchParams({
      output: "json",
      n: String(limit),
      ot: String(Math.floor(Date.now() / 1000) - days * 86400),
    });
    if (args["continuation"] !== undefined)
      q.set("c", string(args["continuation"], "continuation", 1024));
    const stream =
      args["feed"] === undefined
        ? "user/-/state/com.google/reading-list"
        : string(args["feed"], "feed", 100);
    if (args["feed"] !== undefined && !/^feed\/\d+$/.test(stream))
      throw new SourceError("invalid", "feed 必须是列表返回的 feed/数字。");
    const data = object(
      JSON.parse(
        await this.request(
          `reader/api/0/stream/contents/${encodeURIComponent(stream)}?${q}`,
        ),
      ) as unknown,
    );
    const items = Array.isArray(data["items"])
      ? data["items"].map((i) => this.item(i))
      : [];
    const continuation =
      typeof data["continuation"] === "string"
        ? data["continuation"]
        : undefined;
    return { items, continuation, truncated: Boolean(continuation) };
  }
  async read(args: Record<string, unknown>): Promise<Item> {
    await this.login();
    const id = string(args["id"], "id", 160);
    const q = new URLSearchParams({ output: "json", i: id });
    const data = object(
      JSON.parse(
        await this.request(`reader/api/0/stream/items/contents?${q}`),
      ) as unknown,
    );
    if (!Array.isArray(data["items"]) || data["items"].length !== 1)
      throw new SourceError("not-found", "文章不存在或不可读。");
    return this.item(data["items"][0], true);
  }
  async mutate(change: {
    action: "add" | "unsubscribe";
    id?: string;
    url?: string;
    category?: string;
  }): Promise<void> {
    await this.login();
    const token = await this.request("reader/api/0/token");
    const data: Record<string, string> = {
      T: token,
      ac: change.action === "add" ? "subscribe" : "unsubscribe",
      s:
        change.action === "add"
          ? `feed/${change.url ?? ""}`
          : (change.id ?? ""),
    };
    if (change.category) data["a"] = `user/-/label/${change.category}`;
    if (
      (await this.request("reader/api/0/subscription/edit", data)).trim() !==
      "OK"
    )
      throw new SourceError(
        "protocol",
        "服务器未确认操作；先重新列订阅，不自动重试。",
      );
  }
}
