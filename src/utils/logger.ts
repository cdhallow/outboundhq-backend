type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogData {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: string;
  data?: any;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: any) {
    const logData: LogData = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: this.context,
    };

    if (data) {
      logData.data = data;
    }

    const prefix = `[${logData.timestamp}] [${level.toUpperCase()}] [${this.context}]`;
    
    switch (level) {
      case 'error':
        console.error(prefix, message, data || '');
        break;
      case 'warn':
        console.warn(prefix, message, data || '');
        break;
      case 'debug':
        if (process.env.NODE_ENV !== 'production') {
          console.debug(prefix, message, data || '');
        }
        break;
      default:
        console.log(prefix, message, data || '');
    }
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  error(message: string, data?: any) {
    this.log('error', message, data);
  }

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }
}

export const createLogger = (context: string) => new Logger(context);
