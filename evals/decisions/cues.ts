// Production word cues (src/tool-domains.ts) for the routing rule baseline.
// Reads a JSON array of messages on stdin; prints a JSON array of cue domains per message.
import { selectDomains } from "../../src/tool-domains.js";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const messages: string[] = JSON.parse(input);
  console.log(
    JSON.stringify(messages.map((message) => [...selectDomains({ message })])),
  );
});
