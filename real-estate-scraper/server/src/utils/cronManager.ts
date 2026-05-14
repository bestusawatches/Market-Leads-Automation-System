import { CronJob } from 'cron';
import { logger } from './logger';
import { prisma } from '../db/client';

type JobConfig = {
  name: string;
  schedule: string;
  timeZone?: string;
  onTick: () => Promise<void>;
  runOnInit?: boolean;
};

export class CronJobManager {
  private jobs: Map<string, CronJob> = new Map();

  createJob(config: JobConfig): void {
    const job = new CronJob(
      config.schedule,
      async () => {
        logger.info(`Starting job: ${config.name}`);
        const start = Date.now();
        
        try {
          await config.onTick();
          const duration = Date.now() - start;
          logger.info(`Completed job: ${config.name} in ${duration}ms`);
        } catch (error) {
          logger.error(`Job ${config.name} failed`, {
            error: error instanceof Error ? error.stack : 'Unknown error'
          });
        }
      },
      null, // onComplete
      config.runOnInit || false,
      config.timeZone || 'Africa/Lagos'
    );

    this.jobs.set(config.name, job);
  }

  startAll(): void {
    this.jobs.forEach(job => job.start());
    logger.info(`Started ${this.jobs.size} cron jobs`);
  }

  stopAll(): void {
    this.jobs.forEach(job => job.stop());
    logger.info(`Stopped ${this.jobs.size} cron jobs`);
  }

  getJob(name: string): CronJob | undefined {
    return this.jobs.get(name);
  }
}

// Single instance for the app
export const cronManager = new CronJobManager();

// Graceful shutdown handling
const shutdown = async () => {
  cronManager.stopAll();
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.warn('Error disconnecting prisma during shutdown', err);
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);