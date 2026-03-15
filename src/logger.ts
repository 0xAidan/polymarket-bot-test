import pino from 'pino';

/**
 * Structured logger for the Polymarket copy-trade bot.
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.info({ wallet: '0x...', amount: 500 }, 'Trade executed');
 *   logger.warn({ marketId: 'abc' }, 'Price limit exceeded');
 *   logger.error({ err }, 'Trade failed');
 *
 * Create a child logger scoped to a component:
 *   const log = logger.child({ component: 'WalletMonitor' });
 *   log.info('Polling started');
 */

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
    level: LOG_LEVEL,
    // Human-readable timestamps in ISO-8601
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level(label: string) {
            return { level: label };
        },
    },
});

/**
 * Create a child logger pre-scoped to a component name.
 *
 * @example
 *   const log = createComponentLogger('CopyTrader');
 *   log.info({ tradeId: '123' }, 'Processing trade');
 *   // => {"level":"info","time":"...","component":"CopyTrader","tradeId":"123","msg":"Processing trade"}
 */
export function createComponentLogger(component: string) {
    return logger.child({ component });
}
