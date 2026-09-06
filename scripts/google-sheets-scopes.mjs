export function validateSheetsScopes(scope) {
  const granted = new Set(
    String(scope || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((s) =>
        s === "email" ? "https://www.googleapis.com/auth/userinfo.email" : s,
      ),
  );
  const expected = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.file",
  ];
  if (!granted.has(expected[2]))
    throw Error(
      "Missing file permission. Select the files-you-use-with-this-app checkbox on Google consent.",
    );
  if (granted.size !== expected.length || expected.some((s) => !granted.has(s)))
    throw Error(
      "Unexpected Google permissions. Setup stopped without saving credentials.",
    );
}
