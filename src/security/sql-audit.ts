/**
 * SQL Injection Prevention Audit
 * Requirements: Req 30.3
 *
 * All database access in SentinelPulse uses Prisma ORM query builder
 * which prevents SQL injection by default via parameterised queries.
 *
 * Raw SQL usage (pgvector queries in EmbeddingEngine.ts and
 * DeduplicationEngine.ts) uses $queryRaw with tagged template literals
 * or $queryRawUnsafe with positional $1/$2 parameter placeholders.
 *
 * User input is NEVER interpolated directly into SQL strings.
 */
export const SQL_AUDIT_VERSION = '1.0.0';
export const AUDIT_DATE = '2024-01-15';
