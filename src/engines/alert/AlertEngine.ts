/**
 * AlertEngine — generates, deduplicates, persists, and delivers alerts for
 * market-moving news events.
 *
 * Trigger conditions (Req 24.1):
 *   (a) HIGH_IMPORTANCE  — importance_score > configurable threshold (default 0.8)
 *   (b) VELOCITY_SPIKE   — news velocity > 3× 7-day rolling baseline
 *   (c) SENTIMENT_REVERSAL — market sentiment changes sign with confidence > 0.7
 *                            within a 30-minute rolling window
 *
 * Cooldown (Req 24.2):
 *   - Per-asset, per-trigger-type cooldown (default 10 min, range 1–1440 min)
 *   - Enforced by querying news_alerts for recent matching rows
 *
 * Cluster deduplication (Req 24.3):
 *   - Same cluster_id + alert_type + cooldown window → at most one alert
 *
 * Delivery (Req 24.4):
 *   - POST to webhookUrl with 3 retries at 5 s intervals
 *   - description capped at 500 chars
 *
 * Storage (Req 24.5):
 *   - INSERT into news_alerts with 3 retries at 1 s intervals
 *
 * Requirements: Req 24.1–24.5
 */

import { pino } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertType = 'HIGH_IMPORTANCE' | 'VELOCITY_SPIKE' | 'SENTIMENT_REVERSAL';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface AlertConfig {
  /** Importance score threshold that triggers HIGH_IMPORTANCE alerts.
   *  Default: 0.8, valid range: 0.0–1.0  (Req 24.1a) */
  importanceThreshold: number;
  /** Per-asset, per-type cooldown in minutes.
   *  Default: 10, valid range: 1–1440  (Req 24.2) */
  cooldownMinutes: number;
  /** Optional webhook URL to POST alerts to (Req 24.4). */
  webhookUrl?: string;
}

export interface AlertPayload {
  alertType: AlertType;
  triggerReason: string;
  assetId: string;
  eventId?: string;
  clusterId?: string;
  importanceScore: number;
  description: string;
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// Defaults & validation helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AlertConfig = {
  importanceThreshold: 0.8,
  cooldownMinutes: 10,
};

/** Clamp cooldownMinutes into the valid range [1, 1440] (Req 24.2). */
function clampCooldown(minutes: number): number {
  return Math.min(1440, Math.max(1, minutes));
}

/** Clamp importanceThreshold into [0.0, 1.0] (Req 24.1a). */
function clampThreshold(value: number): number {
  return Math.min(1.0, Math.max(0.0, value));
}

/** Truncate description to 500 characters (Req 24.4). */
function truncateDescription(desc: string): string {
  return desc.length > 500 ? desc.slice(0, 500) : desc;
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AlertEngine
// ---------------------------------------------------------------------------

export class AlertEngine {
  private readonly logger = pino({ name: 'AlertEngine' });
  private readonly config: AlertConfig;

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = {
      importanceThreshold: clampThreshold(
        config.importanceThreshold ?? DEFAULT_CONFIG.importanceThreshold,
      ),
      cooldownMinutes: clampCooldown(
        config.cooldownMinutes ?? DEFAULT_CONFIG.cooldownMinutes,
      ),
      webhookUrl: config.webhookUrl,
    };
  }

  // -------------------------------------------------------------------------
  // Public trigger methods
  // -------------------------------------------------------------------------

  /**
   * Generates a HIGH_IMPORTANCE alert when `importanceScore` exceeds the
   * configured threshold.
   *
   * Requirements: Req 24.1(a), Req 24.2, Req 24.3
   */
  async generateHighImportanceAlert(params: {
    assetId: string;
    eventId: string;
    importanceScore: number;
    clusterId?: string;
  }): Promise<void> {
    const { assetId, eventId, importanceScore, clusterId } = params;
    const alertType: AlertType = 'HIGH_IMPORTANCE';

    if (importanceScore <= this.config.importanceThreshold) {
      this.logger.debug(
        { assetId, importanceScore, threshold: this.config.importanceThreshold },
        'AlertEngine: importance score below threshold — no alert',
      );
      return;
    }

    if (await this.isInCooldown(assetId, alertType)) {
      this.logger.info(
        { assetId, alertType },
        'AlertEngine: per-asset cooldown active — skipping alert',
      );
      return;
    }

    if (clusterId && (await this.isClusterDeduplicated(clusterId, alertType))) {
      this.logger.info(
        { assetId, clusterId, alertType },
        'AlertEngine: cluster already alerted within cooldown window — skipping',
      );
      return;
    }

    const description = truncateDescription(
      `High-importance event detected for asset ${assetId}. ` +
        `Importance score: ${importanceScore.toFixed(4)} ` +
        `(threshold: ${this.config.importanceThreshold.toFixed(4)}). ` +
        `Event ID: ${eventId}.`,
    );

    const payload: AlertPayload = {
      alertType,
      triggerReason: `importance_score ${importanceScore.toFixed(4)} exceeds threshold ${this.config.importanceThreshold.toFixed(4)}`,
      assetId,
      eventId,
      clusterId,
      importanceScore,
      description,
      computedAt: new Date(),
    };

    await this.persistAndDeliver(payload);
  }

  /**
   * Generates a VELOCITY_SPIKE alert when current velocity exceeds 3× the
   * 7-day rolling baseline for the asset.
   *
   * Requirements: Req 24.1(b), Req 24.2, Req 24.3
   */
  async generateVelocitySpikeAlert(params: {
    assetId: string;
    velocity5m: number;
    baseline: number;
  }): Promise<void> {
    const { assetId, velocity5m, baseline } = params;
    const alertType: AlertType = 'VELOCITY_SPIKE';
    const SPIKE_MULTIPLIER = 3;

    if (baseline <= 0 || velocity5m <= SPIKE_MULTIPLIER * baseline) {
      this.logger.debug(
        { assetId, velocity5m, baseline },
        'AlertEngine: velocity does not exceed 3× baseline — no alert',
      );
      return;
    }

    if (await this.isInCooldown(assetId, alertType)) {
      this.logger.info(
        { assetId, alertType },
        'AlertEngine: per-asset cooldown active — skipping velocity spike alert',
      );
      return;
    }

    const description = truncateDescription(
      `News velocity spike detected for asset ${assetId}. ` +
        `Current velocity: ${velocity5m.toFixed(2)} articles/5 min, ` +
        `7-day baseline: ${baseline.toFixed(2)} (${SPIKE_MULTIPLIER}× threshold: ${(SPIKE_MULTIPLIER * baseline).toFixed(2)}).`,
    );

    const payload: AlertPayload = {
      alertType,
      triggerReason: `velocity ${velocity5m.toFixed(2)} exceeds ${SPIKE_MULTIPLIER}x baseline ${baseline.toFixed(2)}`,
      assetId,
      importanceScore: Math.min(1.0, velocity5m / (SPIKE_MULTIPLIER * baseline + 1)),
      description,
      computedAt: new Date(),
    };

    await this.persistAndDeliver(payload);
  }

  /**
   * Generates a SENTIMENT_REVERSAL alert when market sentiment changes sign
   * with confidence > 0.7 within a 30-minute rolling window.
   *
   * Requirements: Req 24.1(c), Req 24.2, Req 24.3
   */
  async generateSentimentReversalAlert(params: {
    assetId: string;
    fromSentiment: number;
    toSentiment: number;
    confidence: number;
  }): Promise<void> {
    const { assetId, fromSentiment, toSentiment, confidence } = params;
    const alertType: AlertType = 'SENTIMENT_REVERSAL';
    const MIN_CONFIDENCE = 0.7;

    // Must change sign — one negative and one positive (or vice versa)
    const signChanged =
      (fromSentiment < 0 && toSentiment > 0) ||
      (fromSentiment > 0 && toSentiment < 0);

    if (!signChanged || confidence <= MIN_CONFIDENCE) {
      this.logger.debug(
        { assetId, fromSentiment, toSentiment, confidence },
        'AlertEngine: sentiment reversal conditions not met — no alert',
      );
      return;
    }

    if (await this.isInCooldown(assetId, alertType)) {
      this.logger.info(
        { assetId, alertType },
        'AlertEngine: per-asset cooldown active — skipping sentiment reversal alert',
      );
      return;
    }

    const direction = toSentiment > 0 ? 'NEGATIVE → POSITIVE' : 'POSITIVE → NEGATIVE';
    const description = truncateDescription(
      `Sentiment reversal detected for asset ${assetId}: ${direction}. ` +
        `From: ${fromSentiment.toFixed(4)}, To: ${toSentiment.toFixed(4)}, ` +
        `Confidence: ${confidence.toFixed(4)} (min required: ${MIN_CONFIDENCE}).`,
    );

    const payload: AlertPayload = {
      alertType,
      triggerReason: `sentiment sign change (${fromSentiment.toFixed(4)} → ${toSentiment.toFixed(4)}) with confidence ${confidence.toFixed(4)}`,
      assetId,
      importanceScore: Math.min(1.0, confidence),
      description,
      computedAt: new Date(),
    };

    await this.persistAndDeliver(payload);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns true if there is already an alert of the same type for the same
   * asset within the current cooldown window.
   *
   * Requirements: Req 24.2
   */
  private async isInCooldown(assetId: string, alertType: AlertType): Promise<boolean> {
    const cooldownStart = new Date(
      Date.now() - clampCooldown(this.config.cooldownMinutes) * 60 * 1000,
    );

    const existing = await prisma.newsAlert.findFirst({
      where: {
        assetId,
        alertType,
        computedAt: { gt: cooldownStart },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  /**
   * Returns true if an alert for the same cluster + alertType already exists
   * within the current cooldown window.
   *
   * Requirements: Req 24.3
   */
  private async isClusterDeduplicated(
    clusterId: string,
    alertType: AlertType,
  ): Promise<boolean> {
    const cooldownStart = new Date(
      Date.now() - clampCooldown(this.config.cooldownMinutes) * 60 * 1000,
    );

    const existing = await prisma.newsAlert.findFirst({
      where: {
        clusterId,
        alertType,
        computedAt: { gt: cooldownStart },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  /**
   * Persists the alert to the database (with up to 3 retries at 1 s, Req 24.5)
   * and delivers it to the configured webhook (Req 24.4).
   */
  private async persistAndDeliver(payload: AlertPayload): Promise<void> {
    const alertId = uuidv4();

    // 1. Determine delivery status before persisting so we can record it
    let deliveryStatus: DeliveryStatus = 'pending';
    if (this.config.webhookUrl) {
      deliveryStatus = await this.deliverToWebhook(payload, this.config.webhookUrl);
    } else {
      // No webhook configured — mark as delivered (internal delivery handled
      // downstream by event-bus consumers reading news_alerts)
      deliveryStatus = 'delivered';
    }

    const deliveryChannels = {
      webhook: this.config.webhookUrl
        ? { url: this.config.webhookUrl, deliveryStatus }
        : undefined,
      internal: { deliveryStatus: 'delivered' },
    };

    // 2. Persist to news_alerts with up to 3 retries at 1 s (Req 24.5)
    const MAX_PERSIST_RETRIES = 3;
    const PERSIST_RETRY_DELAY_MS = 1_000;

    for (let attempt = 1; attempt <= MAX_PERSIST_RETRIES; attempt++) {
      try {
        await prisma.newsAlert.create({
          data: {
            id: alertId,
            alertType: payload.alertType,
            triggerReason: payload.triggerReason,
            assetId: payload.assetId,
            eventId: payload.eventId ?? null,
            clusterId: payload.clusterId ?? null,
            importanceScore: payload.importanceScore,
            description: truncateDescription(payload.description),
            payload: {
              alertType: payload.alertType,
              triggerReason: payload.triggerReason,
              assetId: payload.assetId,
              eventId: payload.eventId,
              clusterId: payload.clusterId,
              importanceScore: payload.importanceScore,
              computedAt: payload.computedAt.toISOString(),
            },
            deliveryChannels,
            computedAt: payload.computedAt,
          },
        });

        this.logger.info(
          {
            alertId,
            alertType: payload.alertType,
            assetId: payload.assetId,
            deliveryStatus,
          },
          'AlertEngine: alert persisted successfully',
        );
        return;
      } catch (err) {
        this.logger.warn(
          { alertId, attempt, err },
          `AlertEngine: persist attempt ${attempt}/${MAX_PERSIST_RETRIES} failed`,
        );
        if (attempt < MAX_PERSIST_RETRIES) {
          await sleep(PERSIST_RETRY_DELAY_MS);
        } else {
          const storageError = new Error(
            `AlertEngine: failed to persist alert after ${MAX_PERSIST_RETRIES} attempts`,
          );
          this.logger.error({ alertId, cause: err }, storageError.message);
          throw storageError;
        }
      }
    }
  }

  /**
   * POST the alert payload to a webhook URL.
   * Retries up to 3 times with a 5-second delay between attempts (Req 24.4).
   * Returns 'delivered' on success or 'failed' after all retries are exhausted.
   */
  private async deliverToWebhook(
    payload: AlertPayload,
    webhookUrl: string,
  ): Promise<DeliveryStatus> {
    const MAX_DELIVERY_RETRIES = 3;
    const DELIVERY_RETRY_DELAY_MS = 5_000;

    for (let attempt = 1; attempt <= MAX_DELIVERY_RETRIES; attempt++) {
      try {
        await axios.post(
          webhookUrl,
          {
            alertType: payload.alertType,
            triggerReason: payload.triggerReason,
            assetId: payload.assetId,
            eventId: payload.eventId,
            clusterId: payload.clusterId,
            importanceScore: payload.importanceScore,
            description: payload.description,
            computedAt: payload.computedAt.toISOString(),
          },
          {
            timeout: 10_000, // 10 s per attempt
            headers: { 'Content-Type': 'application/json' },
          },
        );

        this.logger.info(
          { webhookUrl, alertType: payload.alertType, assetId: payload.assetId },
          'AlertEngine: webhook delivery succeeded',
        );
        return 'delivered';
      } catch (err) {
        this.logger.warn(
          { webhookUrl, attempt, alertType: payload.alertType, err },
          `AlertEngine: webhook delivery attempt ${attempt}/${MAX_DELIVERY_RETRIES} failed`,
        );
        if (attempt < MAX_DELIVERY_RETRIES) {
          await sleep(DELIVERY_RETRY_DELAY_MS);
        }
      }
    }

    this.logger.error(
      { webhookUrl, alertType: payload.alertType, assetId: payload.assetId },
      `AlertEngine: webhook delivery failed after ${MAX_DELIVERY_RETRIES} attempts — recording as failed`,
    );
    return 'failed';
  }
}
