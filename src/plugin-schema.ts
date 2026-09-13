import { z } from "zod";
import { researchAssignment } from "./research-schema.js";
export const pluginDelegate = researchAssignment
  .extend({
    operation: z.literal("plugin_delegate"),
    agentId: z.string().regex(/^[a-z][a-z0-9-]{0,47}\/[a-z][a-z0-9-]{0,47}$/),
  })
  .strict();
