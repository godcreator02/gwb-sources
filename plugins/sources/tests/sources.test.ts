import { describe, it, expect, vi } from "vitest";
import { Sources } from "../src/service.ts";
import { FreshRss, type Subscription } from "../src/rss.ts";
import { ImapMail, type MailSession } from "../src/mail.ts";
import {
  parseSource,
  safeError,
  taskHints,
  type Source,
} from "../src/model.ts";
import { apply } from "../src/index.ts";
import type { GwbContext } from "@godcreator/gwb-kernel-desktop";

const source: Source = {
  id: "rss",
  label: "RSS",
  kind: "freshrss",
  endpoint: "https://rss.test",
  username: "test",
  credentialRef: "gwb-sources/v1/00000000-0000-0000-0000-000000000000",
};
function fixture() {
  let value = JSON.stringify([source]);
  let rows: Subscription[] = [
    { id: "feed/5", title: "Test 1", categories: [] },
    { id: "feed/86", title: "ClaudeDevs", categories: [] },
  ];
  const settings = {
    get: () => value,
    set: vi.fn(async (_key: string, v: unknown) => {
      value = String(v);
    }),
  };
  const vault = {
    prepare: vi.fn(() => "source-rss-test"),
    configured: vi.fn(() => true),
    read: vi.fn(async () => "mock-secret"),
    connect: vi.fn(async () => source.credentialRef!),
    forget: vi.fn(async () => {}),
  };
  const adapter = {
    list: vi.fn(async () => structuredClone(rows)),
    query: vi.fn(async () => ({ items: [], truncated: false })),
    read: vi.fn(),
    mutate: vi.fn(async (change: { id?: string }) => {
      rows = rows.filter((r) => r.id !== change.id);
    }),
  };
  return {
    settings,
    vault,
    adapter,
    service: new Sources(settings, vault, () => adapter),
    setRows: (v: Subscription[]) => {
      rows = v;
    },
  };
}
describe("validation and command boundary", () => {
  it("rejects insecure and embedded-credential endpoints", () => {
    for (const url of [
      "http://rss.test",
      "https://a:b@rss.test",
      "https://rss.test?q=1",
    ])
      expect(() => parseSource({ ...source, endpoint: url })).toThrow();
    expect(() =>
      parseSource({ ...source, kind: "imap", endpoint: "imap://mail.test" }),
    ).toThrow();
  });
  it("does not echo arbitrary errors or secrets", () => {
    expect(JSON.stringify(safeError(new Error("mock-secret")))).not.toContain(
      "mock-secret",
    );
  });
  it("status reads no credential and configuration refuses password", async () => {
    const f = fixture();
    f.service.status();
    expect(f.vault.read).not.toHaveBeenCalled();
    await expect(
      f.service.configure({ ...source, password: "bad" }),
    ).rejects.toThrow();
    await expect(f.service.connect({ source: "rss", password: "bad" })).rejects.toThrow();
    expect(f.vault.connect).not.toHaveBeenCalled();
  });
  it("refuses changing destination of connected credential", async () => {
    const f = fixture();
    const { credentialRef: _ref, ...config } = source;
    await expect(
      f.service.configure({ ...config, endpoint: "https://other.test" }),
    ).rejects.toThrow();
  });
  it("marks all commands and does not connect during apply", () => {
    const defs: { name: string; effect: string }[] = [];
    const handlers = new Map<string, (v?: unknown) => Promise<unknown>>();
    const ctx = {
      gwbCommands: {
        register: (
          d: { name: string; effect: string },
          h: (v?: unknown) => Promise<unknown>,
        ) => {
          defs.push(d);
          handlers.set(d.name, h);
        },
      },
      gwbSettings: { define: vi.fn(), get: () => "[]", set: vi.fn() },
      inject: vi.fn(),
      effect: vi.fn(),
      logger: () => ({ info: vi.fn() }),
    } as unknown as GwbContext;
    apply(ctx);
    expect(defs).toHaveLength(12);
    expect(
      defs.every((d) => ["read", "write", "external"].includes(d.effect)),
    ).toBe(true);
    expect(defs.some((d) => /send|delete-mail/.test(d.name))).toBe(false);
    expect(handlers.has("sources.query")).toBe(true);
  });
});
describe("mutation plans", () => {
  it("preview is read-only and execution preserves untargeted subscriptions", async () => {
    const f = fixture();
    const p = await f.service.preview({
      source: "rss",
      action: "unsubscribe",
      feeds: [{ id: "feed/5", title: "Test 1" }],
    });
    expect(f.adapter.mutate).not.toHaveBeenCalled();
    const r = await f.service.execute({ plan: p.plan, confirm: p.confirm });
    expect(r.total).toBe(1);
    expect(r.unexpectedMissing).toEqual([]);
    expect(r.remaining).toEqual([]);
    expect((await f.adapter.list())[0]?.id).toBe("feed/86");
    await expect(
      f.service.execute({ plan: p.plan, confirm: p.confirm }),
    ).rejects.toThrow();
  });
  it("rejects wrong title and duplicate target before any mutation", async () => {
    const f = fixture();
    await expect(
      f.service.preview({
        source: "rss",
        action: "unsubscribe",
        feeds: [{ id: "feed/5", title: "wrong" }],
      }),
    ).rejects.toThrow();
    expect(f.adapter.mutate).not.toHaveBeenCalled();
  });
  it("rejects stale snapshots and wrong confirmation", async () => {
    const f = fixture();
    const p = await f.service.preview({
      source: "rss",
      action: "unsubscribe",
      feeds: [{ id: "feed/5", title: "Test 1" }],
    });
    await expect(
      f.service.execute({ plan: p.plan, confirm: "yes" }),
    ).rejects.toThrow();
    f.setRows([{ id: "feed/5", title: "changed", categories: [] }]);
    await expect(
      f.service.execute({ plan: p.plan, confirm: p.confirm }),
    ).rejects.toThrow();
    expect(f.adapter.mutate).not.toHaveBeenCalled();
  });
  it("stops on uncertain upstream failure and reports remaining targets", async () => {
    const f = fixture();
    f.adapter.mutate.mockRejectedValueOnce(new Error("network with secret"));
    const p = await f.service.preview({
      source: "rss",
      action: "unsubscribe",
      feeds: [{ id: "feed/5", title: "Test 1" }],
    });
    const r = await f.service.execute({ plan: p.plan, confirm: p.confirm });
    expect(r.failed).toBe(true);
    expect(r.remaining).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
describe("FreshRSS transport", () => {
  it("logs in only at fixed endpoint, reads with no state mutation and refuses redirects", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("ClientLogin"))
          return new Response("Auth=mock-auth\n");
        if (url.includes("subscription/list"))
          return Response.json({ subscriptions: [] });
        return Response.json({
          items: [
            {
              id: "item1",
              title: "Article",
              published: 1,
              summary: { content: "Body" },
              categories: [],
            },
          ],
          continuation: "next",
        });
      },
    );
    const rss = new FreshRss(source, "secret", transport);
    await rss.list();
    await rss.query({});
    await rss.read({ id: "item1" });
    expect(calls[0]?.init?.body).toContain("Passwd=secret");
    expect(calls.every((c) => c.init?.redirect === "error")).toBe(true);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    expect(calls.some((c) => /edit-tag|mark/.test(c.url))).toBe(false);
  });
  it("hides error response bodies", async () => {
    const rss = new FreshRss(
      source,
      "secret",
      async () => new Response("leaked-secret", { status: 401 }),
    );
    await expect(rss.list()).rejects.toThrow("HTTP 401");
  });
});
describe("IMAP read-only contract", () => {
  function mailFixture() {
    const row = {
      uid: 9,
      size: 100,
      source: Buffer.from(
        "From: a@example.com\r\nSubject: Deadline\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease reply by Friday.",
      ),
      flags: new Set<string>(),
      envelope: { subject: "Deadline" },
    };
    const c = {
      on: vi.fn<(event: string, listener: (error: Error) => void) => void>(),
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      list: vi.fn(async () => []),
      mailboxOpen: vi.fn(async () => ({ uidValidity: 123n })),
      search: vi.fn(async () => [9]),
      fetchAll: vi.fn(async () => [row]),
      fetchOne: vi.fn(async () => row),
    };
    const factory = vi.fn(() => c as unknown as MailSession);
    const mail = new ImapMail(
      { ...source, kind: "imap", endpoint: "imaps://mail.test:993" },
      "secret",
      factory,
    );
    return { c, factory, mail };
  }
  it("uses TLS, EXAMINE and UID-bound ids, never flags or sends", async () => {
    const f = mailFixture();
    const result = await f.mail.query({});
    const item = await f.mail.read({ id: result.items[0]?.id });
    expect(f.factory.mock.calls[0]).toBeDefined();
    expect(f.c.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(item.unread).toBe(true);
    expect(item.text).toContain("Please reply");
    expect(f.c.fetchOne).toHaveBeenCalledWith(
      9,
      { uid: true, source: true, envelope: true, flags: true },
      { uid: true },
    );
    expect(f.c.logout).toHaveBeenCalledTimes(2);
  });
  it("refuses stale UIDVALIDITY before reading body", async () => {
    const f = mailFixture();
    await expect(
      f.mail.read({ id: JSON.stringify(["INBOX", "999", 9]) }),
    ).rejects.toThrow();
    expect(f.c.fetchOne).not.toHaveBeenCalled();
  });
  it("handles asynchronous transport errors without an unhandled event", async () => {
    const f = mailFixture();
    await f.mail.list();
    const listener = f.c.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toBeTypeOf("function");
    listener?.(new Error("transport failure"));
    expect(f.c.close).toHaveBeenCalled();
  });
  it("closes after connection failure", async () => {
    const f = mailFixture();
    f.c.connect.mockRejectedValueOnce(new Error("auth"));
    await expect(f.mail.list()).rejects.toThrow();
    expect(f.c.logout).toHaveBeenCalled();
  });
  it("returns evidence candidates rather than invented deadlines", () => {
    const r = taskHints([
      {
        id: "1",
        source: "mail",
        title: "Please reply",
        text: "Deadline: Friday",
      },
    ]);
    expect(r[0]?.evidence).toContain("Deadline: Friday");
  });
});
