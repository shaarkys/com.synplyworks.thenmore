export interface OwnerApiSession {
  baseUrl: string;
  homeyId: string;
  token: string;
}

type SessionProvider = () => Promise<OwnerApiSession>;

export class OwnerApiClient {
  private sessionPromise: Promise<OwnerApiSession> | null = null;

  constructor(
    private readonly sessionProvider: SessionProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async request<T>(
    method: "GET" | "PUT",
    path: string,
    body?: unknown,
    retryAfterUnauthorized = true,
  ): Promise<T> {
    const session = await this.getSession();
    const response = await this.fetchImplementation(
      `${session.baseUrl.replace(/\/+$/, "")}/api/manager/devices${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
          "X-Homey-ID": session.homeyId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (response.status === 401 && retryAfterUnauthorized) {
      this.sessionPromise = null;
      return this.request<T>(method, path, body, false);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const responseText = await response.text();
    let responseBody: unknown = responseText;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Keep non-JSON error responses readable.
    }

    if (!response.ok) {
      const apiMessage = responseBody && typeof responseBody === "object"
        && "message" in responseBody && typeof responseBody.message === "string"
        ? responseBody.message
        : responseText || response.statusText;
      throw new Error(`Homey Devices API returned HTTP ${response.status}: ${apiMessage}`);
    }

    return responseBody as T;
  }

  clearSession(): void {
    this.sessionPromise = null;
  }

  private async getSession(): Promise<OwnerApiSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.sessionProvider();
      this.sessionPromise.catch(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }
}
