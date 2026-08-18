export interface SemanticLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: SemanticLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
