const timestamp = () => new Date().toLocaleString();

const format = (level: string, data: unknown[]) => [`[xhs-marketing-extension ${level}]`, `[${timestamp()}]`, ...data];

const logger = {
  debug: (...data: unknown[]) => console.debug(...format("debug", data)),
  info: (...data: unknown[]) => console.info(...format("info", data)),
  warn: (...data: unknown[]) => console.warn(...format("warn", data)),
  error: (...data: unknown[]) => console.error(...format("error", data)),
};

export default logger;
