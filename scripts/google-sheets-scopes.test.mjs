import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSheetsScopes } from "./google-sheets-scopes.mjs";
const required =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";
test("accept canonical and duplicate email alias", () => {
  validateSheetsScopes(required);
  validateSheetsScopes(required + " email");
  validateSheetsScopes(
    required.replace("https://www.googleapis.com/auth/userinfo.email", "email"),
  );
});
test("reject identity-only or broader permissions", () => {
  assert.throws(
    () =>
      validateSheetsScopes(
        "email https://www.googleapis.com/auth/userinfo.email openid",
      ),
    /Missing file/,
  );
  assert.throws(
    () =>
      validateSheetsScopes(required + " https://www.googleapis.com/auth/drive"),
    /Unexpected/,
  );
  assert.throws(
    () =>
      validateSheetsScopes(
        required + " https://www.googleapis.com/auth/gmail.readonly",
      ),
    /Unexpected/,
  );
});
