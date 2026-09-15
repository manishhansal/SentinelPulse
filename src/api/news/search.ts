import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { EmbeddingEngine } from '../../engines/embedding/EmbeddingEngine.js';

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  topK: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['article', 'event', 'entity']).default('article'),
});

/**
 * Registers the GET /api/v1/news/search endpoint.
 *
 * Accepts:
 *   - q: natural-language query string (required)
 *   - topK: number of results to return (default 20, max 100)
 *   - type: entity type to search (article|event|entity, default article)
 *
 * Returns ranked results by cosine similarity via EmbeddingEngine.findSimilar().
 * Target p95 < 500ms (Req 18.4).
 *
 * Requirements: Req 18.3, Req 25.1
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function registerSearchRoute(app: FastifyInstance, embeddingEngine: EmbeddingEngine): Promise<void> {
  app.get('/api/v1/news/search', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          topK: { type: 'number' },
          type: { type: 'string', enum: ['article', 'event', 'entity'] },
        },
        required: ['q'],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = searchQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid query parameters',
        details: query.error.errors,
      });
    }

    const { q, topK, type } = query.data;

    try {
      const results = await embeddingEngine.findSimilar(q, type, topK);

      return reply.send({
        success: true,
        data: {
          query: q,
          type,
          results,
          total: results.length,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: 'v1',
        },
      });
    } catch (err) {
      request.log.error({ err, query: q }, 'Semantic search failed');
      return reply.status(500).send({
        success: false,
        error: 'Search temporarily unavailable',
      });
    }
  });
}
