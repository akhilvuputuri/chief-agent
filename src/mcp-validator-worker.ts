import { parentPort, workerData } from "node:worker_threads";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Only reviewed validator code runs here. Schemas/data are structured-cloned;
// no host environment, database/network client or executable source is supplied.
try {
  const { schema, data } = workerData;
  const Validator =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : Ajv;
  const ajv = new Validator({
    strict: false,
    logger: false,
    validateFormats: true,
    ownProperties: true,
    inlineRefs: false,
  });
  addFormats.default(ajv);
  parentPort!.postMessage({ valid: !!ajv.compile(schema)(data) });
} catch {
  parentPort!.postMessage({ valid: false });
}
