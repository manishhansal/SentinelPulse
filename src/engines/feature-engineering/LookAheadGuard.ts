/**
 * LookAheadGuard — enforces point-in-time correctness in feature engineering.
 *
 * Every data source used in a FeatureVector computation must have a
 * recordTimestamp <= event_timestamp. Any violation throws a LookAheadBiasError
 * and aborts computation without persisting the FeatureVector (Req 20.2, Req 21.1).
 *
 * Requirements: Req 20.2, Req 21.1, Req 21.2
 */

export class LookAheadBiasError extends Error {
  constructor(
    public readonly offendingFeature: string,
    public readonly recordTimestamp: Date,
    public readonly eventTimestamp: Date,
  ) {
    super(
      `Look-ahead bias detected: feature "${offendingFeature}" has recordTimestamp ` +
      `${recordTimestamp.toISOString()} which is after eventTimestamp ${eventTimestamp.toISOString()}.`,
    );
    this.name = 'LookAheadBiasError';
  }
}

export interface DataPoint {
  /** Human-readable name of the feature/data source for error reporting */
  featureName: string;
  /** The timestamp of the record that was used */
  recordTimestamp: Date;
}

export class LookAheadGuard {
  /**
   * Validates that all provided data points have recordTimestamp <= eventTimestamp.
   * Throws LookAheadBiasError on the FIRST violation found.
   *
   * @param dataPoints - Array of data points used in feature computation
   * @param eventTimestamp - The event's timestamp (the anchor point in time)
   * @throws LookAheadBiasError if any data point violates the constraint
   *
   * Requirements: Req 20.2, Req 21.1
   */
  validate(dataPoints: DataPoint[], eventTimestamp: Date): void {
    for (const dp of dataPoints) {
      if (dp.recordTimestamp > eventTimestamp) {
        throw new LookAheadBiasError(dp.featureName, dp.recordTimestamp, eventTimestamp);
      }
    }
  }

  /**
   * Validates a single data point.
   * Convenience method for validating one feature at a time.
   */
  validateOne(featureName: string, recordTimestamp: Date, eventTimestamp: Date): void {
    if (recordTimestamp > eventTimestamp) {
      throw new LookAheadBiasError(featureName, recordTimestamp, eventTimestamp);
    }
  }

  /**
   * Creates a DataPoint object for use with validate().
   */
  static point(featureName: string, recordTimestamp: Date): DataPoint {
    return { featureName, recordTimestamp };
  }
}
