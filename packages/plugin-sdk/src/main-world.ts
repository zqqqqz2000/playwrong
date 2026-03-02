export interface MainWorldInvokeRequest {
  code: string;
  args?: unknown[];
}

export interface MainWorldInvokeResult {
  ok: boolean;
  value?: unknown;
  reason?: string;
  error?: string;
}

interface RuntimeMessageApi {
  sendMessage(
    message: Record<string, unknown>,
    callback: (response: unknown) => void
  ): void;
}

interface RuntimeBridge {
  runtime?: RuntimeMessageApi;
  lastError?: { message?: string };
}

function parseMainWorldInvokeResult(input: unknown): MainWorldInvokeResult | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const payload = input as {
    ok?: unknown;
    value?: unknown;
    reason?: unknown;
    error?: unknown;
  };
  const result: MainWorldInvokeResult = {
    ok: payload.ok === true
  };
  if ("value" in payload) {
    result.value = payload.value;
  }
  if (typeof payload.reason === "string") {
    result.reason = payload.reason;
  }
  if (typeof payload.error === "string") {
    result.error = payload.error;
  }
  return result;
}

export async function invokeInMainWorld(request: MainWorldInvokeRequest): Promise<MainWorldInvokeResult> {
  if (!request || typeof request.code !== "string" || request.code.trim().length === 0) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const chromeApi = (globalThis as { chrome?: RuntimeBridge }).chrome;
  const runtimeApi = chromeApi?.runtime;
  if (!runtimeApi?.sendMessage) {
    return {
      ok: false,
      reason: "runtime_unavailable"
    };
  }

  return await new Promise((resolve) => {
    runtimeApi.sendMessage(
      {
        type: "playwrong.mainworld.invoke",
        code: request.code,
        args: Array.isArray(request.args) ? request.args : []
      },
      (response: unknown) => {
        const lastError = chromeApi?.lastError?.message;
        if (lastError && lastError.length > 0) {
          resolve({
            ok: false,
            reason: "runtime_last_error",
            error: lastError
          });
          return;
        }
        const parsed = parseMainWorldInvokeResult(response);
        if (!parsed) {
          resolve({
            ok: false,
            reason: "invalid_bridge_response"
          });
          return;
        }
        resolve(parsed);
      }
    );
  });
}
