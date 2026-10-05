import { describe, expect, it, vi } from "vitest";
import { HomeCredentials, credentialKey, credentialRef } from "../src/credentials.ts";
import { type Source } from "../src/model.ts";
const source: Source = { id: "rss", label: "RSS", kind: "freshrss", endpoint: "https://rss.test", username: "test" };
function home() {
  const values = new Map<string, unknown>();
  const settings = {
    define: vi.fn(() => () => {}),
    get: (key: string) => values.get(key),
    set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
  const legacy = { read: vi.fn(async () => "legacy-password") };
  return { values, settings, legacy, vault: new HomeCredentials(settings, legacy) };
}
describe("home credentials", () => {
  it("uses only this home and the matching destination binding", async () => {
    const a = home(); const b = home();
    const key = a.vault.prepare(source);
    await a.settings.set(key, "a-password");
    const connected = { ...source, credentialRef: await a.vault.connect(source, false) };
    expect(await a.vault.read(connected)).toBe("a-password");
    expect(b.vault.configured(connected)).toBe(false);
    await expect(b.vault.read(connected)).rejects.toThrow();
    await expect(a.vault.read({ ...connected, endpoint: "https://other.test" })).rejects.toThrow();
    expect(credentialKey({ ...source, username: "other" })).not.toBe(key);
    expect(a.legacy.read).not.toHaveBeenCalled();
  });
  it("copies legacy values explicitly, preserves the system entry and never revives a cleared value", async () => {
    const h = home();
    const old = { ...source, credentialRef: "gwb-sources/v1/00000000-0000-0000-0000-000000000000" };
    await expect(h.vault.read(old)).rejects.toThrow();
    expect(h.legacy.read).not.toHaveBeenCalled();
    expect(await h.vault.connect(old, true)).toBe(credentialRef(source));
    expect(h.values.get(credentialKey(source))).toBe("legacy-password");
    await h.vault.forget({ ...source, credentialRef: credentialRef(source) });
    await expect(h.vault.connect(old, true)).rejects.toThrow("已迁移");
    expect(h.legacy.read).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite an already imported home credential", async () => {
    const h = home();
    await h.settings.set(h.vault.prepare(source), "new-password");
    await h.vault.connect({ ...source, credentialRef: "gwb-sources/v1/00000000-0000-0000-0000-000000000000" }, true);
    expect(h.values.get(credentialKey(source))).toBe("new-password");
    expect(h.legacy.read).not.toHaveBeenCalled();
  });
  it("does not advance migration when reading or saving the old value fails", async () => {
    const h = home();
    h.settings.set.mockRejectedValueOnce(new Error("disk full"));
    const old = { ...source, credentialRef: "gwb-sources/v1/00000000-0000-0000-0000-000000000000" };
    await expect(h.vault.connect(old, true)).rejects.toThrow();
    expect(h.values.get(`${credentialKey(source)}-legacy-migrated`)).toBeUndefined();
    await expect(h.vault.connect(old, true)).resolves.toBe(credentialRef(source));
  });
});
