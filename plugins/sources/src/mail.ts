import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  SourceError,
  integer,
  string,
  type Adapter,
  type Item,
  type Source,
} from "./model.js";

// Narrow transport seam: tests use an in-memory IMAP session; production always uses TLS.
export type MailSession = Pick<
  ImapFlow,
  | "on"
  | "connect"
  | "logout"
  | "close"
  | "list"
  | "mailboxOpen"
  | "search"
  | "fetchAll"
  | "fetchOne"
>;
export class ImapMail implements Adapter {
  private sessions = new Set<MailSession>();
  dispose(): void {
    for (const c of this.sessions) c.close();
    this.sessions.clear();
    this.password = "";
  }
  constructor(
    private source: Source,
    private password: string,
    private factory: (
      options: ConstructorParameters<typeof ImapFlow>[0],
    ) => MailSession = (options) => new ImapFlow(options),
  ) {}
  private async session<T>(fn: (c: MailSession) => Promise<T>): Promise<T> {
    const u = new URL(this.source.endpoint);
    const c = this.factory({
      host: u.hostname,
      port: Number(u.port || 993),
      secure: true,
      tls: { rejectUnauthorized: true },
      auth: { user: this.source.username, pass: this.password },
      logger: false,
      logRaw: false,
      disableAutoIdle: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    // Consume transport error events so a disconnected server cannot crash gwb.
    // Closing rejects pending operations; the command boundary sanitizes their errors.
    c.on("error", () => c.close());
    this.sessions.add(c);
    try {
      await c.connect();
      return await fn(c);
    } finally {
      try {
        await c.logout();
      } catch {
        c.close();
      }
      this.sessions.delete(c);
    }
  }
  async list() {
    return this.session(async (c) =>
      (await c.list()).map((m) => ({
        path: m.path,
        name: m.name,
        specialUse: m.specialUse,
      })),
    );
  }
  private async open(c: MailSession, args: Record<string, unknown>) {
    const mailbox =
      args["mailbox"] === undefined
        ? (this.source.mailbox ?? "INBOX")
        : string(args["mailbox"], "mailbox", 256);
    const box = await c.mailboxOpen(mailbox, { readOnly: true });
    return { mailbox, validity: String(box.uidValidity) };
  }
  async query(args: Record<string, unknown>) {
    const days = integer(args["days"], 7, 1, 365);
    const limit = integer(args["limit"], 30, 1, 100);
    return this.session(async (c) => {
      const { mailbox, validity } = await this.open(c, args);
      const text =
        args["text"] === undefined
          ? undefined
          : string(args["text"], "text", 200);
      const found = await c.search(
        {
          since: new Date(Date.now() - days * 86400000),
          ...(text ? { text } : {}),
        },
        { uid: true },
      );
      const uids = found || [];
      const selected = uids.slice(-limit).reverse();
      if (!selected.length) return { items: [], truncated: false };
      const rows = await c.fetchAll(
        selected,
        { uid: true, envelope: true, flags: true, internalDate: true },
        { uid: true },
      );
      const items: Item[] = rows.map((row) => ({
        id: JSON.stringify([mailbox, validity, row.uid]),
        source: this.source.id,
        title: row.envelope?.subject ?? "",
        date:
          row.internalDate instanceof Date
            ? row.internalDate.toISOString()
            : undefined,
        from: row.envelope?.from
          ?.map((a) => a.address ?? a.name ?? "")
          .join(", "),
        unread: !row.flags?.has("\\Seen"),
      }));
      return { items: items.reverse(), truncated: uids.length > limit };
    });
  }
  async read(args: Record<string, unknown>): Promise<Item> {
    let id: unknown;
    try {
      id = JSON.parse(string(args["id"], "id", 600)) as unknown;
    } catch {
      throw new SourceError("invalid", "请使用 query 返回的完整邮件 id。");
    }
    if (
      !Array.isArray(id) ||
      id.length !== 3 ||
      typeof id[0] !== "string" ||
      typeof id[1] !== "string" ||
      typeof id[2] !== "number" ||
      !Number.isInteger(id[2]) ||
      id[2] < 1
    )
      throw new SourceError("invalid", "邮件 id 无效。");
    const [mailbox, validity, uid] = id as [string, string, number];
    return this.session(async (c) => {
      const opened = await this.open(c, { mailbox });
      if (opened.validity !== validity)
        throw new SourceError("stale", "邮箱 UIDVALIDITY 改变，请重新查询。");
      const meta = await c.fetchOne(
        uid,
        { uid: true, size: true },
        { uid: true },
      );
      if (!meta) throw new SourceError("not-found", "邮件不存在。");
      if ((meta.size ?? 0) > 2 * 1024 * 1024)
        throw new SourceError(
          "limit",
          "邮件超过 2 MiB；请在邮箱中阅读，插件不下载大附件。",
        );
      // ImapFlow source fetch uses BODY.PEEK[]; mailbox is EXAMINE/readOnly as a second guard.
      const row = await c.fetchOne(
        uid,
        { uid: true, source: true, envelope: true, flags: true },
        { uid: true },
      );
      if (!row || !row.source)
        throw new SourceError("not-found", "邮件正文不可读。");
      if (row.source.length > 2 * 1024 * 1024)
        throw new SourceError("limit", "邮件正文超过上限。");
      const parsed = await simpleParser(row.source, {
        skipHtmlToText: false,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
      return {
        id: JSON.stringify([mailbox, validity, uid]),
        source: this.source.id,
        title: parsed.subject ?? "",
        date: parsed.date?.toISOString(),
        from: parsed.from?.text,
        unread: !row.flags?.has("\\Seen"),
        text: (parsed.text ?? "").slice(0, 16000),
      };
    });
  }
}
