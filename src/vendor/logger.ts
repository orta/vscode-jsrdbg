
import * as fs from 'fs';

export enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    None,
}

export function LogLevelFromString(logLevelString: string): LogLevel {
    switch (logLevelString) {
        case 'Debug':
            return LogLevel.Debug;

        case 'Info':
            return LogLevel.Info;

        case 'Warn':
            return LogLevel.Warn;

        case 'Error':
            return LogLevel.Error;

        case 'None':
            return LogLevel.None;

        default:
            throw new Error("${logLevelString} cannot be translated to a LogLevel");
    }
}

export interface LogConfiguration {
    /** The name of the logfile. */
    fileName?: string;
    /** The minimum loglevel(s) for messages written to the logfile. */
    logLevel?: { [logName: string]: LogLevel };
}

export class Logger {
    public static fd: number | undefined;

    public static create(name: string): Logger {
        return new Logger(name);
    }

    private static loggers = new Map<string, Logger>();
    private static _config: LogConfiguration = {};
    private static startTime = Date.now();

    private logLevel: LogLevel = LogLevel.None;

    constructor(private name: string) {
        this.configure();
        Logger.loggers.set(name, this);
    }

    public debug(msg: string): void { this.log(LogLevel.Debug, 'DEBUG', msg); }

    public info(msg: string): void { this.log(LogLevel.Info, 'INFO', msg); }

    public warn(msg: string): void { this.log(LogLevel.Warn, 'WARN', msg); }

    public error(msg: string): void { this.log(LogLevel.Error, 'ERROR', msg); }

    public static set config(newConfig: LogConfiguration) {
        if (Logger.fd !== undefined) {
            fs.closeSync(Logger.fd);
            Logger.fd = undefined;
        }

        Logger._config = newConfig;
        if (Logger._config.fileName) {
            try {
                Logger.fd = fs.openSync(Logger._config.fileName, 'w');
            } catch (err) {
                // Swallow
            }
        }

        Logger.loggers.forEach(logger => logger.configure());
    }

    private log(level: LogLevel, displayLevel: string, msg: string): void {
        if (level < this.logLevel) {
            return;
        }

        const elapsedTime = (Date.now() - Logger.startTime) / 1000;
        let elapsedTimeString = elapsedTime.toFixed(3);
        while (elapsedTimeString.length < 9) {
            elapsedTimeString = '0' + elapsedTimeString;
        }
        while (displayLevel.length < 5) {
            displayLevel = displayLevel + ' ';
        }
        const logLine = displayLevel + '|' + elapsedTimeString + '|' + this.name + ': ' + msg;

        if ((Logger.fd !== undefined)) {
            fs.writeSync(Logger.fd, logLine + '\n');
        }
    }

    private configure(): void {
        if (Logger._config.fileName && Logger._config.logLevel) {
            try {
                this.logLevel = Logger._config.logLevel[this.name];
            } catch (err) {
                // tslint:disable-next-line:no-string-literal
                this.logLevel = Logger._config.logLevel['default'];
                throw err;
            }
        } else {
            this.logLevel = LogLevel.Debug;
        }
    }
}
