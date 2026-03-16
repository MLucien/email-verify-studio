import { NextResponse } from 'next/server';
import { buildSummary, normalizeBatch, verifyEmails } from '../../../../verify-email.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 500;

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => null);

    if (!payload || typeof payload !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body.' },
        { status: 400 }
      );
    }

    const raw = payload?.emails;
    if (!raw || (typeof raw !== 'string' && !Array.isArray(raw))) {
      return NextResponse.json(
        { error: 'Please provide emails as a string or array.' },
        { status: 400 }
      );
    }

    const concurrency = Number(payload?.concurrency);
    const batch = normalizeBatch(raw);

    if (batch.total > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Too many emails. Maximum allowed is ${MAX_BATCH_SIZE}, received ${batch.total}.` },
        { status: 422 }
      );
    }

    if (batch.items.length === 0) {
      return NextResponse.json(
        {
          error: 'No valid emails found in input.',
          meta: {
            received: batch.total,
            valid: batch.deduplicated,
            duplicates: batch.duplicateCount,
            invalidSyntax: batch.invalidSyntaxCount,
            topDomains: batch.topDomains,
            patterns: batch.patterns
          }
        },
        { status: 400 }
      );
    }

    const verifiedResults = await verifyEmails(batch.items, {
      concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 3
    });
    const invalidResults = batch.invalidSyntax.map((email) => ({
      email,
      syntaxValid: false,
      domain: null,
      hasMx: false,
      mxHosts: [],
      smtpCheck: null,
      verdict: "Invalid email format",
      pattern: "invalid-format"
    }));
    const results = [...invalidResults, ...verifiedResults];
    const summary = buildSummary(results);

    return NextResponse.json({
      meta: {
        received: batch.total,
        valid: batch.deduplicated,
        duplicates: batch.duplicateCount,
        invalidSyntax: batch.invalidSyntaxCount,
        invalidItems: batch.invalidSyntax,
        duplicatesItems: batch.duplicates,
        topDomains: batch.topDomains,
        patterns: batch.patterns
      },
      summary,
      total: results.length,
      results
    });
  } catch (error) {
    console.error('[verify] Unexpected error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
