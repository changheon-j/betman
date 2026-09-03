declare namespace Cloudflare {
  interface Env {
    API_FOOTBALL_KEY: string;
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: { format: string; quality: number }): Promise<{
            response(): Response;
          }>;
        };
      };
    };
  }
}
