import { describe, expect, it } from "vitest";
import { actorString } from "../src/actor.ts";
import { mentionToken, mentions, namesOnly, parseMentions, plainText } from "../src/conversation.ts";

describe("mention tokens", () => {
  const text = "@[Invoice Processor](ai_employee:3f2a) please check @[VBAK](thing:9c1e-aa) and @[VBAK](thing:9c1e-aa) again, cc @[Elif Arslan](person:u-7)";

  it("parses each mention once, in order", () => {
    expect(parseMentions(text)).toEqual([
      { kind: "ai_employee", id: "3f2a", name: "Invoice Processor" },
      { kind: "thing", id: "9c1e-aa", name: "VBAK" },
      { kind: "person", id: "u-7", name: "Elif Arslan" },
    ]);
  });

  it("ignores things that only look like tokens", () => {
    expect(parseMentions("@[Nobody](ghost:1) and @[x](thing:bad id) and [VBAK](thing:1) and @[Old](guest:g-1)")).toEqual([]);
  });

  it("formats a token and reads it back, cleaning the name", () => {
    const token = mentionToken({ kind: "table", id: "complaints", name: "Supplier [complaints]\nregister" });
    expect(token).toBe("@[Supplier complaints register](table:complaints)");
    expect(parseMentions(token)).toEqual([{ kind: "table", id: "complaints", name: "Supplier complaints register" }]);
  });

  it("turns tokens into plain names", () => {
    expect(plainText(text)).toBe("@Invoice Processor please check @VBAK and @VBAK again, cc @Elif Arslan");
    expect(namesOnly(text)).toBe("Invoice Processor please check VBAK and VBAK again, cc Elif Arslan");
  });

  it("knows whether a text mentions someone", () => {
    expect(mentions(text, { kind: "person", id: "u-7" })).toBe(true);
    expect(mentions(text, { kind: "person", id: "u-8" })).toBe(false);
  });

  it("can be called twice on the same global regex", () => {
    expect(parseMentions(text)).toHaveLength(3);
    expect(parseMentions(text)).toHaveLength(3);
  });
});

describe("actorString", () => {
  it("writes actors the way the audit log always did", () => {
    expect(actorString({ kind: "person", id: "u-1", name: "Elif Arslan" }, { email: "elif@acme.com.tr" })).toBe("Elif Arslan <elif@acme.com.tr>");
    expect(actorString({ kind: "person", id: "u-1", name: "Elif Arslan" })).toBe("Elif Arslan");
    expect(actorString({ kind: "ai_employee", id: "a-1", name: "Invoice Processor" })).toBe("agent:a-1");
    expect(actorString({ kind: "system", id: "system", name: "Enterprise Brain" })).toBe("system");
  });
});
