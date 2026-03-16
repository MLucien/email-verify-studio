import validator from "email-validator";
import dns from "node:dns/promises";
import net from "node:net";
import { setTimeout as wait } from "node:timers/promises";

const SMTP_TIMEOUT_MS = 10_000;

const SMTP_ERROR_CODES = new Set([550, 551, 553]);
const SMTP_INCONCLUSIVE_CODES = new Set([450, 451, 452, 421]);

const SMTP_RESPONSE = {
  250: "Mailbox exists and accepted",
  251: "Mailbox exists (alias or forwarding accepted)",
  550: "Mailbox likely does not exist",
  551: "Mailbox likely does not exist (wrong mailbox)",
  553: "Mailbox likely rejected due to address mismatch",
  450: "Mailbox temporary unavailable",
  451: "Server error while verifying recipient",
  452: "Insufficient resources",
  421: "Server unavailable"
};

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function extractDomain(email) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return null;
  return email.slice(atIndex + 1).toLowerCase();
}

export function parsePatternTag(email) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) {
    return "unparsed";
  }

  const localPart = email.slice(0, atIndex);

  if (localPart.includes("+")) return "plus-alias";
  if (localPart.includes(".")) return "dot-local";
  if (/\d/.test(localPart)) return "contains-digit";
  if (/[_-]/.test(localPart)) return "has-separator";
  return "standard";
}

export function splitEmails(input) {
  if (!input) return [];

  const source = Array.isArray(input)
    ? input.join("\n")
    : String(input);

  return source
    .split(/[\n,;\s]+/)
    .map((value) => normalizeEmail(value))
    .filter(Boolean);
}

export function normalizeBatch(rawEmails) {
  const entries = splitEmails(rawEmails);
  const deduped = [];
  const seen = new Set();

  const buckets = {
    total: entries.length,
    validSyntax: 0,
    invalidSyntax: [],
    duplicates: [],
    domains: new Map(),
    patterns: {}
  };

  for (const email of entries) {
    const valid = validateSyntax(email);
    if (!valid) {
      buckets.invalidSyntax.push(email);
      continue;
    }

    if (seen.has(email)) {
      buckets.duplicates.push(email);
      continue;
    }

    seen.add(email);
    deduped.push(email);
    buckets.validSyntax += 1;

    const domain = extractDomain(email) || "unknown-domain";
    buckets.domains.set(domain, (buckets.domains.get(domain) || 0) + 1);

    const pattern = parsePatternTag(email);
    buckets.patterns[pattern] = (buckets.patterns[pattern] || 0) + 1;
  }

  const topDomains = [...buckets.domains.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([domain, count]) => ({ domain, count }));

  return {
    total: buckets.total,
    deduplicated: deduped.length,
    duplicateCount: buckets.duplicates.length,
    invalidSyntaxCount: buckets.invalidSyntax.length,
    items: deduped,
    invalidSyntax: buckets.invalidSyntax,
    duplicates: buckets.duplicates,
    topDomains,
    patterns: buckets.patterns
  };
}

export function validateSyntax(email) {
  return validator.validate(email);
}

export async function checkMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    const sorted = records.sort((a, b) => a.priority - b.priority);
    return {
      hasMx: sorted.length > 0,
      records: sorted.map((record) => ({
        exchange: record.exchange.toLowerCase(),
        priority: record.priority
      }))
    };
  } catch (error) {
    return { hasMx: false, records: [], error: error.message };
  }
}

export function smtpVerify(mxHost, testEmail, fromEmail = "probe@example.com", timeoutMs = SMTP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25, allowHalfOpen: true });
    let resolved = false;
    let activeBuffer = "";

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.end();
      } catch {
        socket.destroy();
      }
      resolve(result);
    };

    const finalize = async (result) => {
      await wait(100).catch(() => {});
      finish(result);
    };

    const send = (command) => {
      if (resolved) return;
      socket.write(`${command}\r\n`);
    };

    let stage = "GREETING";

    socket.setTimeout(timeoutMs);

    socket.on("data", (chunk) => {
      activeBuffer += chunk;
      const split = activeBuffer.replace(/\r\n/g, "\n").split("\n");
      const completeLines = split.slice(0, -1);
      activeBuffer = split.slice(-1)[0];

      const lines = completeLines
        .map((line) => {
          const match = line.match(/^(\d{3})([ -])(.*)$/);
          if (!match) return null;
          return {
            code: Number.parseInt(match[1], 10),
            completed: match[2] === " ",
            message: match[3] ?? ""
          };
        })
        .filter(Boolean);

      if (!lines.length) return;

      const relevant = lines.at(-1);
      if (!relevant) return;
      const { code, message, completed } = relevant;
      if (!completed) return;

      if (stage === "GREETING" && code === 220) {
        send(`HELO verifier.local`);
        stage = "HELO";
        return;
      }

      if (stage === "HELO" && code === 250) {
        send(`MAIL FROM:<${fromEmail}>`);
        stage = "MAIL";
        return;
      }

      if (stage === "MAIL" && code === 250) {
        send(`RCPT TO:<${testEmail}>`);
        stage = "RCPT";
        return;
      }

      if (stage === "RCPT") {
        if (code === 250 || code === 251) {
          finalize({
            success: true,
            stage: "RCPT",
            code,
            message: SMTP_RESPONSE[code] || message
          });
          return;
        }

        if (SMTP_ERROR_CODES.has(code)) {
          finalize({
            success: false,
            stage: "RCPT",
            code,
            message: SMTP_RESPONSE[code] || message
          });
          return;
        }

        if (SMTP_INCONCLUSIVE_CODES.has(code)) {
          finalize({
            success: null,
            stage: "RCPT",
            code,
            message: SMTP_RESPONSE[code] || message
          });
          return;
        }

        finalize({
          success: null,
          stage: "RCPT",
          code,
          message: `SMTP returned ${code}: ${message || "Unknown response"}`
        });
      }
    });

    socket.on("timeout", () => {
      finish({
        success: null,
        stage: "TIMEOUT",
        code: null,
        message: "SMTP connection timed out"
      });
    });

    socket.on("error", (error) => {
      if (!resolved) {
        finish({
          success: null,
          stage: "ERROR",
          code: null,
          message: `SMTP connection failed: ${error.message}`
        });
      }
    });

    socket.on("close", () => {
      if (!resolved) {
        finish({
          success: null,
          stage: "CLOSED",
          code: null,
          message: "SMTP connection closed before verification finished"
        });
      }
    });
  });
}

export async function verifyEmail(email) {
  const normalized = normalizeEmail(email);

  if (!normalized) {
    return {
      email: email?.toString?.() ?? "",
      syntaxValid: false,
      domain: null,
      hasMx: false,
      mxHosts: [],
      smtpCheck: null,
      verdict: "No email provided",
      pattern: "empty"
    };
  }

  if (!validateSyntax(normalized)) {
    return {
      email: normalized,
      syntaxValid: false,
      domain: null,
      hasMx: false,
      mxHosts: [],
      smtpCheck: null,
      verdict: "Invalid email format",
      pattern: parsePatternTag(normalized) || "invalid-format"
    };
  }

  const domain = extractDomain(normalized);

  if (!domain) {
    return {
      email: normalized,
      syntaxValid: false,
      domain: null,
      hasMx: false,
      mxHosts: [],
      smtpCheck: null,
      verdict: "Unable to extract domain",
      pattern: parsePatternTag(normalized)
    };
  }

  const mxResult = await checkMx(domain);

  if (!mxResult.hasMx) {
    return {
      email: normalized,
      syntaxValid: true,
      domain,
      hasMx: false,
      mxHosts: [],
      smtpCheck: null,
      verdict: "Domain has no MX records",
      pattern: parsePatternTag(normalized)
    };
  }

  let smtpCheck = null;

  try {
    const primaryMx = mxResult.records[0].exchange;
    smtpCheck = await smtpVerify(primaryMx, normalized);
  } catch (error) {
    smtpCheck = {
      success: null,
      stage: "EXCEPTION",
      code: null,
      message: `SMTP verification failed: ${error.message}`
    };
  }

  let verdict = "Likely deliverable";

  if (smtpCheck?.success === true) {
    verdict = "Likely deliverable";
  } else if (smtpCheck?.success === false) {
    verdict = "Mailbox likely unavailable";
  } else if (smtpCheck?.success == null) {
    verdict = `Inconclusive: ${smtpCheck?.message ?? "SMTP verification returned no definitive result"}`;
  }

  return {
    email: normalized,
    syntaxValid: true,
    domain,
    hasMx: true,
    mxHosts: mxResult.records.map((record) => record.exchange),
    pattern: parsePatternTag(normalized),
    smtpCheck,
    verdict
  };
}

export async function verifyEmails(rawEmails, options = {}) {
  const batch = typeof rawEmails === "object" && !Array.isArray(rawEmails) && rawEmails?.items
    ? rawEmails
    : { items: splitEmails(rawEmails) };
  const list = batch.items || [];
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 3));

  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      const email = list[index];
      results[index] = await verifyEmail(email);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return results;
}

export function buildSummary(results) {
  const summary = {
    total: results.length,
    syntacticallyValid: 0,
    withMx: 0,
    deliverable: 0,
    invalidMailbox: 0,
    inconclusive: 0,
    syntaxInvalid: 0
  };

  for (const result of results) {
    if (!result.syntaxValid) {
      summary.syntaxInvalid += 1;
      continue;
    }

    summary.syntacticallyValid += 1;
    if (result.hasMx) summary.withMx += 1;
    if (result.smtpCheck?.success === true) summary.deliverable += 1;
    else if (result.smtpCheck?.success === false) summary.invalidMailbox += 1;
    else summary.inconclusive += 1;
  }

  return summary;
}

async function main() {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error("Usage: node verify-email.js someone@example.com or comma-separated/list of emails");
    process.exit(1);
  }

  const emails = splitEmails(input);
  const batch = normalizeBatch(emails);
  const results = await verifyEmails(batch, { concurrency: 2 });
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv[1]?.endsWith("verify-email.js")) {
  main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
}
