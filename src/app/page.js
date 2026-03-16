"use client";

import { useMemo, useState } from "react";

const SCOPE_OPTIONS = [
  { value: "single", label: "Single" },
  { value: "bulk",   label: "Bulk"   }
];

const FILTERS = [
  { key: null,             label: "All",          dot: "all"  },
  { key: "valid",          label: "Deliverable",  dot: "ok"   },
  { key: "inconclusive",   label: "Inconclusive", dot: "warn" },
  { key: "invalidMailbox", label: "Invalid",      dot: "bad"  },
  { key: "syntaxInvalid",  label: "Syntax Error", dot: "muted"},
];

const MAX_BULK_EMAILS = 500;

function isMultiEmail(value) {
  return (
    value.includes("\n") ||
    value.includes(",") ||
    value.includes(";") ||
    (value.match(/@/g) || []).length > 1
  );
}

export default function HomePage() {
  const [mode, setMode]               = useState("single");
  const [singleEmail, setSingleEmail] = useState("");
  const [bulkEmails, setBulkEmails]   = useState("");
  const [loading, setLoading]         = useState(false);
  const [results, setResults]         = useState([]);
  const [meta, setMeta]               = useState(null);
  const [error, setError]             = useState("");
  const [activeFilter, setActiveFilter] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const emailInput = useMemo(
    () => (mode === "single" ? singleEmail : bulkEmails),
    [mode, singleEmail, bulkEmails]
  );
  const parsedCount = emailInput.split(/[\n,;\s]+/).filter(Boolean).length;

  // Auto-switch single → bulk when multiple emails are typed/pasted
  const onSingleChange = (e) => {
    const val = e.target.value;
    if (isMultiEmail(val)) {
      setBulkEmails(val);
      setSingleEmail("");
      setMode("bulk");
    } else {
      setSingleEmail(val);
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();

    const trimmedSingle = singleEmail.trim();
    if (mode === "single" && !trimmedSingle) {
      setError("Please enter an email address.");
      return;
    }
    if (mode === "bulk" && parsedCount === 0) {
      setError("Please enter at least one email address.");
      return;
    }
    if (mode === "bulk" && parsedCount > MAX_BULK_EMAILS) {
      setError(`Too many emails. Maximum allowed is ${MAX_BULK_EMAILS}, you entered ${parsedCount}.`);
      return;
    }

    setLoading(true);
    setError("");
    setResults([]);
    setMeta(null);
    setActiveFilter(null);
    setSearchQuery("");

    const payload = { emails: mode === "single" ? [trimmedSingle] : bulkEmails };

    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) { setError(data?.error || "Verification failed"); return; }
      setResults(data.results || []);
      setMeta(data.meta || null);
    } catch {
      setError("Failed to reach verification API");
    } finally {
      setLoading(false);
    }
  };

  const groupedResults = useMemo(() => {
    const g = { valid: [], invalidMailbox: [], inconclusive: [], syntaxInvalid: [] };
    for (const r of results) {
      if (r.syntaxValid === false)             g.syntaxInvalid.push(r);
      else if (r.smtpCheck?.success === true)  g.valid.push(r);
      else if (r.smtpCheck?.success === false) g.invalidMailbox.push(r);
      else                                     g.inconclusive.push(r);
    }
    return g;
  }, [results]);

  const allOrdered = useMemo(() => [
    ...groupedResults.valid,
    ...groupedResults.inconclusive,
    ...groupedResults.invalidMailbox,
    ...groupedResults.syntaxInvalid
  ], [groupedResults]);

  const filteredByCategory = useMemo(() =>
    activeFilter ? groupedResults[activeFilter] : allOrdered,
    [activeFilter, groupedResults, allOrdered]
  );

  const visibleResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return filteredByCategory;
    return filteredByCategory.filter(r =>
      r.email.toLowerCase().includes(q) ||
      (r.domain || "").toLowerCase().includes(q)
    );
  }, [filteredByCategory, searchQuery]);

  const verdictClass = (r) => {
    if (r.syntaxValid && r.smtpCheck?.success === true) return "ok";
    if (!r.syntaxValid || r.smtpCheck?.success === false) return "bad";
    return "warn";
  };

  const toggleFilter = (key) => {
    setSearchQuery("");
    setActiveFilter(prev => prev === key ? null : key);
  };
  const filterCount = (key) => key ? groupedResults[key].length : allOrdered.length;

  const hasResults = allOrdered.length > 0;

  return (
    <>
      <nav className="topnav">
        <div className="topnav-icon">✉</div>
        <span className="topnav-title">Email Verify Studio</span>
        <span className="topnav-sub">— syntax, MX &amp; SMTP checks</span>
      </nav>

      <div className={`page ${hasResults ? "page-with-results" : ""}`}>

        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div>
            <p className="sidebar-title">Verify Emails</p>
            <p className="sidebar-desc">
              Check syntax, MX records, and SMTP reachability for one address or an entire list.
            </p>
          </div>

          <div className="segment" aria-label="Verification mode">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`segment-button ${mode === opt.value ? "segment-button-active" : ""}`}
                onClick={() => { setMode(opt.value); setResults([]); setMeta(null); setError(""); setActiveFilter(null); setSearchQuery(""); }}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="form-grid">
            {mode === "single" ? (
              <input
                className="input"
                value={singleEmail}
                onChange={onSingleChange}
                placeholder="name@example.com"
                type="text"
                autoComplete="email"
                maxLength={254}
                spellCheck={false}
              />
            ) : (
              <textarea
                className="textarea"
                value={bulkEmails}
                onChange={(e) => setBulkEmails(e.target.value)}
                placeholder={"alice@example.com\nbob@example.org\ncharlie@example.net"}
                rows={8}
                spellCheck={false}
              />
            )}

            <p className="hint">
              {mode === "single"
                ? "Paste multiple emails and we'll switch to bulk mode automatically."
                : `One per line, or separated by commas, semicolons, or spaces. Max ${MAX_BULK_EMAILS} emails.`}
            </p>

            {mode === "bulk" && parsedCount > MAX_BULK_EMAILS && (
              <p className="error">
                Too many emails ({parsedCount}). Please reduce to {MAX_BULK_EMAILS} or fewer.
              </p>
            )}

            <button
              className={`submit ${loading ? "is-busy" : ""}`}
              type="submit"
              disabled={loading || (mode === "single" ? !singleEmail.trim() : parsedCount === 0)}
            >
              {loading
                ? "Checking…"
                : mode === "single"
                  ? "Check Email"
                  : `Check ${parsedCount > 0 ? parsedCount : ""} Email${parsedCount !== 1 ? "s" : ""}`}
            </button>
          </form>

          {error ? <p className="error">{error}</p> : null}

          {/* Sidebar filter shortcuts — after a check */}
          {hasResults && (
            <div className="sidebar-results-summary">
              <p className="sidebar-results-label">Last check</p>
              {FILTERS.filter(f => f.key !== null).map(f => (
                <button
                  key={f.key}
                  className={`sidebar-filter-row ${activeFilter === f.key ? "active" : ""}`}
                  onClick={() => toggleFilter(f.key)}
                  type="button"
                >
                  <span className={`summary-dot ${f.dot}`} />
                  <span className="sidebar-filter-name">{f.label}</span>
                  <span className="sidebar-filter-count">{filterCount(f.key)}</span>
                </button>
              ))}
            </div>
          )}

          <p className="muted">
            {mode === "single"
              ? singleEmail || "No email entered"
              : `${parsedCount} parsed entr${parsedCount === 1 ? "y" : "ies"}`}
          </p>
        </aside>

        {/* ── Main content ── */}
        <main className="content">

          {/* Batch meta panel */}
          {meta && (
            <section className="meta-panel">
              <h3>Batch Summary</h3>
              <div className="stat-grid">
                <button
                  className={`stat-item stat-item-btn ${activeFilter === null ? "active" : ""}`}
                  onClick={() => { setActiveFilter(null); setSearchQuery(""); }}
                  type="button"
                >
                  <div className="stat-value">{allOrdered.length}</div>
                  <div className="stat-label">All results</div>
                </button>
                <button
                  className={`stat-item stat-item-btn ${activeFilter === "valid" ? "active ok" : ""}`}
                  onClick={() => toggleFilter("valid")}
                  type="button"
                >
                  <div className="stat-value">{groupedResults.valid.length}</div>
                  <div className="stat-label">Deliverable</div>
                </button>
                <button
                  className={`stat-item stat-item-btn ${activeFilter === "inconclusive" ? "active warn" : ""}`}
                  onClick={() => toggleFilter("inconclusive")}
                  type="button"
                >
                  <div className="stat-value">{groupedResults.inconclusive.length}</div>
                  <div className="stat-label">Inconclusive</div>
                </button>
                <button
                  className={`stat-item stat-item-btn ${activeFilter === "invalidMailbox" ? "active bad" : ""}`}
                  onClick={() => toggleFilter("invalidMailbox")}
                  type="button"
                >
                  <div className="stat-value">{groupedResults.invalidMailbox.length}</div>
                  <div className="stat-label">Invalid mailbox</div>
                </button>
              </div>

              {(meta.duplicates > 0 || meta.invalidSyntax > 0) && (
                <div className="batch-note">
                  {meta.duplicates > 0 && (
                    <span>{meta.duplicates} duplicate{meta.duplicates !== 1 ? "s" : ""} removed</span>
                  )}
                  {meta.invalidSyntax > 0 && (
                    <button className="batch-note-link" onClick={() => toggleFilter("syntaxInvalid")} type="button">
                      {meta.invalidSyntax} syntax error{meta.invalidSyntax !== 1 ? "s" : ""}
                    </button>
                  )}
                </div>
              )}

              {!!meta.topDomains?.length && (
                <div className="meta-grid">
                  <div className="meta-section">
                    <p className="meta-section-title">Top Domains</p>
                    <ul className="meta-rows">
                      {meta.topDomains.map((item) => (
                        <li key={item.domain} className="meta-row">
                          <span className="meta-row-name">{item.domain}</span>
                          <span className="meta-row-count">{item.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="meta-section">
                    <p className="meta-section-title">Patterns</p>
                    <ul className="meta-rows">
                      {Object.entries(meta.patterns || {})
                        .sort((a, b) => b[1] - a[1])
                        .map(([name, count]) => (
                          <li key={name} className="meta-row">
                            <span className="meta-row-name">{name.replace(/-/g, " ")}</span>
                            <span className="meta-row-count">{count}</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Toolbar: filter tabs + search — shown when results exist */}
          {hasResults && (
            <div className="results-toolbar">
              <div className="search-wrap">
                <div className="search-inner">
                  <svg className="search-icon" width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2"/>
                    <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <input
                    className="search-input"
                    type="text"
                    placeholder="Search email or domain…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button className="search-clear" onClick={() => setSearchQuery("")} type="button" aria-label="Clear search">
                      ×
                    </button>
                  )}
                </div>
              </div>

              <div className="filter-tabs">
                {FILTERS.map(f => (
                  <button
                    key={String(f.key)}
                    className={`filter-tab ${activeFilter === f.key ? "active" : ""} ${f.dot}`}
                    onClick={() => f.key === null ? (setActiveFilter(null), setSearchQuery("")) : toggleFilter(f.key)}
                    type="button"
                  >
                    <span className={`summary-dot ${f.dot}`} />
                    {f.label}
                    <span className="filter-tab-count">{filterCount(f.key)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Results grid */}
          {hasResults ? (
            visibleResults.length > 0 ? (
              <div className="results" aria-live="polite">
                {visibleResults.map((result) => (
                  <article key={result.email} className={`result ${verdictClass(result)}`}>
                    <header className="result-header">
                      <h2>{result.email}</h2>
                      <span className={`badge ${verdictClass(result)}`}>{result.verdict}</span>
                    </header>

                    <dl className="meta">
                      <div><dt>Syntax</dt><dd>{result.syntaxValid ? "Valid" : "Invalid"}</dd></div>
                      <div><dt>Domain</dt><dd>{result.domain || "—"}</dd></div>
                      <div><dt>MX Record</dt><dd>{result.hasMx ? "Found" : "Missing"}</dd></div>
                      <div><dt>SMTP Host</dt><dd>{result.mxHosts?.[0] || "—"}</dd></div>
                      <div><dt>Pattern</dt><dd>{result.pattern ? result.pattern.replace(/-/g, " ") : "—"}</dd></div>
                      <div><dt>SMTP Stage</dt><dd>{result.smtpCheck?.stage || "—"}</dd></div>
                      <div><dt>SMTP Status</dt><dd>{result.smtpCheck?.code ? String(result.smtpCheck.code) : "—"}</dd></div>
                    </dl>

                    <p className="detail">{result.smtpCheck?.message || result.verdict}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">🔍</div>
                <p>{searchQuery ? `No results for "${searchQuery}"` : "No emails in this category"}</p>
                <button
                  className="clear-filter"
                  onClick={() => { setActiveFilter(null); setSearchQuery(""); }}
                  type="button"
                >
                  Clear filters
                </button>
              </div>
            )
          ) : (
            <div className="empty-state">
              <div className="empty-icon">✉</div>
              <p>Results will appear here</p>
              <p className="empty-sub">Enter an email and hit Check</p>
            </div>
          )}

        </main>
      </div>
    </>
  );
}
