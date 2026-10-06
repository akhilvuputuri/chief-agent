import { ToolValidationError } from "../tool-errors.js";
import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import type { CodingSettings } from "./schema.js";
export type CodingRole = "leader" | "coder" | "reviewer";
export interface ModelChoice {
  id: string;
  inputPrice: number;
  outputPrice: number;
  tools: boolean;
}
export type CodingCatalog = () => Promise<ModelChoice[]>;
const run = (user: string) => {
  const h = createHash("sha256").update(`coding-models:${user}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export async function modelPreferences(
  db: Database,
  user: string,
  defaults: CodingSettings,
) {
  const rows = (
    await db.query(
      "SELECT DISTINCT ON (data->>'role') data FROM events WHERE user_id=$1 AND run_id=$2 AND type='coding.models' ORDER BY data->>'role',id DESC",
      [user, run(user)],
    )
  ).rows;
  const result = {
    leader: defaults.leaderModel ?? defaults.model,
    coder: defaults.model,
    reviewer: defaults.reviewerModel,
  };
  for (const row of rows)
    if (
      ["leader", "coder", "reviewer"].includes(row.data.role) &&
      typeof row.data.model === "string"
    )
      result[row.data.role as CodingRole] = row.data.model;
  return result;
}
export async function setModelPreference(
  db: Database,
  user: string,
  defaults: CodingSettings,
  role: CodingRole,
  model: string,
  catalog: CodingCatalog,
  inputPrice: number,
  outputPrice: number,
) {
  const choice = (await catalog()).find((m) => m.id === model);
  if (
    !choice ||
    !choice.tools ||
    !Number.isFinite(choice.inputPrice) ||
    !Number.isFinite(choice.outputPrice) ||
    choice.inputPrice < 0 ||
    choice.outputPrice < 0 ||
    choice.inputPrice > inputPrice ||
    choice.outputPrice > outputPrice
  )
    throw new ToolValidationError(
      "Model is unavailable for coding tools or exceeds the existing provider price filters. No setting was changed.",
    );
  // Append one role decision per record; concurrent changes to different roles cannot lose data.
  await db.query(
    "INSERT INTO events(user_id,run_id,type,data) VALUES($1,$2,'coding.models',jsonb_build_object('role',$3::text,'model',$4::text))",
    [user, run(user), role, model],
  );
  return {
    ...(await modelPreferences(db, user, defaults)),
    appliesTo: "new jobs only",
    priceFilters: { input: inputPrice, output: outputPrice },
  };
}
