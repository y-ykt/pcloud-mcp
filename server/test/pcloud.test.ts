// © 2026 Yasuhiko Yokote

/**
 * Tests for the pCloud access layer (`src/pcloud/client.ts`).
 *
 * They check **the handling of a mismatch in Unicode normalization form**.
 * pCloud matches a path byte for byte and does not normalize it (measured).
 * A name uploaded from macOS is stored in NFD,
 * so a lookup with the NFC name fails with `2055 File or folder not found`.
 *
 * A replaced `fetch` simulates the network. **The real pCloud is never called.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PCloudClient, PCloudError, pathVariants } from "../src/pcloud/client.ts";

// The name contains two voiced kana (`ぎ` and `ド`), which NFD decomposes
const NFD = "/w/かぎとドア.png"; // decomposed form (the form pCloud stores)
const NFC = "/w/かぎとドア.png"; //             composed form

/** Simulates pCloud responses. Succeeds only when the path equals `storedPath`. */
function fakePCloud(storedPath: string) {
  const seen: string[] = [];
  const impl = ((input: string | URL) => {
    const url = new URL(String(input));
    const path = url.searchParams.get("path") ?? "";
    seen.push(path);
    const body =
      path === storedPath
        ? { result: 0, metadata: { name: "x", isfolder: false, size: 124122, fileid: 1 } }
        : { result: 2055, error: "File or folder not found." };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const client = (impl: typeof fetch) =>
  new PCloudClient({ apiHost: "https://api.pcloud.com", accessToken: "t", fetchImpl: impl, maxRetries: 0 });

describe("pathVariants - candidates for the retry", () => {
  it("the received form comes first", () => {
    assert.equal(pathVariants(NFD)[0], NFD);
    assert.equal(pathVariants(NFC)[0], NFC);
  });

  it("contains both forms", () => {
    const v = pathVariants(NFC);
    assert.ok(v.includes(NFC));
    assert.ok(v.includes(NFD));
  });

  it("a name with no difference between the forms gives one candidate", () => {
    assert.deepEqual(pathVariants("/My Documents/report.pdf"), ["/My Documents/report.pdf"]);
  });
});

describe("retries with the other normalization form when not found", () => {
  it("**found when requested in NFC and stored in NFD**", async () => {
    const { impl, seen } = fakePCloud(NFD);
    const meta = await client(impl).stat({ path: NFC });
    assert.equal(meta.size, 124122);
    assert.deepEqual(seen, [NFC, NFD]); // the received form first, then the decomposed form
  });

  it("**found when requested in NFD and stored in NFC**", async () => {
    const { impl, seen } = fakePCloud(NFC);
    const meta = await client(impl).stat({ path: NFD });
    assert.equal(meta.size, 124122);
    assert.deepEqual(seen, [NFD, NFC]);
  });

  it("**does not retry when the first lookup succeeds**", async () => {
    const { impl, seen } = fakePCloud(NFD);
    await client(impl).stat({ path: NFD });
    assert.deepEqual(seen, [NFD]);
  });

  it("a name with no difference between the forms is looked up only once", async () => {
    const { impl, seen } = fakePCloud("/a/b.txt");
    await client(impl).stat({ path: "/a/b.txt" });
    assert.equal(seen.length, 1);
  });

  it("a path that really does not exist is reported as not found after every candidate was tried", async () => {
    const { impl, seen } = fakePCloud("/elsewhere.txt");
    await assert.rejects(
      client(impl).stat({ path: NFC }),
      (e: unknown) => e instanceof PCloudError && e.result === 2055,
    );
    assert.deepEqual(seen, [NFC, NFD]);
  });

  it("does not retry on a failure other than not found", async () => {
    const seen: string[] = [];
    const impl = ((input: string | URL) => {
      seen.push(new URL(String(input)).searchParams.get("path") ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ result: 2094, error: "Invalid 'access_token'." }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await assert.rejects(
      client(impl).stat({ path: NFC }),
      (e: unknown) => e instanceof PCloudError && e.result === 2094,
    );
    assert.equal(seen.length, 1, "an authentication failure must not cause a retry");
  });

  it("a lookup by id is not retried", async () => {
    const seen: string[] = [];
    const impl = (() => {
      seen.push("called");
      return Promise.resolve(
        new Response(JSON.stringify({ result: 2009, error: "File not found." }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await assert.rejects(client(impl).stat({ fileid: 42 }), PCloudError);
    assert.equal(seen.length, 1);
  });
});
