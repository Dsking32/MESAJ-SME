import { describe, it, expect } from "vitest";
import { csvEscape } from "@/lib/csv";

describe("csvEscape", () => {
  it("leaves an ordinary value untouched", () => {
    expect(csvEscape("2348031234567")).toBe("2348031234567");
  });

  it("quotes a value containing a comma", () => {
    expect(csvEscape("Lagos, Nigeria")).toBe('"Lagos, Nigeria"');
  });

  it("quotes and doubles internal double quotes", () => {
    expect(csvEscape('She said "hi"')).toBe('"She said ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("prefixes a leading = with a single quote to defuse a formula", () => {
    expect(csvEscape("=1+1")).toBe("'=1+1");
  });

  it("prefixes a leading + to defuse a formula", () => {
    expect(csvEscape("+1234")).toBe("'+1234");
  });

  it("prefixes a leading - to defuse a formula", () => {
    expect(csvEscape("-1234")).toBe("'-1234");
  });

  it("prefixes a leading @ to defuse a DDE/formula trigger", () => {
    expect(csvEscape("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
  });

  it("prefixes a leading tab", () => {
    expect(csvEscape("\t=cmd")).toBe("'\t=cmd");
  });

  it("prefixes a leading carriage return", () => {
    expect(csvEscape("\r=cmd")).toBe("'\r=cmd");
  });

  it("still applies standard quoting after formula-guarding when needed", () => {
    // Leading '=' triggers the guard prefix; the comma still requires
    // RFC 4180 quoting on top of that.
    expect(csvEscape("=A1,B1")).toBe('"\'=A1,B1"');
  });

  it("does not guard a value where = appears mid-string, not leading", () => {
    expect(csvEscape("a=b")).toBe("a=b");
  });
});
