export type CodingFailureCode =
  | "model_timeout"
  | "model_disconnected"
  | "model_rate_limited"
  | "model_transient_failure"
  | "model_incomplete"
  | "model_cancelled"
  | "model_provider_failed";
/** Only fixed categories and bounded structural metadata cross the worker boundary. */
export class CodingModelFailure extends Error {
  constructor(
    readonly code: CodingFailureCode,
    readonly details: {
      elapsedMs: number;
      callId: string;
      timeoutKind?: "first_output" | "idle" | "total";
      responseId?: string;
      finishReason?: "length" | "content_filter";
      providerStatus?: number;
    },
  ) {
    super(
      code === "model_cancelled"
        ? "Coding model generation cancelled"
        : "Coding model generation failed",
    );
  }
}
