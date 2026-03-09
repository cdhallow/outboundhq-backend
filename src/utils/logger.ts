type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface Logger {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
}

function formatMessage(level: LogLevel, namespace: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] [${namespace}] ${message}`;
  if (data !== undefined) {
    const extra = data instanceof Error
      ? ` | Error: ${data.message}\n${data.stack}`
      : ` | ${JSON.stringify(data)}`;
    return base + extra;
  }
  return base;
}

export function createLogger(namespace: string): Logger {
  return {
    info: (message, data) => console.log(formatMessage('info', namespace, message, data)),
    warn: (message, data) => console.warn(formatMessage('warn', namespace, message, data)),
    error: (message, data) => console.error(formatMessage('error', namespace, message, data)),
    debug: (message, data) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(formatMessage('debug', namespace, message, data));
      }
    },
  };
}
