// © 2026 Yasuhiko Yokote

/**
 * Tests for the path check.
 *
 * The main aim is to cover every input that must be rejected.
 * The tests of inputs that must be accepted check that the rejection is not excessive.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizePath,
  childPath,
  isForbiddenName,
  PathRejected,
  allowedFolderCount,
  allowedFolderUntil,
  forgetAllowedFolders,
  freshAllowedUntil,
  isFolderKnownAllowed,
  knownFolder,
  normalizePathWith,
  normalizeStructure,
  rejectionReason,
  rememberAllowedFolders,
  setForbiddenNames,
  type RejectReason,
} from "../src/guard/path.ts";

// The list of forbidden names comes from the configuration and is empty by default.
// These tests run with two names listed, except where a test sets the list itself
const LISTED = ["credentials", "Crypto Folder"];
setForbiddenNames(LISTED);

/** Checks that the input is rejected for the given reason. */
function rejects(input: unknown, reason: RejectReason): void {
  assert.throws(
    () => normalizePath(input),
    (e: unknown) => {
      assert.ok(e instanceof PathRejected, `not a PathRejected: ${String(e)}`);
      assert.equal(e.reason, reason, `wrong reason (actual: ${e.reason})`);
      return true;
    },
    `an input that must be rejected was accepted: ${JSON.stringify(input)}`,
  );
}

describe("normalizePath - inputs that must be rejected", () => {
  test("paths that contain `..`", () => {
    for (const p of [
      "/a/../b",
      "/..",
      "..",
      "a/..",
      "/My Documents/../../etc/passwd",
      "/../../..",
      "/a/b/../../..",
      "//../",
      "/a/../../b",
    ]) {
      rejects(p, "dot-segment");
    }
  });

  test("paths that contain `.`", () => {
    for (const p of ["/.", "/a/./b", ".", "./a"]) {
      rejects(p, "dot-segment");
    }
  });

  test("paths that contain a control character", () => {
    for (const p of [
      "/a\u0000b",   // null character
      "/a\nb",       // line feed
      "/a\rb",       // carriage return
      "/a\tb",       // tab
      "/a\u001Bb",   // escape
      "/a\u007Fb",   // DEL
    ]) {
      rejects(p, "control-char");
    }
  });

  test("paths that contain a forbidden name - at any depth", () => {
    for (const p of [
      "/credentials",
      "/credentials/token.key",
      "/a/credentials/b",
      "/a/b/credentials",
      "/Crypto Folder",
      "/Crypto Folder/secret.pdf",
      "/a/Crypto Folder/b",
    ]) {
      rejects(p, "forbidden-name");
    }
  });

  test("forbidden names - a difference in case does not get through", () => {
    for (const p of ["/Credentials", "/CREDENTIALS", "/crypto folder", "/CRYPTO FOLDER"]) {
      rejects(p, "forbidden-name");
    }
  });

  test("forbidden names - a difference in normalization does not get through", () => {
    // Even when written in NFD (the form with combining marks separated), the name is converted to NFC before the comparison
    const nfd = "Crypto Folder".normalize("NFD");
    rejects(`/${nfd}`, "forbidden-name");
  });

  test("repeated, leading or trailing slashes do not get through", () => {
    for (const p of ["//credentials", "/credentials/", "///credentials///"]) {
      rejects(p, "forbidden-name");
    }
  });

  test("values that are not strings", () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      rejects(v, "not-a-string");
    }
  });

  test("paths that are too long", () => {
    rejects("/" + "a".repeat(5000), "too-long");
    rejects("/" + "あ".repeat(400), "segment-too-long"); // 3 bytes x 400 = 1200
  });
});

describe("normalizePath - inputs that must be accepted", () => {
  test("the root", () => {
    for (const p of ["/", "", "//", "///"]) {
      assert.equal(normalizePath(p), "/");
    }
  });

  test("ordinary paths", () => {
    assert.equal(normalizePath("/My Documents"), "/My Documents");
    assert.equal(normalizePath("/My Documents/report.pdf"), "/My Documents/report.pdf");
  });

  test("normalizes leading, trailing and repeated slashes", () => {
    assert.equal(normalizePath("My Documents"), "/My Documents");
    assert.equal(normalizePath("/My Documents/"), "/My Documents");
    assert.equal(normalizePath("//My  Documents//report.pdf//"), "/My  Documents/report.pdf");
  });

  test("names that contain Japanese, spaces and symbols", () => {
    assert.equal(normalizePath("/My Documents/通知.pdf"), "/My Documents/通知.pdf");
    assert.equal(normalizePath("/a/#1 (草案) [v2].md"), "/a/#1 (草案) [v2].md");
    assert.equal(normalizePath("/a/b&c=d?e.txt"), "/a/b&c=d?e.txt");
  });

  test("`\\` stays part of the name - it is not turned into a separator", () => {
    assert.equal(normalizePath("/a\\b.txt"), "/a\\b.txt");
    assert.equal(normalizePath("/dir/back\\slash"), "/dir/back\\slash");
  });

  test("names that only resemble a forbidden name are accepted", () => {
    assert.equal(normalizePath("/credentials.txt"), "/credentials.txt");
    assert.equal(normalizePath("/my credentials"), "/my credentials");
    assert.equal(normalizePath("/Crypto Folder Backup"), "/Crypto Folder Backup");
  });

  test("names that contain `..` as part of the name are accepted", () => {
    assert.equal(normalizePath("/a..b"), "/a..b");
    assert.equal(normalizePath("/..hidden"), "/..hidden");
    assert.equal(normalizePath("/version..2.txt"), "/version..2.txt");
  });
});

describe("normalizePath - does not change the Unicode normalization form", () => {
  // pCloud matches a path byte for byte (measured).
  // Converting to NFC would make every name stored in NFD fail to match
  // The name contains two voiced kana (`ぎ` and `ド`), which NFD decomposes
  const NFD = "かぎとドア.png"; // decomposed form (the form pCloud stores)
  const NFC = "かぎとドア.png"; //           composed form

  test("premise: the two have different code points", () => {
    assert.notEqual(NFD, NFC);
    assert.equal(NFD.normalize("NFC"), NFC);
  });

  test("**NFD in, NFD out**", () => {
    assert.equal(normalizePath(`/w/${NFD}`), `/w/${NFD}`);
  });

  test("**NFC in, NFC out**", () => {
    assert.equal(normalizePath(`/w/${NFC}`), `/w/${NFC}`);
  });

  test("childPath keeps the form too", () => {
    assert.equal(childPath("/w", NFD), `/w/${NFD}`);
    assert.equal(childPath("/w", NFC), `/w/${NFC}`);
  });

  test("**the check works the same in either form**", () => {
    // No forbidden name has a combining mark, so this uses characters that have a composed form
    const decomposed = "Crypto Folder".normalize("NFD");
    assert.throws(() => normalizePath(`/${decomposed}/x`), PathRejected);
  });
});

describe("isForbiddenName", () => {
  test("detects forbidden names", () => {
    assert.equal(isForbiddenName("credentials"), true);
    assert.equal(isForbiddenName("Credentials"), true);
    assert.equal(isForbiddenName("Crypto Folder"), true);
  });

  test("does not detect names that only resemble one", () => {
    assert.equal(isForbiddenName("credentials.txt"), false);
    assert.equal(isForbiddenName("Crypto Folder Backup"), false);
    assert.equal(isForbiddenName("My Documents"), false);
  });
});

describe("childPath", () => {
  test("appends a name to the parent", () => {
    assert.equal(childPath("/", "My Documents"), "/My Documents");
    assert.equal(childPath("/My Documents", "report.pdf"), "/My Documents/report.pdf");
  });

  test("the appended name is checked too", () => {
    assert.throws(() => childPath("/a", ".."), PathRejected);
    assert.throws(() => childPath("/a", "credentials"), PathRejected);
  });

  test("a `/` inside the name only adds levels, and the check still applies", () => {
    assert.throws(() => childPath("/a", "b/../../c"), PathRejected);
  });
});

describe("the list of forbidden names comes from the configuration", () => {
  const withList = (names: string[], run: () => void) => {
    setForbiddenNames(names);
    try {
      run();
    } finally {
      setForbiddenNames(LISTED);
    }
  };

  test("**an empty list excludes nothing**", () => {
    withList([], () => {
      for (const p of ["/credentials", "/credentials/token.key", "/a/Crypto Folder/b", "/CREDENTIALS"]) {
        assert.equal(normalizePath(p), p);
      }
      assert.equal(isForbiddenName("credentials"), false);
      assert.equal(isForbiddenName("Crypto Folder"), false);
      assert.equal(childPath("/a", "credentials"), "/a/credentials");
    });
  });

  test("the other checks do not depend on the list", () => {
    withList([], () => {
      rejects("/a/../b", "dot-segment");
      rejects("/a/./b", "dot-segment");
      rejects("/a\u0001b", "control-char");
    });
  });

  test("only the listed names are excluded", () => {
    withList(["private"], () => {
      rejects("/private/x", "forbidden-name");
      rejects("/a/PRIVATE", "forbidden-name");
      assert.equal(normalizePath("/credentials/x"), "/credentials/x");
      assert.equal(normalizePath("/private.txt"), "/private.txt");
    });
  });

  test("a listed name is compared in the same way whatever form it was listed in", () => {
    withList(["CREDENTIALS", "\u30c4\u3099"], () => {
      rejects("/credentials", "forbidden-name");
      // Listed in the decomposed form, matched in the composed form
      rejects("/\u30c5", "forbidden-name");
    });
  });
});

describe("the two variants of the check", () => {
  test("normalizePathWith uses the list it is given, not the one in force", () => {
    // "credentials" is in force here; "private" is not
    assert.equal(normalizePathWith("/credentials/x", []), "/credentials/x");
    assert.throws(() => normalizePathWith("/private/x", ["Private"]), PathRejected);
    assert.throws(() => normalizePathWith("/a/../b", []), PathRejected);
    // The list in force is unchanged
    assert.equal(isForbiddenName("credentials"), true);
    assert.equal(isForbiddenName("private"), false);
  });

  test("**normalizeStructure checks the shape only**", () => {
    assert.equal(normalizeStructure("/repo.git/refs/heads/credentials"), "/repo.git/refs/heads/credentials");
    for (const bad of ["/a/../b", "/a/./b", "/a\u0001b"]) {
      assert.throws(() => normalizeStructure(bad), PathRejected, bad);
    }
  });
});

/** Folders to remember, each with a path made up for the test. */
const folders = (...ids: number[]) => ids.map((id) => ({ id, path: `/folder-${id}` }));

describe("the folders found to be allowed", () => {
  test("are remembered for a limited time only", () => {
    forgetAllowedFolders();
    rememberAllowedFolders(folders(5, 6), freshAllowedUntil(1_000));
    assert.equal(isFolderKnownAllowed(5, 1_000), true);
    assert.equal(isFolderKnownAllowed(6, 1_000 + 4 * 60_000), true);
    // A folder can be moved on pCloud; after 5 minutes it is checked again
    assert.equal(isFolderKnownAllowed(6, 1_000 + 5 * 60_000 + 1), false);
    assert.equal(isFolderKnownAllowed(7, 1_000), false);
  });

  test("**are forgotten when the forbidden names change**", () => {
    rememberAllowedFolders(folders(5), freshAllowedUntil(1_000));
    setForbiddenNames(LISTED);
    assert.equal(isFolderKnownAllowed(5, 1_000), false);
  });
});

describe("the folders found to be allowed - **a finding is never used past its own time**", () => {
  test("a folder that passed because of a remembered one gets that one's time, not a new one", () => {
    forgetAllowedFolders();
    const until = freshAllowedUntil(0); // found at 0, good for 5 minutes
    rememberAllowedFolders(folders(5), until);
    // 4 minutes 50 seconds later, folder 9 passes because 5 is still remembered
    const later = 4 * 60_000 + 50_000;
    assert.equal(allowedFolderUntil(5, later), until);
    rememberAllowedFolders(folders(9), allowedFolderUntil(5, later)!);
    // Both end together: 9 is not good for another 5 minutes
    assert.equal(isFolderKnownAllowed(9, until), true);
    assert.equal(isFolderKnownAllowed(9, until + 1), false);
    assert.equal(isFolderKnownAllowed(5, until + 1), false);
  });

  test("the path of a folder is remembered with it", () => {
    forgetAllowedFolders();
    rememberAllowedFolders([{ id: 5, path: "/b/a" }], freshAllowedUntil(0));
    assert.equal(knownFolder(5, 0)?.path, "/b/a");
    assert.equal(knownFolder(5, 5 * 60_000 + 1), undefined);
  });

  test("remembering again never moves the end later than what is given", () => {
    forgetAllowedFolders();
    rememberAllowedFolders(folders(5), 10_000);
    rememberAllowedFolders(folders(5), 4_000);
    assert.equal(allowedFolderUntil(5, 0), 4_000);
  });

  test("**what has run out is removed, so the record does not grow for ever**", () => {
    forgetAllowedFolders();
    // At time 0 all of them are still good, so none is removed while they are added
    for (let id = 1; id <= 600; id++) rememberAllowedFolders(folders(id), 1_000, 0);
    assert.equal(allowedFolderCount(), 600);
    // Much later, one more is remembered: the 600 that ran out are dropped
    rememberAllowedFolders(folders(9_999), freshAllowedUntil(10_000_000), 10_000_000);
    assert.equal(allowedFolderCount(), 1);
  });
});

describe("rejectionReason", () => {
  test("is the message of a rejected path, and a fixed sentence for anything else", () => {
    let caught: unknown;
    try {
      normalizePath("/a/../b");
    } catch (e) {
      caught = e;
    }
    assert.match(rejectionReason(caught), /'\.\.'/);
    assert.equal(rejectionReason(new Error("internal detail")), "it cannot be used as a path");
    assert.equal(rejectionReason("x"), "it cannot be used as a path");
  });
});
