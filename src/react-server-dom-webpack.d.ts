declare module 'react-server-dom-webpack/server.edge' {
  export function renderToReadableStream(
    model: unknown,
    webpackMap: Record<string, unknown>,
    options?: { onError?: (error: unknown) => string | void },
  ): ReadableStream<Uint8Array>;
}
