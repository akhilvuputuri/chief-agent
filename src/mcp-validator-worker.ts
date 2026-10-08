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
  const validate = ajv.compile(schema);
  // AJV's $async extension returns a Promise, which must never become a truthy success.
  if ("$async" in validate && validate.$async)
    throw new Error("Async schemas are unsupported");
  const valid = validate(data);
  if (typeof valid !== "boolean")
    throw new Error("Unexpected validator result");
  parentPort!.postMessage({ valid: valid === true });
} catch {
  parentPort!.postMessage({ valid: false });
}
