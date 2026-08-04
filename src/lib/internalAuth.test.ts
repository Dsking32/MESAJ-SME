import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { verifyInternalSecret } from "./internalAuth";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function requestWithAuth(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;
  return new NextRequest("https://example.test/api/internal/whatever", { headers });
}

afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("verifyInternalSecret", () => {
  it("fails closed with 503 when CRON_SECRET isn't configured at all", () => {
    delete process.env.CRON_SECRET;

    const result = verifyInternalSecret(requestWithAuth("Bearer anything"));

    expect(result?.status).toBe(503);
  });

  it("returns 401 when the header is missing", () => {
    process.env.CRON_SECRET = "test-secret";

    const result = verifyInternalSecret(requestWithAuth());

    expect(result?.status).toBe(401);
  });

  it("returns 401 when the header doesn't match", () => {
    process.env.CRON_SECRET = "test-secret";

    const result = verifyInternalSecret(requestWithAuth("Bearer wrong-secret"));

    expect(result?.status).toBe(401);
  });

  it("returns null (allowed) when the header matches exactly", () => {
    process.env.CRON_SECRET = "test-secret";

    const result = verifyInternalSecret(requestWithAuth("Bearer test-secret"));

    expect(result).toBeNull();
  });
});
