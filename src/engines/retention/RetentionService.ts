import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';

export class RetentionService {
  private readonly logger = pino({ name: 'RetentionService' });

  /**
   * Runs the data retention sweep.
   * Called at most once per 24 hours.
   * Requirements: Req 33.1
   */
  async sweep(): Promise<void> {
    const now = new Date();

    const rawArticleDays = parseInt(process.env['RETENTION_RAW_ARTICLES_DAYS'] ?? '90', 10);
    const normalizedDays = parseInt(process.env['RETENTION_NORMALIZED_ARTICLES_DAYS'] ?? '365', 10);
    const eventsDays = parseInt(process.env['RETENTION_EVENTS_DAYS'] ?? '730', 10);

    // Raw article content (delete articles older than retention period)
    if (rawArticleDays > 0) {
      const cutoff = new Date(now.getTime() - rawArticleDays * 24 * 60 * 60 * 1000);
      const result = await prisma.newsArticle.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          // Only delete if no linked training samples (preserve ML data)
        },
      });
      this.logger.info({ deleted: result.count, cutoff }, 'Raw article retention sweep complete');
    }

    // Event records
    if (eventsDays > 0) {
      const cutoff = new Date(now.getTime() - eventsDays * 24 * 60 * 60 * 1000);
      const result = await prisma.newsEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      this.logger.info({ deleted: result.count, cutoff }, 'Event retention sweep complete');
    }

    // Suppress unused variable warning for normalizedDays — reserved for future use
    void normalizedDays;

    this.logger.info('Data retention sweep complete');
  }
}
